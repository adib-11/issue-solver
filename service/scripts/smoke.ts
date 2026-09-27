// Opt-in smoke test, never run in CI: runs a real harness CLI through the conventions and brief phases on an
// issue of a throwaway repo of yours. It uses your subscription, so it spends real quota, and the GitHub CLI
// (gh), logged in, to clone the repo and read the issue.
// Usage: CLAUDE_CODE_OAUTH_TOKEN=... bun scripts/smoke.ts <owner/repo> <issue number>
//    or: CODEX_HOME=<dir with a ChatGPT-login auth.json> bun scripts/smoke.ts --codex <owner/repo> <issue number>
import { $ } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIEF_SCHEMA, BRIEF_TIMEOUT_MS, briefError, briefPrompt } from "../src/brief";
import { claudeCode } from "../src/claude-code";
import { codex } from "../src/codex";
import { CONVENTIONS_PROMPT, CONVENTIONS_SCHEMA, CONVENTIONS_TIMEOUT_MS } from "../src/conventions";
import type { RunOptions } from "../src/harness";
import { type Conventions, type IssueSnapshot, TRUSTED_AUTHORS } from "../src/jobs";

const args = process.argv.slice(2);
const useCodex = args[0] === "--codex";
const [repo, number] = useCodex ? args.slice(1) : args;
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const codexHome = process.env.CODEX_HOME;
if (!repo || !number || !(useCodex ? codexHome : token)) {
  console.error("Usage: CLAUDE_CODE_OAUTH_TOKEN=... bun scripts/smoke.ts <owner/repo> <issue number>");
  console.error("   or: CODEX_HOME=... bun scripts/smoke.ts --codex <owner/repo> <issue number>");
  process.exit(2);
}

const workspace = mkdtempSync(join(tmpdir(), "smoke-"));
const bin = (name: string) => [join(import.meta.dir, "../node_modules/.bin", name)];
const harness = useCodex ? codex({ home: codexHome!, command: bin("codex") }) : claudeCode({ token, command: bin("claude") });

async function phase(name: string, options: Omit<RunOptions, "workspace">) {
  const result = await harness.run({ ...options, workspace });
  if (!result.ok) {
    console.error(`${name}: ${result.error}\n${result.log.slice(-4000)}`);
    process.exit(1);
  }
  console.log(`--- ${name} ---\n${JSON.stringify(result.output, null, 2)}`);
  const status = (await $`git -C ${workspace} status --porcelain`.text()).trim();
  if (status) {
    console.error(`The agent changed files in ${name}, which it must not:\n${status}`);
    process.exit(1);
  }
  return result.output;
}

try {
  await $`gh repo clone ${repo} ${workspace} -- -q -c core.hooksPath=/dev/null`;
  await $`git -C ${workspace} config core.hooksPath /dev/null`;
  const raw = await $`gh issue view ${number} --repo ${repo} --json number,title,url,state,body,comments`.json();
  const issue: IssueSnapshot = {
    ...raw,
    comments: raw.comments
      .filter((c: any) => TRUSTED_AUTHORS.includes(c.authorAssociation))
      .map((c: any) => ({ author: c.author.login, authorAssociation: c.authorAssociation, body: c.body })),
  };

  const conventions = (await phase("conventions", { prompt: CONVENTIONS_PROMPT, schema: CONVENTIONS_SCHEMA, timeoutMs: CONVENTIONS_TIMEOUT_MS })) as Conventions;
  const brief = await phase("brief", { prompt: briefPrompt(issue, conventions), schema: BRIEF_SCHEMA, timeoutMs: BRIEF_TIMEOUT_MS });
  const invalid = briefError(brief);
  if (invalid) {
    console.error(`brief: bad_output: ${invalid}`);
    process.exit(1);
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
