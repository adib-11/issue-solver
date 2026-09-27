// Opt-in smoke test, never run in CI: runs the real Claude Code CLI through the conventions phase on a
// throwaway repo of yours. It needs your subscription token, so it spends real quota.
// Usage: CLAUDE_CODE_OAUTH_TOKEN=... bun scripts/smoke-conventions.ts <git clone URL>
import { $ } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCode } from "../src/claude-code";
import { CONVENTIONS_PROMPT, CONVENTIONS_SCHEMA, CONVENTIONS_TIMEOUT_MS } from "../src/conventions";

const url = process.argv[2];
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
if (!url || !token) {
  console.error("Usage: CLAUDE_CODE_OAUTH_TOKEN=... bun scripts/smoke-conventions.ts <git clone URL>");
  process.exit(2);
}

const workspace = mkdtempSync(join(tmpdir(), "smoke-conventions-"));
try {
  await $`git -c core.hooksPath=/dev/null clone -q ${url} ${workspace}`;
  await $`git -C ${workspace} config core.hooksPath /dev/null`;
  const harness = claudeCode({ token, command: [join(import.meta.dir, "../node_modules/.bin/claude")] });
  const result = await harness.run({ prompt: CONVENTIONS_PROMPT, schema: CONVENTIONS_SCHEMA, workspace, timeoutMs: CONVENTIONS_TIMEOUT_MS });
  if (!result.ok) {
    console.error(`conventions: ${result.error}\n${result.log.slice(-4000)}`);
    process.exit(1);
  }
  console.log(JSON.stringify(result.output, null, 2));
  const status = (await $`git -C ${workspace} status --porcelain`.text()).trim();
  if (status) {
    console.error(`The agent changed files, which it must not:\n${status}`);
    process.exit(1);
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
