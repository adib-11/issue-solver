import { join } from "node:path";
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import type { Clock } from "./clock";
import type { Config } from "./config";
import { openDb } from "./db";
import type { GitHub, Issue, Repo } from "./github";
import type { AuthCheckState, Harness, SetupView } from "./harness";
import { JOB_STATES, type Job, UNTRUSTED_AUTHOR } from "./jobs";

const PAGE_SIZE = 50;
const SCAN_INTERVAL_MS = 60_000;
const CURSOR_OVERLAP_MS = 60_000;
const DIST = join(import.meta.dir, "../dist");
const TRUSTED_AUTHORS = ["OWNER", "COLLABORATOR"];
const STATIC_FILES: Record<string, string> = { "/": "index.html", "/app.js": "app.js", "/app.css": "app.css" };

type ScannedRepo = { repo: Repo; issues: Issue[] };
const FILTER_REASONS = ["closed", "assigned", "open closing PR", "referenced by open PR"] as const;

/** The skill bundle's candidate filter (skills/solve-issue/scripts/candidates.jq): work already in flight. */
function candidateSkipReason(issue: Issue): (typeof FILTER_REASONS)[number] | null {
  const open = (pr?: { state?: string }) => pr?.state === "OPEN";
  if (issue.assignees.totalCount > 0) return "assigned";
  if (issue.closedByPullRequestsReferences.nodes.some(open)) return "open closing PR";
  if (issue.timelineItems.nodes.some((e) => !e.isCrossRepository && open(e.source))) return "referenced by open PR";
  return null;
}

const PAUSE_REASONS: Partial<Record<AuthCheckState, string>> = {
  auth: "Harness auth failed: log in again as the setup page shows, then click Test auth.",
  quota: "Harness quota exhausted: wait for it to reset, then click Test auth.",
};

export function createApp(deps: { config: Config; github: GitHub; clock: Clock; harnesses: Harness[] }) {
  const { config, github, clock, harnesses } = deps;
  const db = openDb(config.dbPath);
  const iso = (ms: number) => new Date(ms).toISOString();

  const getCursor = db.query<{ scanned_at: string }, [number]>("SELECT scanned_at FROM scan_cursors WHERE repo_id = ?");
  const setCursor = db.query(
    "INSERT INTO scan_cursors (repo_id, scanned_at) VALUES (?, ?) ON CONFLICT (repo_id) DO UPDATE SET scanned_at = excluded.scanned_at",
  );
  const insertJob = db.query(`INSERT INTO jobs
    (repo_id, repo_full_name, issue_number, issue_title, issue_url, state, skip_reason, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (repo_id, issue_number) DO NOTHING`);
  // Filter skips follow the issue on every scan; untrusted-author skips wait for Run anyway.
  const filterSkipped = `state = 'skipped' AND skip_reason IN (${FILTER_REASONS.map((r) => `'${r}'`).join(", ")})`;
  const skipJob = db.query(`UPDATE jobs SET state = 'skipped', skip_reason = ?1, updated_at = ?2
    WHERE repo_id = ?3 AND issue_number = ?4 AND (state = 'queued' OR (${filterSkipped} AND skip_reason <> ?1))`);
  const liftSkip = db.query(`UPDATE jobs SET state = ?1, skip_reason = ?2, updated_at = ?3
    WHERE repo_id = ?4 AND issue_number = ?5 AND ${filterSkipped}`);
  const getJob = db.query<Job, [number]>("SELECT * FROM jobs WHERE id = ?");

  const getSettingQuery = db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?");
  const getSetting = <T>(key: string): T | null => {
    const row = getSettingQuery.get(key);
    return row ? JSON.parse(row.value) : null;
  };
  const setSettingQuery = db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
  const setSetting = (key: string, value: unknown) => setSettingQuery.run(key, JSON.stringify(value));
  const deleteSettingQuery = db.query("DELETE FROM settings WHERE key = ?");
  const deleteSetting = (key: string) => deleteSettingQuery.run(key);

  // Tracks when each harness credential was first seen, by hash, so the setup page can show its age.
  for (const harness of harnesses) {
    if (!harness.credential) continue;
    const hash = new Bun.CryptoHasher("sha256").update(harness.credential).digest("hex");
    if (getSetting<{ hash: string }>(`credential:${harness.name}`)?.hash !== hash) {
      setSetting(`credential:${harness.name}`, { hash, since: iso(clock.now()) });
    }
  }

  /** Records one scan's results: every successfully listed repo, committed together so jobs are numbered oldest issue first. */
  function record(scanned: ScannedRepo[], scanStart: number) {
    const now = iso(clock.now());
    const found = scanned
      .flatMap(({ repo, issues }) => issues.map((issue) => ({ repo, issue })))
      .sort((a, b) => Date.parse(a.issue.createdAt) - Date.parse(b.issue.createdAt));
    db.transaction(() => {
      for (const { repo, issue } of found) {
        const reason = issue.state === "CLOSED" ? "closed" : candidateSkipReason(issue);
        const skip = reason ?? (TRUSTED_AUTHORS.includes(issue.authorAssociation) ? null : UNTRUSTED_AUTHOR);
        const state = skip ? "skipped" : "queued";
        if (reason) skipJob.run(reason, now, repo.id, issue.number);
        else liftSkip.run(state, skip, now, repo.id, issue.number);
        if (issue.state === "CLOSED") continue;
        insertJob.run(repo.id, repo.full_name, issue.number, issue.title, issue.url, state, skip, now, now);
      }
      for (const { repo } of scanned) setCursor.run(repo.id, iso(scanStart));
    })();
  }

  async function scanRepo(installationId: number, repo: Repo): Promise<ScannedRepo> {
    const cursor = getCursor.get(repo.id)?.scanned_at;
    const since = cursor ? iso(Date.parse(cursor) - CURSOR_OVERLAP_MS) : undefined;
    return { repo, issues: await github.listIssues(installationId, repo, since) };
  }

  let scanning = false;
  async function scan() {
    if (scanning) return;
    scanning = true;
    const scanStart = clock.now();
    const scanned: ScannedRepo[] = [];
    try {
      for (const installation of await github.listInstallations()) {
        const { login, type } = installation.account;
        if (type !== "User" || login.toLowerCase() !== config.ownerLogin.toLowerCase()) {
          console.error(`Rejected installation ${installation.id} on ${type} ${login}: not the user account ${config.ownerLogin}`);
          continue;
        }
        let repos: Repo[];
        try {
          repos = await github.listInstallationRepos(installation.id);
        } catch (err) {
          console.error(`Listing repos of installation ${installation.id} failed:`, err);
          continue;
        }
        for (const repo of repos) {
          if (repo.fork || repo.archived) continue;
          try {
            scanned.push(await scanRepo(installation.id, repo));
          } catch (err) {
            console.error(`Scan of ${repo.full_name} failed; cursor not advanced:`, err);
          }
        }
      }
      record(scanned, scanStart);
    } catch (err) {
      console.error("Scan failed:", err);
    } finally {
      scanning = false;
    }
  }

  const http = new Hono();
  http.use(basicAuth({ username: "admin", password: config.adminPassword }));
  http.use(async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.header("origin") !== new URL(c.req.url).origin) {
      return c.json({ error: "Origin does not match" }, 403);
    }
    await next();
  });

  http.get("/api/jobs", (c) => {
    const state = c.req.query("state");
    if (state && !(JOB_STATES as readonly string[]).includes(state)) {
      return c.json({ error: `Unknown state: ${state}` }, 400);
    }
    const page = Math.max(1, Number.parseInt(c.req.query("page") ?? "1") || 1);
    const where = state ? "WHERE state = ?" : "";
    const params = state ? [state] : [];
    const jobs = db
      .query(`SELECT * FROM jobs ${where} ORDER BY id DESC LIMIT ${PAGE_SIZE} OFFSET ?`)
      .all(...params, (page - 1) * PAGE_SIZE);
    const { total } = db.query<{ total: number }, string[]>(`SELECT count(*) AS total FROM jobs ${where}`).get(...params)!;
    return c.json({ jobs, page, pageSize: PAGE_SIZE, total });
  });

  http.get("/api/jobs/:id", (c) => {
    const job = getJob.get(Number(c.req.param("id")));
    return job ? c.json(job) : c.json({ error: "Job not found" }, 404);
  });

  const runAnyway = db.query(`UPDATE jobs SET state = 'queued', skip_reason = NULL, updated_at = ?
    WHERE id = ? AND state = 'skipped' AND skip_reason = ?`);
  http.post("/api/jobs/:id/run-anyway", (c) => {
    const id = Number(c.req.param("id"));
    if (runAnyway.run(iso(clock.now()), id, UNTRUSTED_AUTHOR).changes) return c.json(getJob.get(id), 202);
    if (!getJob.get(id)) return c.json({ error: "Job not found" }, 404);
    return c.json({ error: `Run anyway only applies to jobs skipped as ${UNTRUSTED_AUTHOR}` }, 409);
  });

  function setupView(): SetupView {
    const harness = getSetting<string>("harness");
    return {
      harness,
      harnesses: harnesses.map(({ name, label, loginHelp }) => ({ name, label, loginHelp })),
      auth: getSetting<SetupView["auth"]>("auth"),
      paused: getSetting<string>("paused"),
      credentialSince: harness ? (getSetting<{ since: string }>(`credential:${harness}`)?.since ?? null) : null,
    };
  }

  http.get("/api/setup", (c) => c.json(setupView()));

  http.put("/api/setup", async (c) => {
    const body = await c.req.json().catch(() => null);
    const name = body?.harness;
    if (!harnesses.some((h) => h.name === name)) return c.json({ error: `Unknown harness: ${name}` }, 400);
    if (getSetting("harness") !== name) {
      setSetting("harness", name);
      deleteSetting("auth");
    }
    return c.json(setupView());
  });

  http.post("/api/setup/test-auth", async (c) => {
    const harness = harnesses.find((h) => h.name === getSetting("harness"));
    if (!harness) return c.json({ error: "Choose a harness first" }, 409);
    const { state, log } = await harness.checkAuth();
    setSetting("auth", { state, checkedAt: iso(clock.now()), log });
    const pause = PAUSE_REASONS[state];
    if (state === "ok") deleteSetting("paused");
    else if (pause) setSetting("paused", pause);
    return c.json(setupView());
  });

  http.get("*", (c) => {
    const file = STATIC_FILES[c.req.path];
    return file ? new Response(Bun.file(join(DIST, file))) : c.json({ error: "Not found" }, 404);
  });

  let stopTimer: (() => void) | undefined;
  return {
    fetch: (req: Request) => http.fetch(req),
    scan,
    async start() {
      await scan();
      stopTimer = clock.every(SCAN_INTERVAL_MS, scan);
    },
    stop() {
      stopTimer?.();
      db.close();
    },
  };
}
