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
import { changeError, commitChange, gitConfigHash, IMPLEMENT_SCHEMA, IMPLEMENT_TIMEOUT_MS, type Implemented, implementError, implementPrompt, bundleChange, restoreBundle, stageChange } from "./implement";
import type { GitHub, Issue, Repo } from "./github";
import { branchFor, prBody, prTitle } from "./publish";
import { type AuthCheckState, type Harness, type RunError, type RunOptions, schemaError, type SetupView } from "./harness";
import { type Attempt, type Brief, type CommandRuns, type Commit, type Conventions, JOB_STATES, type IssueSnapshot, type Job, type JobDetail, NO_CHECKS, type Phase, type RepoView, type ReviewRound, TRUSTED_AUTHORS, UNTRUSTED_AUTHOR } from "./jobs";
import { type Change, FIX_SCHEMA, FIX_TIMEOUT_MS, fixError, fixPrompt, REVIEW_ROUNDS, REVIEW_SCHEMA, REVIEW_TIMEOUT_MS, type Fixed, type Reviewed, reviewError, specPrompt, standardsPrompt } from "./review";
import type { Runner, Sandbox } from "./runner";
import { CHECKS_TIMEOUT_MS, checks, redGreen, type Verified } from "./verify";

const PAGE_SIZE = 50;
const SCAN_INTERVAL_MS = 60_000;
const CURSOR_OVERLAP_MS = 60_000;
/** Hard cap on one attempt; a phase's limit is clamped to what is left of it. */
export const ATTEMPT_TIMEOUT_MS = 2 * 60 * 60_000;
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

/** A source attempt row and one of its phase rows, as stored (output is the JSON string). */
type SourceAttempt = { id: number; base_sha: string | null; issue: string | null; commits: string; bundle: Uint8Array | null };
type SourcePhase = { name: string; started_at: string; finished_at: string | null; outcome: string | null; output: string | null };

type ResumeStep = "brief" | "implement" | "red/green" | "checks" | "review" | "publish";
const RESUME_ORDER: Record<ResumeStep, number> = { brief: 0, implement: 1, "red/green": 2, checks: 3, review: 4, publish: 5 };

/** What a failed Retry carries over from its source attempt, and the first step the new attempt runs itself. */
type ResumePlan = {
  sourceId: number;
  step: ResumeStep;
  baseSha: string | null;
  issue: IssueSnapshot | null;
  bundle: Uint8Array | null;
  /** The source phases to copy into the new attempt as reused, in order. */
  phases: SourcePhase[];
  /** The reused commits: the implement commit and every fix commit whose checks passed. */
  commits: Commit[];
  brief: Brief | null;
  implemented: Implemented | null;
  redGreen: CommandRuns | null;
  /** The latest reused checks output: the initial run or the last completed round's re-check. */
  checks: CommandRuns | null;
  rounds: ReviewRound[];
  /** The last verified commit; the resumed loop starts its next round from here. */
  head: string | null;
};

/** A phase counts as completed when it produced output, including one an earlier attempt carried over. */
const phaseDone = (p: SourcePhase | undefined) => p?.outcome === "ok" || p?.outcome === "skipped" || p?.outcome === "reused";

/** A source attempt with no saved bundle cannot restore its commits, so it resumes as a fresh brief. */
const resumeStep = (step: ResumeStep, hasBundle: boolean): ResumeStep => (!hasBundle && RESUME_ORDER[step] > RESUME_ORDER.implement ? "brief" : step);

const phaseOutput = <T>(p: SourcePhase | undefined): T | null => (p?.output ? (JSON.parse(p.output) as T) : null);

/**
 * Collects completed review rounds from the source attempt. A round completes on a clean review,
 * a fix that fixed nothing, or a fix commit whose own checks passed; an unverified fix commit
 * is not reused, and the loop restarts from the last verified commit.
 */
function collectReviewRounds(
  phases: SourcePhase[],
  startIndex: number,
  fixCommits: Commit[],
  initialHead: string | null,
  initialChecks: CommandRuns | null,
) {
  let step: ResumeStep = "review";
  const copy: SourcePhase[] = [];
  const reused: Commit[] = [];
  const rounds: ReviewRound[] = [];
  let head = initialHead;
  let checks = initialChecks;
  let i = startIndex;
  let fixCommitIndex = 0;

  while (i < phases.length) {
    const standards = phases[i];
    const spec = phases[i + 1];
    if (standards?.name !== "review/standards" || !phaseDone(standards) || spec?.name !== "review/spec" || !phaseDone(spec)) break;
    const round: ReviewRound = { standards: phaseOutput<Reviewed>(standards)!.findings, spec: phaseOutput<Reviewed>(spec)!.findings, decisions: [] };
    if (!round.standards.length && !round.spec.length) {
      rounds.push(round);
      copy.push(standards, spec);
      step = "publish"; // a clean round ends the loop
      break;
    }
    if (rounds.length + 1 >= REVIEW_ROUNDS) {
      rounds.push(round);
      copy.push(standards, spec);
      step = "publish"; // the round cap leaves these findings open
      break;
    }
    const fix = phases[i + 2];
    if (fix?.name !== "fix" || !phaseDone(fix)) break;
    round.decisions = phaseOutput<Fixed>(fix)!.decisions;
    if (!round.decisions.some((d) => d.decision === "fixed")) {
      rounds.push(round);
      copy.push(standards, spec, fix);
      step = "publish"; // a round that fixes nothing ends the loop
      break;
    }
    const recheck = phases[i + 3];
    // A fix commit that was never re-checked, or whose checks failed, is not reused; neither is its round.
    if (recheck?.name !== "checks" || !phaseDone(recheck)) break;
    const fixCommit = fixCommits[fixCommitIndex++];
    if (!fixCommit) break;
    rounds.push(round);
    copy.push(standards, spec, fix, recheck);
    reused.push(fixCommit);
    head = fixCommit.sha;
    checks = phaseOutput<CommandRuns>(recheck);
    i += 4;
  }

  return { step, copy, reused, rounds, head, checks };
}

/**
 * Where a failed Retry resumes and what it reuses: the first pipeline step with no completed output in the source
 * attempt.
 */
function analyzePhases(commits: Commit[], phases: SourcePhase[]) {
  const find = (name: string) => phases.find((p) => p.name === name);

  const briefPhase = find("brief");
  const implementPhase = find("implement");
  const redGreenPhase = find("red/green");
  const checksIdx = phases.findIndex((p) => p.name === "checks");
  const initialChecks = checksIdx !== -1 && phaseDone(phases[checksIdx]) ? phases[checksIdx] : undefined;

  let step: ResumeStep = "brief";
  const copy: SourcePhase[] = [];
  const reused: Commit[] = [];
  let rounds: ReviewRound[] = [];
  let head: string | null = null;
  let checks: CommandRuns | null = null;

  if (phaseDone(briefPhase)) {
    copy.push(briefPhase!);
    step = "implement";
  }
  if (step === "implement" && phaseDone(implementPhase) && commits.length) {
    copy.push(implementPhase!);
    reused.push(commits[0]!);
    head = commits[0]!.sha;
    step = "red/green";
  }
  if (step === "red/green" && phaseDone(redGreenPhase)) {
    copy.push(redGreenPhase!);
    step = "checks";
  }
  if (step === "checks" && initialChecks) {
    copy.push(initialChecks);
    checks = phaseOutput<CommandRuns>(initialChecks);
    const reviewed = collectReviewRounds(phases, checksIdx + 1, commits.slice(1), head, checks);
    step = reviewed.step;
    copy.push(...reviewed.copy);
    reused.push(...reviewed.reused);
    rounds = reviewed.rounds;
    head = reviewed.head;
    checks = reviewed.checks;
  }

  return {
    step,
    phases: copy,
    commits: reused,
    brief: phaseOutput<Brief>(briefPhase),
    implemented: phaseOutput<Implemented>(implementPhase),
    redGreen: phaseOutput<CommandRuns>(redGreenPhase),
    checks,
    rounds,
    head,
  };
}

const LOG_LIMIT_BYTES = 200 * 1024;
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

export function createApp(deps: { config: Config; github: GitHub; clock: Clock; harnesses: Harness[]; runner: Runner; sandbox: Sandbox }) {
  const { config, github, clock, harnesses, runner, sandbox } = deps;
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
  // Filter skips follow the issue on every scan; untrusted-author skips wait for Run anyway. Either way a job put
  // back in the queue outside Retry starts a fresh attempt, so any pending resume source is dropped.
  const filterSkipped = `state = 'skipped' AND skip_reason IN (${FILTER_REASONS.map((r) => `'${r}'`).join(", ")})`;
  const skipJob = db.query(`UPDATE jobs SET state = 'skipped', skip_reason = ?1, updated_at = ?2
    WHERE repo_id = ?3 AND issue_number = ?4 AND (state = 'queued' OR (${filterSkipped} AND skip_reason <> ?1))`);
  const liftSkip = db.query(`UPDATE jobs SET state = ?1, skip_reason = ?2, resume_from = NULL, updated_at = ?3
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
  const setBranch = db.query("UPDATE attempts SET branch = ? WHERE id = ?");
  const setPrUrl = db.query("UPDATE attempts SET pr_url = ? WHERE id = ?");
  const addCommit = db.query("UPDATE attempts SET commits = json_insert(commits, '$[#]', json(?)) WHERE id = ?");
  const setBundle = db.query("UPDATE attempts SET bundle = ? WHERE id = ?");
  const setResumedFrom = db.query("UPDATE attempts SET resumed_from = ? WHERE id = ?");
  const clearResume = db.query("UPDATE jobs SET resume_from = NULL WHERE id = ?");
  const getSourceAttempt = db.query<SourceAttempt, [number]>("SELECT id, base_sha, issue, commits, bundle FROM attempts WHERE id = ?");
  const listSourcePhases = db.query<SourcePhase, [number]>("SELECT name, started_at, finished_at, outcome, output FROM phases WHERE attempt_id = ? ORDER BY id");
  const insertReusedPhase = db.query("INSERT INTO phases (attempt_id, name, started_at, finished_at, outcome, log, output) VALUES (?, ?, ?, ?, 'reused', '', ?)");
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

  type Claimed = { job: Job; attemptId: number; harness: Harness; workspace: string; deadline: number };

  /** A phase's timeout: its own limit, clamped to what the attempt's 2-hour cap has left. */
  const phaseBudget = (limit: number, deadline: number) => {
    const left = deadline - clock.now();
    return { timeoutMs: Math.min(limit, left), capped: left < limit };
  };
  const cappedTimeout = (name: string) => `${name}: timeout (the attempt reached its 2-hour limit)`;

  function finish({ job, attemptId }: Claimed, state: Job["state"], result: string, skipReason: string | null = null) {
    db.transaction(() => {
      endJob.run(state, skipReason, now(), job.id);
      endAttempt.run(now(), result, attemptId);
    })();
  }

  /**
   * Runs one agent phase; check rejects schema-valid output as bad_output with its reason. capped reports that the
   * cap, not the phase's own limit, ended a timeout. An already-spent budget records the phase and returns without
   * starting it.
   */
  async function runPhase(
    { job, attemptId, harness, workspace, deadline }: Claimed,
    name: string,
    options: Omit<RunOptions, "workspace" | "wrap">,
    check: (output: unknown) => string | null = () => null,
  ) {
    setPhase.run(name, now(), job.id);
    const phase = startPhase.get(attemptId, name, now())!;
    const { timeoutMs, capped } = phaseBudget(options.timeoutMs, deadline);
    if (timeoutMs <= 0) {
      endPhase.run(now(), "timeout", "", null, phase.id);
      return { ok: false as const, error: "timeout" as const, log: "", capped: true };
    }
    let result = await harness.run({ ...options, timeoutMs, workspace, wrap: runner.command(workspace, harness.name) });
    const invalid = result.ok && check(result.output);
    if (invalid) result = { ok: false, error: "bad_output", log: `${result.log}\nOutput rejected: ${invalid}` };
    const output = result.ok ? JSON.stringify(result.output) : null;
    endPhase.run(now(), result.ok ? "ok" : result.error, capLog(redact(result.log)), output, phase.id);
    return { ...result, capped };
  }

  /** Runs one controller phase; null when it failed the attempt. limit is clamped to the attempt's hard cap. */
  async function verifyPhase(claimed: Claimed, name: string, limit: number, verify: (timeoutMs: number) => Promise<Verified>): Promise<CommandRuns | null> {
    setPhase.run(name, now(), claimed.job.id);
    const phase = startPhase.get(claimed.attemptId, name, now())!;
    const { timeoutMs, capped } = phaseBudget(limit, claimed.deadline);
    if (timeoutMs <= 0) {
      endPhase.run(now(), "timeout", "", null, phase.id);
      finish(claimed, "failed", cappedTimeout(name));
      return null;
    }
    let verified: Verified;
    try {
      verified = await verify(timeoutMs);
    } catch (err) {
      endPhase.run(now(), "error", "", null, phase.id);
      throw err;
    }
    const { output, log, error } = verified;
    const outcome = output.skipped ? "skipped" : error === "timeout" ? "timeout" : error ? "failed" : "ok";
    endPhase.run(now(), outcome, capLog(redact(log)), JSON.stringify(output), phase.id);
    if (error) finish(claimed, "failed", error === "timeout" && capped ? cappedTimeout(name) : `${name}: ${redact(error)}`);
    return error ? null : output;
  }

  /**
   * Pushes head to the issue's branch and opens a draft PR from it, reusing any PR the branch already has. The
   * commits are already recorded; the branch is recorded before the push. Never forces and never writes another branch.
   */
  async function publish(claimed: Claimed, repo: RepoRow, head: string, title: string, body: string) {
    const { job, attemptId, workspace } = claimed;
    const branch = branchFor(job.issue_number);
    const { installation_id: installation, full_name: fullName } = repo;
    setPhase.run("publish", now(), job.id);
    const phase = startPhase.get(attemptId, "publish", now())!;
    const log: string[] = [];
    const end = (outcome: string, output: object | null = null) => endPhase.run(now(), outcome, capLog(redact(log.join("\n"))), output && JSON.stringify(output), phase.id);
    try {
      if ((await github.getIssue(installation, fullName, job.issue_number)).state === "CLOSED") {
        end("skipped");
        return finish(claimed, "skipped", "skipped: closed", "closed");
      }
      setBranch.run(branch, attemptId);
      const remote = await github.branchSha(installation, fullName, branch);
      if (remote && remote !== head) {
        end("failed");
        return finish(claimed, "failed", `publish: ${branch} is at ${remote} on the remote, not a commit of this attempt`);
      }
      if (!remote) {
        await github.push(installation, fullName, workspace, head, branch);
        log.push(`Pushed ${head} to ${branch}.`);
      }
      let pr = await github.findPullRequest(installation, fullName, branch);
      if (pr) log.push(`Reused ${pr.url}.`);
      else {
        const base = (await $`git -C ${workspace} symbolic-ref --short HEAD`.text()).trim();
        pr = await github.createDraftPullRequest(installation, fullName, { head: branch, base, title, body });
        log.push(`Opened draft ${pr.url} into ${base}.`);
      }
      setPrUrl.run(pr.url, attemptId);
      end("ok", { branch, pr_url: pr.url });
      finish(claimed, "pr_created", `pr_created: ${pr.url}`);
    } catch (err) {
      log.push((err as Error).message);
      end("failed");
      finish(claimed, "failed", `publish: ${redact((err as Error).message)}`);
    }
  }

  /** auth and quota pause dispatch and put the job back in the queue; other errors fail the job. */
  function harnessFailed(claimed: Claimed, phase: string, error: RunError, capped = false) {
    const pause = PAUSE_REASONS[error];
    if (pause) setSetting("paused", pause);
    finish(claimed, pause ? "queued" : "failed", error === "timeout" && capped ? cappedTimeout(phase) : `${phase}: ${error}`);
  }

  /** Why the workspace cannot be used for the next git call on the host, or null. */
  const workspaceError = (workspace: string, configHash: string) => (gitConfigHash(workspace) === configHash ? null : "the agent edited .git/config");

  /**
   * The review loop: up to REVIEW_ROUNDS rounds, each a fresh Standards review and a fresh Spec review. The fix
   * phase decides every finding and its commit is re-checked. The loop ends when a round finds nothing or fixes
   * nothing, or at the round cap, whose findings stay open for the PR. A resumed attempt carries its completed
   * rounds in, so they count toward the cap and appear in the PR. null when the attempt failed.
   */
  async function reviewLoop(
    claimed: Claimed,
    review: { configHash: string; change: Change; conventions: Conventions; issue: IssueSnapshot; brief: Brief; checks: CommandRuns; testFiles: string[]; rounds?: ReviewRound[] },
  ): Promise<{ rounds: ReviewRound[]; head: string; checks: CommandRuns } | null> {
    const { workspace } = claimed;
    const { configHash, change, conventions, issue, brief, testFiles } = review;
    const rounds: ReviewRound[] = [...(review.rounds ?? [])];
    let head = change.commits[change.commits.length - 1]!.sha;
    let latestChecks = review.checks;
    while (rounds.length < REVIEW_ROUNDS) {
      const standards = await runPhase(
        claimed,
        "review/standards",
        { prompt: standardsPrompt(change, conventions), schema: REVIEW_SCHEMA, timeoutMs: REVIEW_TIMEOUT_MS },
        (output) => reviewError(output, "S"),
      );
      if (!standards.ok) {
        harnessFailed(claimed, "review/standards", standards.error, standards.capped);
        return null;
      }
      const spec = await runPhase(
        claimed,
        "review/spec",
        { prompt: specPrompt(change, brief, issue), schema: REVIEW_SCHEMA, timeoutMs: REVIEW_TIMEOUT_MS },
        (output) => reviewError(output, "P"),
      );
      if (!spec.ok) {
        harnessFailed(claimed, "review/spec", spec.error, spec.capped);
        return null;
      }
      const round: ReviewRound = { standards: (standards.output as Reviewed).findings, spec: (spec.output as Reviewed).findings, decisions: [] };
      rounds.push(round);
      const findings = [...round.standards, ...round.spec];
      if (!findings.length) break; // a clean round ends the loop
      if (rounds.length >= REVIEW_ROUNDS) break; // the cap: these findings stay open

      // Reviews must not edit: discard anything they left, guarded, so only fixes reach the fix commit.
      const dirty = workspaceError(workspace, configHash);
      if (dirty) {
        finish(claimed, "failed", `review: ${dirty}`);
        return null;
      }
      await $`git -C ${workspace} reset -q --hard ${head}`.quiet();
      await $`git -C ${workspace} clean -qfd`.quiet();

      const fixed = await runPhase(
        claimed,
        "fix",
        { prompt: fixPrompt(change, conventions, findings), schema: FIX_SCHEMA, timeoutMs: FIX_TIMEOUT_MS },
        (output) => fixError(output, findings),
      );
      if (!fixed.ok) {
        harnessFailed(claimed, "fix", fixed.error, fixed.capped);
        return null;
      }
      round.decisions = (fixed.output as Fixed).decisions;
      if (!round.decisions.some((d) => d.decision === "fixed")) break; // a round that fixes nothing ends the loop
      // A fix is not a feature change, so the tests-required rule does not apply: only the generic diff rules do.
      const staged = await stageChange(workspace, head, configHash);
      if ("error" in staged) {
        finish(claimed, "failed", `fix: ${staged.error}`);
        return null;
      }
      // A "fixed" decision with no change would let the PR claim a fix that never happened.
      if (!staged.changed.length) {
        finish(claimed, "failed", "fix: the phase marked findings fixed but changed nothing");
        return null;
      }
      // A fix must not weaken the evidence: red/green does not re-run, so an edited or deleted test would stand.
      const touched = testFiles.find((file) => staged.changed.some((c) => c.path === file && c.status !== "A"));
      if (touched) {
        finish(claimed, "failed", `fix: the fix deletes or edits the test file ${touched}`);
        return null;
      }
      const fix = await commitChange(workspace, (fixed.output as Fixed).commit_message);
      addCommit.run(JSON.stringify(fix), claimed.attemptId);
      // stageChange checked the config just above; no agent runs between it and this bundle write.
      setBundle.run(await bundleChange(workspace, change.base), claimed.attemptId);
      change.commits.push(fix);
      head = fix.sha;
      const rechecked = await verifyPhase(claimed, "checks", CHECKS_TIMEOUT_MS, (timeoutMs) => checks(sandbox, workspace, head, conventions, timeoutMs));
      if (!rechecked) return null; // failing checks after the loop fail the attempt, with no PR
      latestChecks = rechecked;
    }
    // All exit paths reach here, and publishing runs git on the host: a tampered checkout's config must fail first.
    const edited = workspaceError(workspace, configHash);
    if (edited) {
      finish(claimed, "failed", `review: ${edited}`);
      return null;
    }
    return { rounds, head, checks: latestChecks };
  }

  /** The plan for a failed Retry, or null when the attempt starts fresh. */
  function planResume(sourceId: number): ResumePlan | null {
    const source = getSourceAttempt.get(sourceId);
    if (!source) return null;
    const analysis = analyzePhases(parse<Commit[]>(source.commits) ?? [], listSourcePhases.all(sourceId));
    const step = resumeStep(analysis.step, source.bundle !== null);
    // ponytail: an attempt from before bundles exist has no saved objects, so the retry simply starts over.
    if (step === "brief" && analysis.step !== "brief") return null;
    return {
      sourceId,
      baseSha: source.base_sha,
      issue: parse<IssueSnapshot>(source.issue),
      bundle: source.bundle,
      ...analysis,
      step,
    };
  }

  async function runAttempt(claimed: Claimed) {
    const { job, attemptId, workspace } = claimed;
    const repo = getRepo.get(job.repo_id);
    if (!repo) return finish(claimed, "failed", "The repo is no longer enabled for the GitHub App.");
    // A failed Retry continues the source attempt: its phases, commits, issue, and bundle. A fresh attempt has none.
    const plan = job.resume_from === null ? null : planResume(job.resume_from);
    const reuse = (step: ResumeStep) => !!plan && RESUME_ORDER[plan.step] > RESUME_ORDER[step];

    try {
      await github.checkout(repo.installation_id, repo.full_name, workspace);
    } catch (err) {
      return finish(claimed, "failed", `checkout: ${redact((err as Error).message)}`);
    }
    await $`git -C ${workspace} config core.hooksPath /dev/null`;
    // The bundle fetch and reset run before any agent session of this attempt, so no configHash guard is needed.
    if (plan?.bundle && plan.head) {
      try {
        await restoreBundle(workspace, plan.bundle, plan.head);
      } catch (err) {
        return finish(claimed, "failed", `resume: ${redact((err as Error).message)}`);
      }
    }
    const configHash = gitConfigHash(workspace);
    const baseSha = plan?.baseSha ?? (await $`git -C ${workspace} rev-parse HEAD`.text()).trim();
    setBaseSha.run(baseSha, attemptId);
    if (plan) {
      setResumedFrom.run(plan.sourceId, attemptId);
      for (const phase of plan.phases) insertReusedPhase.run(attemptId, phase.name, phase.started_at, phase.finished_at ?? now(), phase.output);
      // Carry the reused commits and the bundle over, so job detail and a retry of this attempt both see them.
      for (const commit of plan.commits) addCommit.run(JSON.stringify(commit), attemptId);
      if (plan.bundle) setBundle.run(plan.bundle, attemptId);
    }

    // A failed Retry reuses the saved issue snapshot. A fresh attempt takes one; Retry after editing the issue
    // (needs_info) briefs the edited text.
    let issue: IssueSnapshot;
    if (plan?.issue) issue = plan.issue;
    else {
      let fetched: IssueSnapshot;
      try {
        fetched = await github.getIssue(repo.installation_id, repo.full_name, job.issue_number);
      } catch (err) {
        return finish(claimed, "failed", `issue: ${redact((err as Error).message)}`);
      }
      if (fetched.state === "CLOSED") return finish(claimed, "skipped", "skipped: closed", "closed");
      issue = { ...fetched, comments: fetched.comments.filter((c) => TRUSTED_AUTHORS.includes(c.authorAssociation)) };
    }
    setIssue.run(JSON.stringify(issue), attemptId);

    let conventions = parse<Conventions>(repo.override);
    const hash = conventions ? null : await conventionsHash(workspace);
    if (hash && repo.conventions_hash === hash) conventions = parse<Conventions>(repo.conventions);
    if (!conventions) {
      const result = await runPhase(claimed, "conventions", { prompt: CONVENTIONS_PROMPT, schema: CONVENTIONS_SCHEMA, timeoutMs: CONVENTIONS_TIMEOUT_MS });
      if (!result.ok) return harnessFailed(claimed, "conventions", result.error, result.capped);
      conventions = result.output as Conventions;
      saveConventions.run(JSON.stringify(conventions), hash, now(), repo.id);
    }
    if (!conventions.check_commands.length) return finish(claimed, "skipped", `skipped: ${NO_CHECKS}`, NO_CHECKS);

    let brief: Brief;
    if (reuse("brief")) brief = plan!.brief!;
    else {
      const briefed = await runPhase(claimed, "brief", { prompt: briefPrompt(issue, conventions), schema: BRIEF_SCHEMA, timeoutMs: BRIEF_TIMEOUT_MS }, briefError);
      if (!briefed.ok) return harnessFailed(claimed, "brief", briefed.error, briefed.capped);
      brief = briefed.output as Brief;
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
    }

    let head: Commit;
    let implemented: Implemented;
    if (reuse("implement")) {
      head = plan!.commits[0]!;
      implemented = plan!.implemented!;
    } else {
      const run = await runPhase(
        claimed,
        "implement",
        { prompt: implementPrompt(brief, conventions), schema: IMPLEMENT_SCHEMA, timeoutMs: IMPLEMENT_TIMEOUT_MS },
        implementError,
      );
      if (!run.ok) return harnessFailed(claimed, "implement", run.error, run.capped);
      implemented = run.output as Implemented;
      const rejected = await changeError(workspace, baseSha, configHash, conventions.has_tests, implemented.tests_added.map((t) => t.file));
      if (rejected) return finish(claimed, "failed", `implement: ${rejected}`);
      head = await commitChange(workspace, implemented.commit_message);
      addCommit.run(JSON.stringify(head), attemptId);
      // changeError checked the config just above; no agent runs between it and this bundle write.
      setBundle.run(await bundleChange(workspace, baseSha), attemptId);
    }
    const testFiles = implemented.tests_added.map((t) => t.file);

    let redGreenRuns: CommandRuns;
    if (reuse("red/green")) redGreenRuns = plan!.redGreen!;
    else {
      const runs = await verifyPhase(claimed, "red/green", CHECKS_TIMEOUT_MS, (timeoutMs) => redGreen(sandbox, workspace, baseSha, head.sha, conventions, testFiles, timeoutMs));
      if (!runs) return;
      redGreenRuns = runs;
    }
    let checkRuns: CommandRuns;
    if (reuse("checks")) checkRuns = plan!.checks!;
    else {
      const runs = await verifyPhase(claimed, "checks", CHECKS_TIMEOUT_MS, (timeoutMs) => checks(sandbox, workspace, head.sha, conventions, timeoutMs));
      if (!runs) return;
      checkRuns = runs;
    }

    // A resume at publish reuses the whole review loop; otherwise the loop continues from any completed rounds.
    const commits = plan?.commits.length ? plan.commits : [head];
    const review =
      plan?.step === "publish"
        ? { rounds: plan.rounds, head: plan.head!, checks: checkRuns }
        : await reviewLoop(claimed, { configHash, change: { base: baseSha, commits }, conventions, issue, brief, checks: checkRuns, testFiles, rounds: plan?.rounds });
    if (!review) return;
    const tampered = workspaceError(workspace, configHash);
    if (tampered) return finish(claimed, "failed", `review: ${tampered}`);
    const body = prBody({ issue, brief, implemented, redGreen: redGreenRuns, checks: review.checks, review: review.rounds, harness: claimed.harness.label });
    await publish(claimed, repo, review.head, prTitle(issue, conventions, implemented.commit_message), body);
  }

  /** Claims the oldest queued job and runs one attempt of it; false when there is nothing to do. */
  async function runNext() {
    const harness = harnesses.find((h) => h.name === getSetting("harness"));
    if (!harness || getSetting("paused")) return false;
    const claimed = db.transaction((): Claimed | null => {
      const job = claimJob.get(now());
      if (!job) return null;
      const attemptId = insertAttempt.get(job.id, harness.name, now())!.id;
      // The resume source is consumed by claiming: runAttempt reads it from the claimed row, not from the job.
      clearResume.run(job.id);
      return { job, attemptId, harness, workspace: join(config.workspacesDir, `attempt-${attemptId}`), deadline: clock.now() + ATTEMPT_TIMEOUT_MS };
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
  const listAttempts = db.query<Stored<Omit<Attempt, "phases" | "branch_url">, "issue" | "commits">, [number]>(
    "SELECT id, harness, base_sha, started_at, finished_at, result, issue, commits, branch, pr_url, resumed_from FROM attempts WHERE job_id = ? ORDER BY id",
  );
  const listPhases = db.query<Stored<Phase, "output">, [number]>(
    "SELECT name, started_at, finished_at, outcome, log, output FROM phases WHERE attempt_id = ? ORDER BY id",
  );
  const attemptHasBundle = db.query<{ has_bundle: number }, [number]>("SELECT (bundle IS NOT NULL) AS has_bundle FROM attempts WHERE id = ?");
  http.get("/api/jobs/:id", (c) => {
    const job = getJob.get(Number(c.req.param("id")));
    if (!job) return c.json({ error: "Job not found" }, 404);
    const attempts = listAttempts.all(job.id).map((a) => ({
      ...a,
      issue: parse<IssueSnapshot>(a.issue),
      commits: parse<Commit[]>(a.commits)!,
      branch_url: a.branch && `https://github.com/${job.repo_full_name}/tree/${a.branch}`,
      phases: listPhases.all(a.id).map((p) => ({ ...p, output: parse(p.output) })),
    }));
    // A failed job's Retry resumes where its last attempt stopped; the dashboard names that phase in the hint.
    const last = attempts[attempts.length - 1];
    const resume_phase =
      job.state === "failed" && last ? resumeStep(analyzePhases(last.commits, listSourcePhases.all(last.id)).step, attemptHasBundle.get(last.id)!.has_bundle === 1) : null;
    return c.json({ ...job, attempts, resume_phase } satisfies JobDetail);
  });

  // needs_info starts over at the brief with a fresh snapshot; failed resumes its last attempt; any other state is
  // refused. The one conditional UPDATE keeps a double click or a race from queueing the job twice.
  const retry = db.query(`UPDATE jobs SET state = 'queued',
    resume_from = CASE WHEN state = 'failed' THEN (SELECT max(id) FROM attempts WHERE job_id = jobs.id) ELSE NULL END,
    updated_at = ?
    WHERE id = ? AND state IN ('needs_info', 'failed')`);
  http.post("/api/jobs/:id/retry", (c) => {
    const id = Number(c.req.param("id"));
    if (retry.run(now(), id).changes) return c.json(getJob.get(id), 202);
    if (!getJob.get(id)) return c.json({ error: "Job not found" }, 404);
    return c.json({ error: "Only needs_info and failed jobs can be retried" }, 409);
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

  const runAnyway = db.query(`UPDATE jobs SET state = 'queued', skip_reason = NULL, resume_from = NULL, updated_at = ?
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
    setSetting("auth", { state, checkedAt: iso(clock.now()), log: capLog(redact(log)) });
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
