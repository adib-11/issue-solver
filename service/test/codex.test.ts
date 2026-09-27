import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codex } from "../src/codex";
import type { JsonSchema } from "../src/harness";

const SCHEMA: JsonSchema = {
  type: "object",
  properties: { summary: { type: "string" }, tests: { type: "array", items: { type: "string" } } },
  required: ["summary", "tests"],
  additionalProperties: false,
};

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** The adapter wired to the fake CLI replaying one recording, with a logged-in Codex home unless loggedIn is false. */
function replaying(recording: string, loggedIn = true) {
  dir = mkdtempSync(join(tmpdir(), "codex-"));
  const home = join(dir, "codex-home");
  const workspace = join(dir, "work");
  mkdirSync(join(workspace, ".git"), { recursive: true });
  mkdirSync(home);
  if (loggedIn) writeFileSync(join(home, "auth.json"), "{}", { mode: 0o600 });
  const capture = join(dir, "capture.json");
  const command = [process.execPath, join(import.meta.dir, "fake-cli.ts"), join(import.meta.dir, "recordings/codex", `${recording}.json`), capture];
  const harness = codex({ home, command });
  const run = (timeoutMs = 5000) => harness.run({ prompt: "Fix issue #7:\n$(rm -rf ~) `id`", schema: SCHEMA, workspace, timeoutMs });
  const received = async () => (await Bun.file(capture).json()) as { args: string[]; stdin: string; env: Record<string, string>; cwd: string };
  return { harness, run, received, home, workspace };
}

const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
const configs = (args: string[]) => args.flatMap((a, i) => (args[i - 1] === "-c" ? [a] : []));

test("runs codex exec with the prompt on stdin, never approving and with full access, from the workspace", async () => {
  const { run, received, workspace } = replaying("success");
  await run();
  const cli = await received();
  expect(cli.args[0]).toBe("exec");
  expect(cli.args.at(-1)).toBe("-");
  expect(cli.stdin).toBe("Fix issue #7:\n$(rm -rf ~) `id`");
  expect(cli.args.join(" ")).not.toContain("Fix issue");
  expect(after(cli.args, "--sandbox")).toBe("danger-full-access");
  expect(configs(cli.args)).toContain('approval_policy="never"');
  expect(cli.cwd).toEndWith(workspace.split("/").slice(-2).join("/"));
});

test("passes the JSON Schema as an output schema file inside the workspace's .git, so the checkout stays clean", async () => {
  const { run, received, workspace } = replaying("success");
  await run();
  const path = after((await received()).args, "--output-schema")!;
  expect(path.startsWith("/")).toBe(false);
  expect(path.startsWith(".git/")).toBe(true);
  expect(await Bun.file(join(workspace, path)).json()).toEqual(SCHEMA);
});

test("runs the CLI under the runner's command prefix", async () => {
  const { harness, received, workspace } = replaying("success");
  await harness.run({ prompt: "x", schema: SCHEMA, workspace, timeoutMs: 5000, wrap: ["env", "WRAPPED=1"] });
  expect((await received()).env.WRAPPED).toBe("1");
});

test("logs in with the ChatGPT file credentials in its Codex home only: no API key path", async () => {
  process.env.OPENAI_API_KEY = "sk-proj-must-not-leak";
  process.env.CODEX_API_KEY = "must-not-leak";
  try {
    const { run, received, home } = replaying("success");
    await run();
    const cli = await received();
    expect(cli.env.CODEX_HOME).toBe(home);
    expect(cli.env.OPENAI_API_KEY).toBeUndefined();
    expect(cli.env.CODEX_API_KEY).toBeUndefined();
    expect(configs(cli.args)).toEqual(expect.arrayContaining(['cli_auth_credentials_store="file"', 'forced_login_method="chatgpt"']));
    expect(cli.args).toContain("--ignore-user-config");
  } finally {
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_API_KEY;
  }
});

test("returns the final message parsed as JSON, and the log", async () => {
  const result = await replaying("success").run();
  expect(result).toMatchObject({ ok: true, output: { summary: "Adds a --dry-run flag", tests: ["test/cli.test.ts"] } });
  expect(result.log).toContain("sandbox: danger-full-access");
});

test("output that does not match the schema is bad_output", async () => {
  expect(await replaying("schema-mismatch").run()).toMatchObject({ ok: false, error: "bad_output" });
});

test("a final message that is not JSON is bad_output", async () => {
  expect(await replaying("not-json").run()).toMatchObject({ ok: false, error: "bad_output" });
});

test("a failed run with a 429 in stderr is quota", async () => {
  expect(await replaying("usage-limit").run()).toMatchObject({ ok: false, error: "quota" });
});

test("a 429 the CLI retried past does not fail a successful run", async () => {
  expect(await replaying("retried-429").run()).toMatchObject({ ok: true });
});

test("an auth failure is auth", async () => {
  const result = await replaying("auth-failed").run();
  expect(result).toMatchObject({ ok: false, error: "auth" });
  expect(result.log).toContain("refresh token has expired");
});

test("any other failure is a crash", async () => {
  expect(await replaying("crash").run()).toMatchObject({ ok: false, error: "crash" });
});

test("a run over its time limit is killed and reported as timeout", async () => {
  const started = Date.now();
  expect(await replaying("hang").run(300)).toMatchObject({ ok: false, error: "timeout" });
  expect(Date.now() - started).toBeLessThan(5000);
});

test("never uses the credentials concurrently: runs and auth checks wait their turn", async () => {
  const { harness, workspace } = replaying("slow");
  const started = Date.now();
  const results = await Promise.all([
    harness.run({ prompt: "x", schema: SCHEMA, workspace, timeoutMs: 5000 }),
    harness.run({ prompt: "x", schema: SCHEMA, workspace, timeoutMs: 5000 }),
    harness.checkAuth(),
  ]);
  expect(Date.now() - started).toBeGreaterThanOrEqual(1200);
  expect(results.map((r) => ("ok" in r ? r.ok : r.state))).toEqual([true, true, "ok"]);
});

test("a failed run does not block the next one", async () => {
  const { harness, workspace } = replaying("crash");
  await harness.run({ prompt: "x", schema: SCHEMA, workspace, timeoutMs: 5000 });
  expect(await harness.run({ prompt: "x", schema: SCHEMA, workspace, timeoutMs: 5000 })).toMatchObject({ ok: false, error: "crash" });
});

test("when nobody has logged in, run and the auth check report auth without starting the CLI", async () => {
  const { harness, workspace } = replaying("success", false);
  expect(await harness.run({ prompt: "x", schema: SCHEMA, workspace, timeoutMs: 5000 })).toMatchObject({ ok: false, error: "auth" });
  expect((await harness.checkAuth()).state).toBe("auth");
  expect(await Bun.file(join(dir, "capture.json")).exists()).toBe(false);
});

test("the auth check maps a run to ok, auth, or quota, and anything else to error", async () => {
  expect((await replaying("usage-limit").harness.checkAuth()).state).toBe("quota");
  expect((await replaying("auth-failed").harness.checkAuth()).state).toBe("auth");
  expect((await replaying("success").harness.checkAuth()).state).toBe("ok");
  expect((await replaying("crash").harness.checkAuth()).state).toBe("error");
});

test("has login help naming the device login through the runner image", () => {
  const { harness } = replaying("success");
  expect(harness.loginHelp).toContain("codex");
  expect(harness.loginHelp).toContain("login --device-auth");
  expect(harness.loginHelp).toContain("auto-solve-runner:local");
  expect(harness.loginHelp).toContain('forced_login_method="chatgpt"');
});
