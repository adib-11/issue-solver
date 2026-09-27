import { $ } from "bun";
import { rmSync } from "node:fs";
import type { CommandRun, CommandRuns, Conventions } from "./jobs";
import type { Sandbox, SandboxRun } from "./runner";

export const CHECKS_TIMEOUT_MS = 15 * 60_000;
const TAIL_CHARS = 2000;

/** A controller phase's result: error is why the attempt fails ("timeout" at the deadline), or null. */
export type Verified = { output: CommandRuns; log: string; error: string | null };

const tail = (log: string) => (log.length > TAIL_CHARS ? `…${log.slice(-TAIL_CHARS)}` : log).trimEnd();
const quote = (path: string) => (/^[\w./-]+$/.test(path) ? path : `'${path.replaceAll("'", `'\\''`)}'`);
const failed = ({ command, exitCode, log }: SandboxRun, how = `exited ${exitCode}`) => `\`${command}\` ${how}:\n${tail(log)}`;

/**
 * Runs setup and commands in the sandbox on a fresh clone of the workspace at sha, with the overlay's files taken
 * from its commit. The sandbox never sees the workspace itself, so a check cannot tamper with the checkout.
 */
async function inSandbox(
  sandbox: Sandbox,
  workspace: string,
  on: CommandRun["on"],
  sha: string,
  setup: string,
  commands: string[],
  overlay?: { sha: string; files: string[] },
) {
  const dir = `${workspace}-check`;
  rmSync(dir, { recursive: true, force: true });
  try {
    await $`git clone -q --no-checkout ${workspace} ${dir} && git -C ${dir} checkout -q --detach ${sha}`.quiet();
    if (overlay) await $`git -C ${dir} checkout -q ${overlay.sha} -- ${overlay.files}`.quiet();
    const { runs, timedOut } = await sandbox.run(dir, setup, commands, CHECKS_TIMEOUT_MS);
    return {
      runs,
      timedOut,
      output: runs.map(({ command, exitCode }) => ({ on, command, exit_code: exitCode })),
      log: runs.map(({ command, exitCode, log }) => `$ ${command}  (on ${on})\n${log}\n[exit ${exitCode}]\n`).join("") + (timedOut ? `[timed out]\n` : ""),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Proves each new test fails on base (with the new test files overlaid) and passes on head: through the
 * single-test-file command when there is one, else the full check on base, whose passing on head the checks prove.
 * Failing to compile on base counts as red.
 */
export async function redGreen(sandbox: Sandbox, workspace: string, base: string, head: string, conventions: Conventions, testFiles: string[]): Promise<Verified> {
  if (!conventions.has_tests) return { output: { runs: [], skipped: "the repo has no tests, so there are no new tests to prove" }, log: "", error: null };
  const files = [...new Set(testFiles)];
  const { setup_command: setup, test_file_command: template } = conventions;
  const commands = template ? files.map((f) => template.replaceAll("{file}", quote(f))) : conventions.check_commands;
  const red = await inSandbox(sandbox, workspace, "base", base, setup, commands, { sha: head, files });
  const result = (error: string | null, green?: typeof red): Verified => ({
    output: { runs: [...red.output, ...(green?.output ?? [])] },
    log: red.log + (green?.log ?? ""),
    error,
  });
  if (red.timedOut) return result("timeout");
  // Setup can compile the overlaid tests; failing there is failing to compile, so every new test is red.
  const setupFailed = !!setup && red.runs[0]!.exitCode !== 0;
  const tests = red.runs.slice(setup ? 1 : 0);
  if (!template) return result(setupFailed || tests.some((r) => r.exitCode) ? null : "tautological tests: every check passes on base with the new test files");
  const passing = tests.find((r) => !r.exitCode);
  if (passing) return result(`tautological test: \`${passing.command}\` passes on base`);

  const green = await inSandbox(sandbox, workspace, "head", head, setup, commands);
  if (green.timedOut) return result("timeout", green);
  const broken = green.runs.find((r) => r.exitCode);
  if (!broken) return result(null, green);
  return result(failed(broken, setup && broken === green.runs[0] ? `exited ${broken.exitCode} on head` : "fails on the change"), green);
}

/** Runs setup and every check command on head; any non-zero exit fails. */
export async function checks(sandbox: Sandbox, workspace: string, head: string, conventions: Conventions): Promise<Verified> {
  const { runs, timedOut, output, log } = await inSandbox(sandbox, workspace, "head", head, conventions.setup_command, conventions.check_commands);
  const broken = runs.find((r) => r.exitCode);
  return { output: { runs: output }, log, error: timedOut ? "timeout" : broken ? failed(broken) : null };
}
