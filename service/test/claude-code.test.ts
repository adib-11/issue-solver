import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCode } from "../src/claude-code";
import type { JsonSchema } from "../src/harness";

const TOKEN = "sk-ant-oat01-test-token";
const SCHEMA: JsonSchema = {
  type: "object",
  properties: { summary: { type: "string" }, tests: { type: "array", items: { type: "string" } } },
  required: ["summary", "tests"],
  additionalProperties: false,
};

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** The adapter wired to the fake CLI replaying one recording. */
function replaying(recording: string, token = TOKEN) {
  dir = mkdtempSync(join(tmpdir(), "claude-code-"));
  const capture = join(dir, "capture.json");
  const command = [process.execPath, join(import.meta.dir, "fake-cli.ts"), join(import.meta.dir, "recordings/claude-code", `${recording}.json`), capture];
  const harness = claudeCode({ token, command });
  const run = (timeoutMs = 5000) => harness.run({ prompt: "Fix issue #7:\n$(rm -rf ~) `id`", schema: SCHEMA, workspace: dir, timeoutMs });
  const received = async () => (await Bun.file(capture).json()) as { args: string[]; stdin: string; env: Record<string, string>; cwd: string };
  return { harness, run, received };
}

test("sends the prompt on stdin in print mode with the JSON Schema, from the workspace", async () => {
  const { run, received } = replaying("success");
  await run();
  const cli = await received();
  expect(cli.stdin).toBe("Fix issue #7:\n$(rm -rf ~) `id`");
  expect(cli.args).toContain("-p");
  expect(cli.args.slice(cli.args.indexOf("--output-format"))[1]).toBe("stream-json");
  expect(JSON.parse(cli.args[cli.args.indexOf("--json-schema") + 1]!)).toEqual(SCHEMA);
  expect(cli.args.join(" ")).not.toContain("Fix issue");
  expect(cli.cwd).toEndWith(dir.split("/").pop()!);
});

test("runs the CLI under the runner's command prefix", async () => {
  const { harness, received } = replaying("success");
  await harness.run({ prompt: "x", schema: SCHEMA, workspace: dir, timeoutMs: 5000, wrap: ["env", "WRAPPED=1"] });
  expect((await received()).env.WRAPPED).toBe("1");
});

test("authenticates with the subscription token only: no bare mode, no API key", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-api03-must-not-leak";
  process.env.ANTHROPIC_AUTH_TOKEN = "must-not-leak";
  try {
    const { run, received } = replaying("success");
    await run();
    const cli = await received();
    expect(cli.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
    expect(cli.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(cli.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(cli.args).not.toContain("--bare");
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  }
});

test("returns the structured output field and the log", async () => {
  const result = await replaying("success").run();
  expect(result).toMatchObject({ ok: true, output: { summary: "Adds a --dry-run flag", tests: ["test/cli.test.ts"] } });
  expect(result.log).toContain('"type":"result"');
});

test("output that does not match the schema is bad_output, even when the CLI accepted it", async () => {
  expect(await replaying("schema-mismatch").run()).toMatchObject({ ok: false, error: "bad_output" });
});

test("a result with no structured output is bad_output", async () => {
  expect(await replaying("no-structured-output").run()).toMatchObject({ ok: false, error: "bad_output" });
});

test("the CLI giving up on its own schema retries is bad_output", async () => {
  expect(await replaying("schema-retries-exhausted").run()).toMatchObject({ ok: false, error: "bad_output" });
});

test("a typed error the CLI recovered from does not fail a successful run", async () => {
  expect(await replaying("retried-rate-limit").run()).toMatchObject({ ok: true });
});

test("an unknown error category is a crash", async () => {
  expect(await replaying("unknown-error").run()).toMatchObject({ ok: false, error: "crash" });
});

test("classifies typed stream-json errors", async () => {
  expect(await replaying("rate-limit").run()).toMatchObject({ ok: false, error: "quota" });
  expect(await replaying("billing").run()).toMatchObject({ ok: false, error: "quota" });
  const auth = await replaying("auth-failed").run();
  expect(auth).toMatchObject({ ok: false, error: "auth" });
  expect(auth.log).toContain("Please run /login");
});

test("a run over its time limit is killed and reported as timeout", async () => {
  const started = Date.now();
  expect(await replaying("hang").run(300)).toMatchObject({ ok: false, error: "timeout" });
  expect(Date.now() - started).toBeLessThan(5000);
});

test("the timeout fires even when a leftover subprocess keeps the output open", async () => {
  const started = Date.now();
  expect(await replaying("orphan").run(300)).toMatchObject({ ok: false, error: "timeout" });
  expect(Date.now() - started).toBeLessThan(5000);
});

test("an untyped failure is a crash, with the token redacted from the log", async () => {
  const result = await replaying("crash").run();
  expect(result).toMatchObject({ ok: false, error: "crash" });
  expect(result.log).toContain("unexpected failure");
  expect(result.log).not.toContain(TOKEN);
});

test("with no token configured, run and the auth check report auth without starting the CLI", async () => {
  const { harness } = replaying("success", "");
  expect(await harness.run({ prompt: "x", schema: SCHEMA, workspace: dir, timeoutMs: 5000 })).toMatchObject({ ok: false, error: "auth" });
  expect((await harness.checkAuth()).state).toBe("auth");
  expect(await Bun.file(join(dir, "capture.json")).exists()).toBe(false);
});

test("the auth check maps a run to ok, auth, or quota, and anything else to error", async () => {
  expect((await replaying("rate-limit").harness.checkAuth()).state).toBe("quota");
  expect((await replaying("auth-failed").harness.checkAuth()).state).toBe("auth");
  expect((await replaying("success").harness.checkAuth()).state).toBe("ok");
  expect((await replaying("crash").harness.checkAuth()).state).toBe("error");
});

test("has login help naming claude setup-token and the token variable", () => {
  const { harness } = replaying("success");
  expect(harness.loginHelp).toContain("claude setup-token");
  expect(harness.loginHelp).toContain("CLAUDE_CODE_OAUTH_TOKEN");
});
