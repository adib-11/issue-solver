import { $ } from "bun";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createApp } from "../src/app";
import type { Clock } from "../src/clock";
import type { Config } from "../src/config";
import type { GitHub, Installation, Issue, PullRequest, Repo } from "../src/github";
import type { IssueComment } from "../src/jobs";
import type { AuthState, Harness, RunOptions, RunResult } from "../src/harness";
import type { Runner, Sandbox, SandboxRun } from "../src/runner";

export class FakeGitHub implements GitHub {
  installations: Installation[] = [];
  repos = new Map<number, Repo[]>();
  issues = new Map<number, Issue[]>();
  calls: { op: string; args: unknown[] }[] = [];
  failNextListIssues = false;
  failingInstallations = new Set<number>();
  /** Local git repositories standing in for GitHub remotes, by full name. */
  remotes = new Map<string, string>();

  async listInstallations() {
    this.calls.push({ op: "listInstallations", args: [] });
    return this.installations;
  }

  async listInstallationRepos(installationId: number) {
    this.calls.push({ op: "listInstallationRepos", args: [installationId] });
    if (this.failingInstallations.has(installationId)) throw new Error("GitHub 401");
    return this.repos.get(installationId) ?? [];
  }

  async listIssues(installationId: number, repo: Repo, since: string | undefined) {
    this.calls.push({ op: "listIssues", args: [installationId, repo.full_name, since] });
    if (this.failNextListIssues) {
      this.failNextListIssues = false;
      throw new Error("GitHub 502");
    }
    const all = this.issues.get(repo.id) ?? [];
    return since === undefined ? all : all.filter((i) => i.updatedAt >= since);
  }

  async checkout(installationId: number, fullName: string, dir: string) {
    this.calls.push({ op: "checkout", args: [installationId, fullName] });
    const remote = this.remotes.get(fullName);
    if (!remote) throw new Error(`No remote for ${fullName}`);
    await $`git clone -q ${remote} ${dir}`;
  }

  /** Issue bodies and comments by "fullName#number"; getIssue combines them with the listed issue. */
  bodies = new Map<string, string>();
  comments = new Map<string, IssueComment[]>();

  async getIssue(installationId: number, fullName: string, number: number) {
    this.calls.push({ op: "getIssue", args: [installationId, fullName, number] });
    const repoId = [...this.repos.values()].flat().find((r) => r.full_name === fullName)?.id;
    const found = this.issues.get(repoId!)?.find((i) => i.number === number);
    if (!found) throw new Error(`GitHub 404: ${fullName}#${number}`);
    const key = `${fullName}#${number}`;
    const { title, url, state } = found;
    return { number, title, url, state, body: this.bodies.get(key) ?? `Body of ${number}`, comments: this.comments.get(key) ?? [] };
  }

  async comment(installationId: number, fullName: string, number: number, body: string) {
    this.calls.push({ op: "comment", args: [installationId, fullName, number, body] });
  }

  /** Pull requests on the fake remotes, open or not. */
  pulls: (PullRequest & { fullName: string; head: string; base: string; title: string; body: string; draft: boolean })[] = [];
  /** Runs before each push reaches the remote. */
  beforePush?: () => Promise<void> | void;

  async branchSha(installationId: number, fullName: string, branch: string) {
    this.calls.push({ op: "branchSha", args: [installationId, fullName, branch] });
    const out = (await $`git ls-remote ${this.remotes.get(fullName)!} refs/heads/${branch}`.text()).trim();
    return out ? out.split("\t")[0]! : null;
  }

  async push(installationId: number, fullName: string, dir: string, sha: string, branch: string) {
    this.calls.push({ op: "push", args: [installationId, fullName, sha, branch] });
    await this.beforePush?.();
    await $`git -C ${dir} push -q ${this.remotes.get(fullName)!} ${sha}:refs/heads/${branch}`;
  }

  async findPullRequest(installationId: number, fullName: string, branch: string) {
    this.calls.push({ op: "findPullRequest", args: [installationId, fullName, branch] });
    const pr = this.pulls.find((p) => p.fullName === fullName && p.head === branch);
    return pr ? { number: pr.number, url: pr.url } : null;
  }

  async createDraftPullRequest(installationId: number, fullName: string, pr: { head: string; base: string; title: string; body: string }) {
    this.calls.push({ op: "createDraftPullRequest", args: [installationId, fullName, pr] });
    const number = 100 + this.pulls.length;
    const created = { number, url: `https://github.com/${fullName}/pull/${number}`, fullName, draft: true, ...pr };
    this.pulls.push(created);
    return { number, url: created.url };
  }

  sinceArgs() {
    return this.calls.filter((c) => c.op === "listIssues").map((c) => c.args[2]);
  }
}

export class FakeHarness implements Harness {
  label: string;
  loginHelp: string;
  authState: AuthState | "error" = "ok";
  authChecks = 0;
  authLog = "";
  constructor(
    public name: string,
    public credential?: string,
  ) {
    this.label = `Label of ${name}`;
    this.loginHelp = `Log in to ${name} like this.`;
  }

  async checkAuth() {
    this.authChecks++;
    return { state: this.authState, log: `${this.name} auth: ${this.authState}${this.authLog}` };
  }

  /** Scripted runs, answered in order; each sees the options, and the workspace while it still exists. */
  script: ((options: RunOptions) => RunResult | Promise<RunResult>)[] = [];
  runs: RunOptions[] = [];

  async run(options: RunOptions): Promise<RunResult> {
    this.runs.push(options);
    const next = this.script.shift();
    if (!next) throw new Error(`${this.name}: no scripted run left`);
    return next(options);
  }
}

export class FakeRunner implements Runner {
  cleanups = 0;
  command(workspace: string, harness: string) {
    return ["runner", harness, workspace];
  }
  async cleanup() {
    this.cleanups++;
  }
}

export class FakeSandbox implements Sandbox {
  /** Each command's exit code, or its result, given the directory it runs in; everything exits 0 by default. */
  script: (command: string, dir: string) => number | Omit<SandboxRun, "command"> | "timeout" = () => 0;
  runs: { dir: string; setup: string; commands: string[]; timeoutMs: number }[] = [];

  async run(dir: string, setup: string, commands: string[], timeoutMs: number) {
    this.runs.push({ dir, setup, commands, timeoutMs });
    const runs: SandboxRun[] = [];
    for (const [i, command] of [setup, ...commands].entries()) {
      if (!command) continue;
      const result = this.script(command, dir);
      if (result === "timeout") return { runs, timedOut: true };
      runs.push(typeof result === "number" ? { command, exitCode: result, log: `output of ${command}` } : { command, ...result });
      if (i === 0 && runs.at(-1)!.exitCode) break;
    }
    return { runs, timedOut: false };
  }
}

export class FakeClock implements Clock {
  private timers: { every: number; due: number; fn: () => Promise<void> | void }[] = [];
  constructor(public ms = Date.parse("2026-01-01T00:00:00Z")) {}

  now() {
    return this.ms;
  }

  every(ms: number, fn: () => Promise<void> | void) {
    const timer = { every: ms, due: this.ms + ms, fn };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((t) => t !== timer);
    };
  }

  async advance(ms: number) {
    const target = this.ms + ms;
    for (;;) {
      const next = this.timers.filter((t) => t.due <= target).sort((a, b) => a.due - b.due)[0];
      if (!next) break;
      this.ms = next.due;
      next.due += next.every;
      await next.fn();
    }
    this.ms = target;
  }
}

export const OWNER = "octo";
export const PASSWORD = "s3cret";

export function issue(number: number, over: Partial<Issue> = {}): Issue {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://github.com/octo/app/issues/${number}`,
    state: "OPEN",
    authorAssociation: "OWNER",
    createdAt: "2025-12-01T00:00:00Z",
    updatedAt: "2025-12-01T00:00:00Z",
    assignees: { totalCount: 0 },
    closedByPullRequestsReferences: { nodes: [] },
    timelineItems: { nodes: [] },
    ...over,
  };
}

export function repo(id: number, name = "app", over: Partial<Repo> = {}): Repo {
  return { id, full_name: `${OWNER}/${name}`, fork: false, archived: false, ...over };
}

export async function commit(dir: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  await $`git -C ${dir} add -A && git -C ${dir} -c user.name=t -c user.email=t@example.com commit -q -m change`;
}

export function setup() {
  const dir = mkdtempSync(join(tmpdir(), "auto-solve-"));
  const github = new FakeGitHub();
  const clock = new FakeClock();
  const config: Config = {
    ownerLogin: OWNER,
    appId: "1",
    privateKey: "unused",
    adminPassword: PASSWORD,
    codexHome: join(dir, "codex"),
    codexVolume: "codex",
    dbPath: join(dir, "db.sqlite"),
    workspacesDir: join(dir, "workspaces"),
    runnerImage: "runner:test",
    workspaceVolume: "workspaces",
    port: 0,
    commentQuestions: false,
  };
  github.installations = [{ id: 10, account: { login: OWNER, type: "User" } }];
  const harnesses = [new FakeHarness("claude-code", "token-1"), new FakeHarness("other")];
  const runner = new FakeRunner();
  const sandbox = new FakeSandbox();
  let app = createApp({ config, github, clock, harnesses, runner, sandbox });

  const auth = { Authorization: `Basic ${btoa(`admin:${PASSWORD}`)}` };
  async function get(path: string, headers: Record<string, string> = auth) {
    return app.fetch(new Request(`http://localhost${path}`, { headers }));
  }
  async function post(path: string, body?: unknown, method = "POST") {
    const headers = { ...auth, Origin: "http://localhost", "Content-Type": "application/json" };
    return app.fetch(new Request(`http://localhost${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  }
  async function json(path: string) {
    const res = await get(path);
    if (res.status !== 200) throw new Error(`${path} -> ${res.status}`);
    return res.json() as Promise<any>;
  }

  return {
    get app() {
      return app;
    },
    /** A new app on the same database, as after a service restart. */
    restart() {
      app.stop();
      app = createApp({ config, github, clock, harnesses, runner, sandbox });
    },
    harnesses,
    runner,
    sandbox,
    /** A git repository standing in for the GitHub repo fullName, with one commit of these files. */
    async remote(fullName: string, files: Record<string, string>) {
      const path = join(dir, "remotes", fullName);
      mkdirSync(path, { recursive: true });
      await $`git init -q -b main ${path}`;
      await commit(path, files);
      github.remotes.set(fullName, path);
      return path;
    },
    github,
    clock,
    config,
    auth,
    get,
    post,
    json,
    cleanup() {
      app.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
