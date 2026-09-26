import { join } from "node:path";
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import type { Clock } from "./clock";
import type { Config } from "./config";
import { openDb } from "./db";
import type { GitHub, Repo } from "./github";
import { JOB_STATES } from "./jobs";

const PAGE_SIZE = 50;
const SCAN_INTERVAL_MS = 60_000;
const CURSOR_OVERLAP_MS = 60_000;
const DIST = join(import.meta.dir, "../dist");
const STATIC_FILES: Record<string, string> = { "/": "index.html", "/app.js": "app.js", "/app.css": "app.css" };

export function createApp(deps: { config: Config; github: GitHub; clock: Clock }) {
  const { config, github, clock } = deps;
  const db = openDb(config.dbPath);
  const iso = (ms: number) => new Date(ms).toISOString();

  const getCursor = db.query<{ scanned_at: string }, [number]>("SELECT scanned_at FROM scan_cursors WHERE repo_id = ?");
  const setCursor = db.query(
    "INSERT INTO scan_cursors (repo_id, scanned_at) VALUES (?, ?) ON CONFLICT (repo_id) DO UPDATE SET scanned_at = excluded.scanned_at",
  );
  const insertJob = db.query(`INSERT INTO jobs
    (repo_id, repo_full_name, issue_number, issue_title, issue_url, state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)
    ON CONFLICT (repo_id, issue_number) DO NOTHING`);

  async function scanRepo(installationId: number, repo: Repo, scanStart: number) {
    const cursor = getCursor.get(repo.id)?.scanned_at;
    const since = cursor ? iso(Date.parse(cursor) - CURSOR_OVERLAP_MS) : undefined;
    const issues = await github.listIssues(installationId, repo, since);
    const now = iso(clock.now());
    db.transaction(() => {
      for (const issue of issues) {
        if (issue.pull_request || issue.state !== "open") continue;
        insertJob.run(repo.id, repo.full_name, issue.number, issue.title, issue.html_url, now, now);
      }
      setCursor.run(repo.id, iso(scanStart));
    })();
  }

  let scanning = false;
  async function scan() {
    if (scanning) return;
    scanning = true;
    const scanStart = clock.now();
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
          await scanRepo(installation.id, repo, scanStart).catch((err) =>
            console.error(`Scan of ${repo.full_name} failed; cursor not advanced:`, err),
          );
        }
      }
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
    const job = db.query("SELECT * FROM jobs WHERE id = ?").get(Number(c.req.param("id")));
    return job ? c.json(job) : c.json({ error: "Job not found" }, 404);
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
