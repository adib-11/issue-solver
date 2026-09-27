import { afterEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunResult } from "../src/harness";
import { commit, issue, repo, setup } from "./fakes";

let t: ReturnType<typeof setup>;
afterEach(() => t.cleanup());

const CONVENTIONS = {
  setup_command: "bun install",
  check_commands: ["bun test", "bun run typecheck"],
  test_file_command: "bun test {file}",
  has_tests: true,
  commit_style: "Imperative sentence case, e.g. Add a --dry-run flag",
  notes: "Tests live in test/.",
};
const discovered = (output: unknown = CONVENTIONS, log = "discovery log"): (() => RunResult) => () => ({ ok: true, output, log });

/** A chosen harness, one repo with a checkout-able remote, and these issues queued. */
async function ready(issues = [issue(1)]) {
  t = setup();
  await t.post("/api/setup", { harness: "claude-code" }, "PUT");
  t.github.repos.set(10, [repo(1)]);
  t.github.issues.set(1, issues);
  const remote = await t.remote("octo/app", { "package.json": "{}", "README.md": "hi" });
  await t.app.scan();
  return { harness: t.harnesses[0]!, remote };
}

/** Scans in a new issue, updated after the previous scan. */
async function addIssue(number: number) {
  await t.clock.advance(60_000);
  t.github.issues.get(1)!.push(issue(number, { updatedAt: new Date(t.clock.now()).toISOString() }));
  await t.app.scan();
}

async function jobFor(number: number) {
  const { jobs } = await t.json("/api/jobs");
  return t.json(`/api/jobs/${jobs.find((j: any) => j.issue_number === number).id}`);
}

const until = async (condition: () => boolean | Promise<boolean>) => {
  while (!(await condition())) await Bun.sleep(1);
};

describe("worker", () => {
  test("claims the oldest queued job and runs conventions in a hook-free checkout of it, mounted into the runner", async () => {
    const { harness } = await ready([issue(2), issue(1, { createdAt: "2025-01-01T00:00:00Z" })]);
    let seen: { files: string; hooksPath: string } | undefined;
    harness.script = [
      async ({ workspace }) => {
        seen = {
          files: readFileSync(join(workspace, "package.json"), "utf8"),
          hooksPath: (await $`git -C ${workspace} config core.hooksPath`.text()).trim(),
        };
        return discovered()();
      },
    ];
    await t.app.work();

    const [run] = harness.runs;
    expect(run!.workspace).toStartWith(t.config.workspacesDir);
    expect(run!.wrap).toEqual(["runner", run!.workspace]);
    expect(run!.timeoutMs).toBe(10 * 60_000);
    expect(run!.schema.required).toEqual(["setup_command", "check_commands", "test_file_command", "has_tests", "commit_style", "notes"]);
    expect(seen).toEqual({ files: "{}", hooksPath: "/dev/null" });
    expect(t.github.calls.find((c) => c.op === "checkout")?.args).toEqual([10, "octo/app"]);
    expect(existsSync(run!.workspace)).toBe(false);
  });

  test("records the attempt and its phases, then stops with the pipeline-ends-here reason", async () => {
    const { harness } = await ready();
    harness.script = [discovered()];
    await t.app.work();
    const job = await jobFor(1);
    expect(job).toMatchObject({ state: "failed", phase: null });
    expect(job.attempts).toMatchObject([
      {
        harness: "claude-code",
        base_sha: expect.stringMatching(/^[0-9a-f]{40}$/),
        result: expect.stringContaining("Pipeline ends here"),
        phases: [{ name: "conventions", outcome: "ok", log: "discovery log" }],
      },
    ]);
  });

  test("runs one attempt at a time", async () => {
    const { harness } = await ready([issue(1), issue(2)]);
    let release!: () => void;
    harness.script = [() => new Promise((resolve) => (release = () => resolve(discovered()())))];
    const working = t.app.work();
    await until(() => harness.runs.length === 1);
    void t.app.work(); // a second worker call claims nothing while an attempt is active
    expect((await jobFor(1)).state).toBe("running");
    expect((await jobFor(1)).phase).toBe("conventions");
    expect((await jobFor(2)).state).toBe("queued");
    release();
    await working;
    expect([(await jobFor(1)).state, (await jobFor(2)).state]).toEqual(["failed", "failed"]);
  });

  test("dispatches nothing until a harness is chosen", async () => {
    t = setup();
    t.github.repos.set(10, [repo(1)]);
    t.github.issues.set(1, [issue(1)]);
    await t.app.scan();
    await t.app.work();
    expect((await jobFor(1)).state).toBe("queued");
  });

  test("start and every scan tick dispatch queued jobs", async () => {
    const { harness } = await ready();
    harness.script = [discovered()];
    await t.app.start();
    await until(async () => (await jobFor(1)).state === "failed");
    await t.app.work();
    t.github.issues.get(1)!.push(issue(2, { updatedAt: "2026-01-01T00:00:30Z" }));
    await t.clock.advance(60_000);
    expect((await jobFor(2)).state).toBe("failed");
  });
});

describe("conventions", () => {
  test("are discovered once per repo and shown on the Repos page", async () => {
    const { harness } = await ready([issue(1), issue(2)]);
    harness.script = [discovered()];
    await t.app.work();
    expect(harness.runs).toHaveLength(1);
    expect((await jobFor(2)).attempts[0].phases).toEqual([]);
    expect(await t.json("/api/repos")).toEqual([
      { id: 1, full_name: "octo/app", discovered: CONVENTIONS, discovered_at: "2026-01-01T00:00:00.000Z", override: null },
    ]);
  });

  test("are re-discovered when CI or build files change, and reused otherwise", async () => {
    const { harness, remote } = await ready();
    harness.script = [discovered(), discovered({ ...CONVENTIONS, notes: "CI changed" }), discovered({ ...CONVENTIONS, notes: "build changed" })];
    await t.app.work();
    await commit(remote, { "README.md": "docs only", "src/a.ts": "code" });
    await addIssue(2);
    await t.app.work();
    expect(harness.runs).toHaveLength(1);
    await commit(remote, { ".github/workflows/ci.yml": "on: push" });
    await addIssue(3);
    await t.app.work();
    await commit(remote, { "package.json": '{"scripts":{}}' });
    await addIssue(4);
    await t.app.work();
    expect(harness.runs).toHaveLength(3);
    expect((await t.json("/api/repos"))[0].discovered.notes).toBe("build changed");
  });

  test("an override wins over discovery and can be cleared", async () => {
    const { harness } = await ready();
    harness.script = [discovered()];
    await t.app.work();
    const override = { ...CONVENTIONS, check_commands: [] };
    const res = await t.post("/api/repos/1/override", override, "PUT");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ discovered: CONVENTIONS, override });
    await addIssue(2);
    await t.app.work();
    expect((await jobFor(2)).state).toBe("skipped");
    expect((await jobFor(2)).skip_reason).toBe("no checks");
    expect(harness.runs).toHaveLength(1);

    expect((await t.post("/api/repos/1/override", null, "PUT")).status).toBe(200);
    await addIssue(3);
    await t.app.work();
    expect((await jobFor(3)).attempts[0].result).toContain("Pipeline ends here");
  });

  test("an override is used without discovering first", async () => {
    const { harness } = await ready();
    await t.post("/api/repos/1/override", CONVENTIONS, "PUT");
    await t.app.work();
    expect(harness.runs).toHaveLength(0);
    expect((await jobFor(1)).attempts[0].result).toContain("Pipeline ends here");
  });

  test("an invalid override is refused, as is an unknown repo", async () => {
    await ready();
    expect((await t.post("/api/repos/1/override", { ...CONVENTIONS, check_commands: "bun test" }, "PUT")).status).toBe(400);
    expect((await t.post("/api/repos/1/override", { ...CONVENTIONS, extra: 1 }, "PUT")).status).toBe(400);
    expect((await t.post("/api/repos/9/override", CONVENTIONS, "PUT")).status).toBe(404);
    expect((await t.json("/api/repos"))[0].override).toBeNull();
  });

  test("a repo with no discoverable checks and no override is skipped: no checks", async () => {
    const { harness } = await ready();
    harness.script = [discovered({ ...CONVENTIONS, check_commands: [] })];
    await t.app.work();
    expect(await jobFor(1)).toMatchObject({ state: "skipped", skip_reason: "no checks" });
  });
});

describe("harness errors", () => {
  for (const error of ["auth", "quota"] as const) {
    test(`${error} pauses dispatch with its reason, re-queues the job, and resumes after Test auth passes`, async () => {
      const { harness } = await ready([issue(1), issue(2)]);
      harness.script = [() => ({ ok: false, error, log: "stopped" })];
      await t.app.work();
      expect(harness.runs).toHaveLength(1);
      expect((await t.json("/api/setup")).paused).toContain(error === "auth" ? "log in" : "quota");
      const job = await jobFor(1);
      expect(job.state).toBe("queued");
      expect(job.attempts[0]).toMatchObject({ result: `conventions: ${error}`, phases: [{ outcome: error, log: "stopped" }] });
      expect((await jobFor(2)).state).toBe("queued");

      await t.post("/api/setup/test-auth");
      harness.script = [discovered()];
      await t.app.work();
      expect([(await jobFor(1)).state, (await jobFor(2)).state]).toEqual(["failed", "failed"]);
    });
  }

  for (const error of ["timeout", "bad_output", "crash"] as const) {
    test(`${error} fails the job naming the phase, and the queue moves on`, async () => {
      const { harness } = await ready([issue(1), issue(2)]);
      harness.script = [() => ({ ok: false, error, log: "x" }), discovered()];
      await t.app.work();
      expect(await jobFor(1)).toMatchObject({ state: "failed", attempts: [{ result: `conventions: ${error}` }] });
      expect((await t.json("/api/setup")).paused).toBeNull();
      expect((await jobFor(2)).attempts[0].result).toContain("Pipeline ends here");
    });
  }

  test("a checkout failure fails the job", async () => {
    const { harness } = await ready();
    t.github.remotes.clear();
    await t.app.work();
    expect(harness.runs).toHaveLength(0);
    expect(await jobFor(1)).toMatchObject({ state: "failed", attempts: [{ result: expect.stringContaining("checkout") }] });
  });
});

test("phase logs are redacted and capped at the last 200 KiB", async () => {
  const { harness } = await ready();
  const secrets = "token-1 ghs_16C7e42F292c6912E7710c838347Ae178B4a sk-ant-oat01-abc_DEF-123";
  harness.script = [discovered(CONVENTIONS, `${"x".repeat(300 * 1024)} ${secrets} END`)];
  await t.app.work();
  const { log } = (await jobFor(1)).attempts[0].phases[0];
  expect(log).toEndWith("END");
  expect(new TextEncoder().encode(log).length).toBeLessThanOrEqual(200 * 1024 + 100);
  for (const secret of secrets.split(" ")) expect(log).not.toContain(secret);
});

test("a restart fails the interrupted attempt and cleans up runners, so the queue moves on", async () => {
  const { harness } = await ready([issue(1), issue(2)]);
  harness.script = [() => new Promise(() => {})];
  void t.app.work();
  await until(() => harness.runs.length === 1);
  t.restart();
  expect(await jobFor(1)).toMatchObject({ state: "failed", attempts: [{ result: "Interrupted by a restart" }] });
  const cleanups = t.runner.cleanups;
  harness.script = [discovered()];
  await t.app.start();
  expect(t.runner.cleanups).toBeGreaterThan(cleanups);
  expect(existsSync(harness.runs[0]!.workspace)).toBe(false);
  await t.app.work();
  expect(harness.runs).toHaveLength(2);
  expect((await jobFor(2)).attempts[0].result).toContain("Pipeline ends here");
});
