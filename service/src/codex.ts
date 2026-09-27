import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Harness, type RunOptions, type RunResult, runCli, schemaError } from "./harness";

const AUTH_CHECK_TIMEOUT_MS = 120_000;
// Relative to the workspace, so the same path works from the controller and inside the runner (/work).
// Inside .git, so the agent's checkout stays clean.
const SCHEMA_FILE = ".git/auto-solve-output-schema.json";
// Set on every run and login, as OpenAI's CI/CD guidance for ChatGPT login asks: credentials live in auth.json only.
const AUTH_CONFIG = ['cli_auth_credentials_store="file"', 'forced_login_method="chatgpt"'];
const AUTH_FAILURE = /\b401\b|unauthorized|not logged in|log ?in again|sign in again|refresh token|token (has )?expired|forced_login_method/i;

const LOGIN_HELP = `Codex runs on your ChatGPT subscription, logged in once with a device code. It never uses an API key.

1. Run docker compose up -d once, so the runner image and the auto-solve-codex volume exist.
2. On the host, run:
   docker run --rm -it --mount type=volume,src=auto-solve-codex,dst=/codex -e CODEX_HOME=/codex auto-solve-runner:local codex login --device-auth -c 'cli_auth_credentials_store="file"' -c 'forced_login_method="chatgpt"'
3. Open the link it prints, sign in with the ChatGPT account whose subscription the service should use, and enter the code.
4. Click Test auth.

The login is saved as auth.json (mode 0600) on the auto-solve-codex volume and refreshed there in place. Do not copy it elsewhere or use it from another machine at the same time. If Test auth reports auth, repeat step 2.`;

/**
 * Codex in non-interactive exec mode, logged in with ChatGPT. The child environment is built from scratch and
 * the user config is ignored, so an OPENAI_API_KEY or CODEX_API_KEY on the host can never be used. Codex runs
 * without its own sandbox or approvals: the runner container is the sandbox.
 */
export function codex(options: { home: string; command?: string[] }): Harness {
  const { home, command = ["codex"] } = options;
  // A refresh rewrites auth.json in place, so two runs at once could each spend the same refresh token.
  let turn: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = turn.then(fn, fn);
    turn = next.catch(() => {});
    return next;
  };

  async function runOnce({ prompt, schema, workspace, timeoutMs, wrap = [] }: RunOptions): Promise<RunResult> {
    if (!existsSync(join(home, "auth.json"))) return { ok: false, error: "auth", log: `Codex is not logged in: no auth.json in ${home}.` };
    mkdirSync(join(workspace, ".git"), { recursive: true });
    writeFileSync(join(workspace, SCHEMA_FILE), JSON.stringify(schema));
    const args = [
      "exec", "--sandbox", "danger-full-access", "-c", 'approval_policy="never"',
      ...AUTH_CONFIG.flatMap((c) => ["-c", c]),
      "--ignore-user-config", "--ephemeral", "--skip-git-repo-check", "--color", "never",
      "--output-schema", SCHEMA_FILE, "-",
    ];
    const ran = await runCli([...wrap, ...command, ...args], {
      cwd: workspace,
      stdin: prompt,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", CODEX_HOME: home },
      timeoutMs,
    });
    if ("startError" in ran) return { ok: false, error: "crash", log: ran.startError };
    if ("timeout" in ran) return { ok: false, error: "timeout", log: `Killed after ${timeoutMs} ms.` };
    const { stdout, stderr, exitCode } = ran;

    // Codex streams its activity to stderr and prints only the final message to stdout.
    const log = `${stderr}\n--- final message ---\n${stdout}`;
    if (exitCode !== 0) {
      if (/\b429\b/.test(stderr)) return { ok: false, error: "quota", log };
      return { ok: false, error: AUTH_FAILURE.test(stderr) ? "auth" : "crash", log };
    }
    let output: unknown;
    try {
      output = JSON.parse(stdout);
    } catch {
      return { ok: false, error: "bad_output", log: `${log}\nOutput rejected: the final message is not JSON` };
    }
    const invalid = schemaError(schema, output);
    if (invalid) return { ok: false, error: "bad_output", log: `${log}\nOutput rejected: ${invalid}` };
    return { ok: true, output, log };
  }

  const run = (options: RunOptions) => oneAtATime(() => runOnce(options));

  return {
    name: "codex",
    label: "Codex",
    loginHelp: LOGIN_HELP,
    run,
    async checkAuth() {
      const workspace = mkdtempSync(join(tmpdir(), "codex-auth-"));
      try {
        const result = await run({ prompt: "Reply with an empty JSON object.", schema: { type: "object" }, workspace, timeoutMs: AUTH_CHECK_TIMEOUT_MS });
        if (result.ok) return { state: "ok", log: result.log };
        return { state: result.error === "auth" || result.error === "quota" ? result.error : "error", log: result.log };
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    },
  };
}
