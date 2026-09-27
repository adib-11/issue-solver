import { $ } from "bun";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import type { Clock } from "./clock";
import type { Config } from "./config";
import { BRIEF_SCHEMA, BRIEF_TIMEOUT_MS, briefError, briefPrompt, questionsComment } from "./brief";
import { CONVENTIONS_PROMPT, CONVENTIONS_SCHEMA, CONVENTIONS_TIMEOUT_MS, conventionsHash } from "./conventions";
import { openDb } from "./db";
import type { GitHub, Issue, Repo } from "./github";
import { type AuthCheckState, type Harness, type RunError, type RunOptions, schemaError, type SetupView } from "./harness";
import { type Attempt, type Brief, type Conventions, JOB_STATES, type IssueSnapshot, type Job, type JobDetail, NO_CHECKS, type Phase, type RepoView, TRUSTED_AUTHORS, UNTRUSTED_AUTHOR } from "./jobs";
import type { Runner } from "./runner";

const PAGE_SIZE = 50;
const SCAN_INTERVAL_MS = 60_000;
const CURSOR_OVERLAP_MS = 60_000;
const DIST = join(import.meta.dir, "../dist");
const STATIC_FILES: Record<string, string> = { "/": "index.html", "/app.js": "app.js", "/app.css": "app.css" };

type ScannedRepo = { installationId: number; repo: Repo; issues: Issue[] };
type RepoRow = {
  id: number;
  full_name: string;
  installation_id: number;
  conventions: string | null;
  conventions_hash: string | null;
  conventions_at: string | null;
  override: string | null;
};

const LOG_LIMIT_BYTES = 200 * 1024;
const PIPELINE_ENDS = "Pipeline ends here: the phases after brief are not built yet.";
const INTERRUPTED = "Interrupted by a restart";
// GitHub tokens, Claude tokens, and JWTs (Codex's ChatGPT tokens), wherever they come from; configured harness
// credentials are redacted by value too.
const SECRET_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bsk-ant-[A-Za-z0-9_-]+/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
];
const FILTER_REASONS = ["closed", "assigned", "open closing PR", "referenced by open PR"] as const;

/** The skill bundle's candidate filter (skills/solve-issue/scripts/candidates.jq): work already in flight. */
function candidateSkipReason(issue: Issue): (typeof FILTER_REASONS)[number] | null {
  const open = (pr?: { state?: string }) => pr?.state === "OPEN";
  if (issue.assignees.totalCount > 0) return "assigned";
  if (issue.closedByPullRequestsReferences.nodes.some(open)) return "open closing PR";
  if (issue.timelineItems.nodes.some((e) => !e.isCrossRepository && open(e.source))) return "referenced by open PR";
  return null;
}

const PAUSE_REASONS: Partial<Record<AuthCheckState | RunError, string>> = {
  auth: "Harness auth failed: log in again as the setup page shows, then click Test auth.",
  quota: "Harness quota exhausted: wait for it to reset, then click Test auth.",
};

export function createApp(deps: { config: Config; github: GitHub; clock: Clock; harnesses: Harness[]; runner: Runner }) {
  const { config, github, clock, harnesses, runner } = deps;
  const db = openDb(config.dbPath);
  const iso = (ms: number) => new Date(ms).toISOString();
  const now = () => iso(clock.now());

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
  const upsertRepo = db.query(`INSERT INTO repos (id, full_name, installation_id) VALUES (?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET full_name = excluded.full_name, installation_id = excluded.installation_id`);

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
    const at = now();
    const found = scanned
      .flatMap(({ repo, issues }) => issues.map((issue) => ({ repo, issue })))
      .sort((a, b) => Date.parse(a.issue.createdAt) - Date.parse(b.issue.createdAt));
    db.transaction(() => {
      for (const { repo, issue } of found) {
        const reason = issue.state === "CLOSED" ? "closed" : candidateSkipReason(issue);
        const skip = reason ?? (TRUSTED_AUTHORS.includes(issue.authorAssociation) ? null : UNTRUSTED_AUTHOR);
        const state = skip ? "skipped" : "queued";
        if (reason) skipJob.run(reason, at, repo.id, issue.number);
        else liftSkip.run(state, skip, at, repo.id, issue.number);
        if (issue.state === "CLOSED") continue;
        insertJob.run(repo.id, repo.full_name, issue.number, issue.title, issue.url, state, skip, at, at);
      }
      for (const { installationId, repo } of scanned) {
        upsertRepo.run(repo.id, repo.full_name, installationId);
        setCursor.run(repo.id, iso(scanStart));
      }
    })();
  }

  async function scanRepo(installationId: number, repo: Repo): Promise<ScannedRepo> {
    const cursor = getCursor.get(repo.id)?.scanned_at;
    const since = cursor ? iso(Date.parse(cursor) - CURSOR_OVERLAP_MS) : undefined;
    return { installationId, repo, issues: await github.listIssues(installationId, repo, since) };
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

  // Only one attempt runs at a time, so any attempt still unfinished at startup was cut off by a restart.
  db.transaction(() => {
    const at = now();
    db.run("UPDATE phases SET finished_at = ?, outcome = 'interrupted' WHERE finished_at IS NULL", [at]);
    db.run("UPDATE attempts SET finished_at = ?, result = ? WHERE finished_at IS NULL", [at, INTERRUPTED]);
    db.run("UPDATE jobs SET state = 'failed', phase = NULL, updated_at = ? WHERE state = 'running'", [at]);
  })();

  const claimJob = db.query<Job, [string]>(`UPDATE jobs SET state = 'running', phase = 'checkout', updated_at = ?
    WHERE id = (SELECT id FROM jobs WHERE state = 'queued' ORDER BY id LIMIT 1)
      AND NOT EXISTS (SELECT 1 FROM jobs WHERE state = 'running')
    RETURNING *`);
  const insertAttempt = db.query<{ id: number }, [number, string, string]>(
    "INSERT INTO attempts (job_id, harness, started_at) VALUES (?, ?, ?) RETURNING id",
  );
  const setBaseSha = db.query("UPDATE attempts SET base_sha = ? WHERE id = ?");
  const setIssue = db.query("UPDATE attempts SET issue = ? WHERE id = ?");
  const endAttempt = db.query("UPDATE attempts SET finished_at = ?, result = ? WHERE id = ?");
  const endJob = db.query("UPDATE jobs SET state = ?, skip_reason = ?, phase = NULL, updated_at = ? WHERE id = ?");
  const setPhase = db.query("UPDATE jobs SET phase = ?, updated_at = ? WHERE id = ?");
  const startPhase = db.query<{ id: number }, [number, string, string]>(
    "INSERT INTO phases (attempt_id, name, started_at) VALUES (?, ?, ?) RETURNING id",
  );
  const endPhase = db.query("UPDATE phases SET finished_at = ?, outcome = ?, log = ?, output = ? WHERE id = ?");
  const getRepo = db.query<RepoRow, [number]>("SELECT * FROM repos WHERE id = ?");
  const saveConventions = db.query("UPDATE repos SET conventions = ?, conventions_hash = ?, conventions_at = ? WHERE id = ?");
  const parse = <T>(json: string | null): T | null => (json === null ? null : JSON.parse(json));

  function redact(log: string) {
    for (const h of harnesses) if (h.credential) log = log.replaceAll(h.credential, "[redacted]");
    return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, "[redacted]"), log);
  }

  /** Keeps the last 200 KiB. Redact first, so no secret is cut in half and left half-visible. */
  function capLog(log: string) {
    const bytes = Buffer.from(log);
    if (bytes.length <= LOG_LIMIT_BYTES) return log;
    return `[earlier output truncated]\n${bytes.subarray(-LOG_LIMIT_BYTES).toString()}`;
  }

  type Claimed = { job: Job; attemptId: number; harness: Harness; workspace: string };

  function finish({ job, attemptId }: Claimed, state: Job["state"], result: string, skipReason: string | null = null) {
    db.transaction(() => {
      endJob.run(state, skipReason, now(), job.id);
      endAttempt.run(now(), result, attemptId);
    })();
  }

  /** Runs one agent phase; check rejects schema-valid output as bad_output with its reason. */
  async function runPhase(
    { job, attemptId, harness, workspace }: Claimed,
    name: string,
    options: Omit<RunOptions, "workspace" | "wrap">,
    check: (output: unknown) => string | null = () => null,
  ) {
    setPhase.run(name, now(), job.id);
    const phase = startPhase.get(attemptId, name, now())!;
    let result = await harness.run({ ...options, workspace, wrap: runner.command(workspace, harness.name) });
    const invalid = result.ok && check(result.output);
    if (invalid) result = { ok: false, error: "bad_output", log: `${result.log}\nOutput rejected: ${invalid}` };
    const output = result.ok ? JSON.stringify(result.output) : null;
    endPhase.run(now(), result.ok ? "ok" : result.error, capLog(redact(result.log)), output, phase.id);
    return result;
  }

  /** auth and quota pause dispatch and put the job back in the queue; other errors fail the job. */
  function harnessFailed(claimed: Claimed, phase: string, error: RunError) {
    const pause = PAUSE_REASONS[error];
    if (pause) setSetting("paused", pause);
    finish(claimed, pause ? "queued" : "failed", `${phase}: ${error}`);
  }

  async function runAttempt(claimed: Claimed) {
    const { job, attemptId, workspace } = claimed;
    const repo = getRepo.get(job.repo_id);
    if (!repo) return finish(claimed, "failed", "The repo is no longer enabled for the GitHub App.");
    try {
      await github.checkout(repo.installation_id, repo.full_name, workspace);
    } catch (err) {
      return finish(claimed, "failed", `checkout: ${redact((err as Error).message)}`);
    }
    await $`git -C ${workspace} config core.hooksPath /dev/null`;
    setBaseSha.run((await $`git -C ${workspace} rev-parse HEAD`.text()).trim(), attemptId);

    // A fresh snapshot every attempt: Retry after editing the issue briefs the edited text.
    let fetched: IssueSnapshot;
    try {
      fetched = await github.getIssue(repo.installation_id, repo.full_name, job.issue_number);
    } catch (err) {
      return finish(claimed, "failed", `issue: ${redact((err as Error).message)}`);
    }
    if (fetched.state === "CLOSED") return finish(claimed, "skipped", "skipped: closed", "closed");
    const issue: IssueSnapshot = { ...fetched, comments: fetched.comments.filter((c) => TRUSTED_AUTHORS.includes(c.authorAssociation)) };
    setIssue.run(JSON.stringify(issue), attemptId);

    let conventions = parse<Conventions>(repo.override);
    const hash = conventions ? null : await conventionsHash(workspace);
    if (hash && repo.conventions_hash === hash) conventions = parse<Conventions>(repo.conventions);
    if (!conventions) {
      const result = await runPhase(claimed, "conventions", { prompt: CONVENTIONS_PROMPT, schema: CONVENTIONS_SCHEMA, timeoutMs: CONVENTIONS_TIMEOUT_MS });
      if (!result.ok) return harnessFailed(claimed, "conventions", result.error);
      conventions = result.output as Conventions;
      saveConventions.run(JSON.stringify(conventions), hash, now(), repo.id);
    }
    if (!conventions.check_commands.length) return finish(claimed, "skipped", `skipped: ${NO_CHECKS}`, NO_CHECKS);

    const briefed = await runPhase(claimed, "brief", { prompt: briefPrompt(issue, conventions), schema: BRIEF_SCHEMA, timeoutMs: BRIEF_TIMEOUT_MS }, briefError);
    if (!briefed.ok) return harnessFailed(claimed, "brief", briefed.error);
    const brief = briefed.output as Brief;
    if (brief.outcome === "needs_info") {
      let result = "needs_info: the issue is too vague for testable acceptance criteria";
      if (config.commentQuestions) {
        try {
          await github.comment(repo.installation_id, repo.full_name, job.issue_number, questionsComment(brief.questions));
          result += "; the questions are posted on the issue";
        } catch (err) {
          result += `; posting the questions failed: ${redact((err as Error).message)}`;
        }
      }
      return finish(claimed, "needs_info", result);
    }
    finish(claimed, "failed", PIPELINE_ENDS);
  }

  /** Claims the oldest queued job and runs one attempt of it; false when there is nothing to do. */
  async function runNext() {
    const harness = harnesses.find((h) => h.name === getSetting("harness"));
    if (!harness || getSetting("paused")) return false;
    const claimed = db.transaction((): Claimed | null => {
      const job = claimJob.get(now());
      if (!job) return null;
      const attemptId = insertAttempt.get(job.id, harness.name, now())!.id;
      return { job, attemptId, harness, workspace: join(config.workspacesDir, `attempt-${attemptId}`) };
    })();
    if (!claimed) return false;
    try {
      await runAttempt(claimed);
    } catch (err) {
      console.error(`Attempt ${claimed.attemptId} failed:`, err);
      finish(claimed, "failed", `Internal error: ${redact((err as Error).message)}`);
    } finally {
      await runner.cleanup().catch((err) => console.error("Runner cleanup failed:", err));
      rmSync(claimed.workspace, { recursive: true, force: true });
    }
    return true;
  }

  let working: Promise<void> | undefined;
  /** Works through the queue; a call while it is already working joins that run. */
  function work() {
    working ??= (async () => {
      try {
        while (await runNext());
      } finally {
        working = undefined;
      }
    })();
    return working;
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

  type Stored<T, K extends keyof T> = Omit<T, K> & { [P in K]: string | null };
  const listAttempts = db.query<Stored<Omit<Attempt, "phases">, "issue">, [number]>(
    "SELECT id, harness, base_sha, started_at, finished_at, result, issue FROM attempts WHERE job_id = ? ORDER BY id",
  );
  const listPhases = db.query<Stored<Phase, "output">, [number]>(
    "SELECT name, started_at, finished_at, outcome, log, output FROM phases WHERE attempt_id = ? ORDER BY id",
  );
  http.get("/api/jobs/:id", (c) => {
    const job = getJob.get(Number(c.req.param("id")));
    if (!job) return c.json({ error: "Job not found" }, 404);
    const attempts = listAttempts.all(job.id).map((a) => ({
      ...a,
      issue: parse<IssueSnapshot>(a.issue),
      phases: listPhases.all(a.id).map((p) => ({ ...p, output: parse(p.output) })),
    }));
    return c.json({ ...job, attempts } satisfies JobDetail);
  });

  // ponytail: needs_info only; failed jobs become retryable when phases can resume.
  const retry = db.query("UPDATE jobs SET state = 'queued', updated_at = ? WHERE id = ? AND state = 'needs_info'");
  http.post("/api/jobs/:id/retry", (c) => {
    const id = Number(c.req.param("id"));
    if (retry.run(now(), id).changes) return c.json(getJob.get(id), 202);
    if (!getJob.get(id)) return c.json({ error: "Job not found" }, 404);
    return c.json({ error: "Only needs_info jobs can be retried" }, 409);
  });

  const listRepos = db.query<RepoRow, []>("SELECT * FROM repos ORDER BY full_name");
  const setOverride = db.query("UPDATE repos SET override = ? WHERE id = ?");
  const repoView = (row: RepoRow): RepoView => ({
    id: row.id,
    full_name: row.full_name,
    discovered: parse(row.conventions),
    discovered_at: row.conventions_at,
    override: parse(row.override),
  });
  http.get("/api/repos", (c) => c.json(listRepos.all().map(repoView)));

  /** Body: the conventions to use instead of discovered ones, or null to clear the override. */
  http.put("/api/repos/:id/override", async (c) => {
    const id = Number(c.req.param("id"));
    if (!getRepo.get(id)) return c.json({ error: "Repo not found" }, 404);
    const body = await c.req.json().catch(() => undefined);
    const invalid = body === undefined ? "Body must be JSON" : body === null ? null : schemaError(CONVENTIONS_SCHEMA, body);
    if (invalid) return c.json({ error: invalid }, 400);
    setOverride.run(body === null ? null : JSON.stringify(body), id);
    return c.json(repoView(getRepo.get(id)!));
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
    work,
    async start() {
      // Leftovers of attempts cut off by a restart.
      await runner.cleanup().catch((err) => console.error("Runner cleanup failed:", err));
      mkdirSync(config.workspacesDir, { recursive: true });
      for (const entry of readdirSync(config.workspacesDir)) rmSync(join(config.workspacesDir, entry), { recursive: true, force: true });
      await scan();
      void work();
      stopTimer = clock.every(SCAN_INTERVAL_MS, async () => {
        await scan();
        await work();
      });
    },
    stop() {
      stopTimer?.();
      db.close();
    },
  };
}
