import { tmpdir } from "node:os";
import { type Harness, type RunError, type RunOptions, type RunResult, schemaError } from "./harness";

// Typed error categories on stream-json assistant messages.
const TYPED_ERRORS: Record<string, RunError> = { rate_limit: "quota", billing_error: "quota", authentication_failed: "auth" };
const AUTH_CHECK_TIMEOUT_MS = 120_000;

const LOGIN_HELP = `Claude Code runs on your Claude subscription through a long-lived OAuth token. It never uses an API key.

1. On any machine with a browser, install Claude Code and run: claude setup-token
2. Sign in with the Claude account whose subscription the service should use, and copy the printed token.
3. Put it in .env as CLAUDE_CODE_OAUTH_TOKEN=<token>, then run: docker compose up -d
4. Click Test auth.

The token lasts one year. Repeat these steps before it expires.`;

/**
 * Claude Code in non-interactive print mode. Only the subscription OAuth token reaches the CLI: the child
 * environment is built from scratch, so an ANTHROPIC_API_KEY on the host can never be used. Bare mode is
 * never used, because it ignores the OAuth token. The CLI refuses to skip permissions as root, so the
 * service runs as a nonroot user.
 */
export function claudeCode(options: { token?: string; command?: string[] }): Harness {
  const { token, command = ["claude"] } = options;
  const redact = (log: string) => (token ? log.replaceAll(token, "[redacted]") : log);

  async function run({ prompt, schema, workspace, timeoutMs }: RunOptions): Promise<RunResult> {
    if (!token) return { ok: false, error: "auth", log: "CLAUDE_CODE_OAUTH_TOKEN is not set." };
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--json-schema", JSON.stringify(schema), "--dangerously-skip-permissions"];
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn([...command, ...args], {
        cwd: workspace,
        stdin: new Blob([prompt]),
        stdout: "pipe",
        stderr: "pipe",
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", CLAUDE_CODE_OAUTH_TOKEN: token },
      });
    } catch (err) {
      return { ok: false, error: "crash", log: `Could not start ${command.join(" ")}: ${(err as Error).message}` };
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutMs);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ]);
    clearTimeout(timer);

    const log = redact(stderr ? `${stdout}\n--- stderr ---\n${stderr}` : stdout);
    if (timedOut) return { ok: false, error: "timeout", log: `${log}\nKilled after ${timeoutMs} ms.` };
    const events = stdout.split("\n").flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
    const typed = events.map((e) => TYPED_ERRORS[e?.error]).find(Boolean);
    if (typed) return { ok: false, error: typed, log };
    const result = events.findLast((e) => e?.type === "result");
    if (!result || result.is_error || exitCode !== 0) return { ok: false, error: "crash", log };
    const invalid = "structured_output" in result ? schemaError(schema, result.structured_output) : "no structured_output in the result";
    if (invalid) return { ok: false, error: "bad_output", log: `${log}\nOutput rejected: ${invalid}` };
    return { ok: true, output: result.structured_output, log };
  }

  return {
    name: "claude-code",
    label: "Claude Code",
    loginHelp: LOGIN_HELP,
    credential: token,
    run,
    async checkAuth() {
      const result = await run({ prompt: "Reply with an empty JSON object.", schema: { type: "object" }, workspace: tmpdir(), timeoutMs: AUTH_CHECK_TIMEOUT_MS });
      if (result.ok) return { state: "ok", log: result.log };
      return { state: result.error === "auth" || result.error === "quota" ? result.error : "error", log: result.log };
    },
  };
}
