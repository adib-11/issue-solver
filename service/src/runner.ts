import { $ } from "bun";
import { basename } from "node:path";
import { runCli } from "./harness";

/** Where agent phases run. Tests replace this with a fake. */
export interface Runner {
  /** The command prefix that runs the harness's CLI in a fresh runner container with this workspace as its working directory. */
  command(workspace: string, harness: string): string[];
  /** Removes every runner container, finished or not. */
  cleanup(): Promise<void>;
}

export type SandboxRun = { command: string; exitCode: number; log: string };

/** Where setup, check, and test commands run. Tests replace this with a fake. */
export interface Sandbox {
  /**
   * In one fresh container with no credentials and dir as its working directory, runs setup (unless "") and then
   * every command, stopping early only when setup fails. At the deadline it stops with timedOut.
   */
  run(dir: string, setup: string, commands: string[], timeoutMs: number): Promise<{ runs: SandboxRun[]; timedOut: boolean }>;
}

// ponytail: one label for every runner on the Docker host; scope it per controller if two ever share a daemon.
const LABEL = "auto-solve.runner";
const LIMITS = ["--user", "1000:1000", "--cpus", "2", "--memory", "4g", "--memory-swap", "4g", "--pids-limit", "256", "--cap-drop", "ALL", "--security-opt", "no-new-privileges"];
const workMount = (volume: string, dir: string) => ["--mount", `type=volume,src=${volume},dst=/work,volume-subpath=${basename(dir)}`, "--workdir", "/work"];

/** Starts an idle sandbox container: the runner's limits and dir at /work, and no variables or other mounts at all. */
export const sandboxCommand = (image: string, volume: string, dir: string, name: string) => [
  "docker", "run", "-d", "--rm", "--name", name, "--label", LABEL, ...LIMITS, ...workMount(volume, dir), "--entrypoint", "sleep", image, "infinity",
];

// ponytail: checks run in the runner image, so only toolchains it carries (bun, git); a per-repo image if others are needed.
export function dockerSandbox(options: { image: string; volume: string }): Sandbox {
  return {
    async run(dir, setup, commands, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      const name = `auto-solve-check-${basename(dir)}`;
      await $`${sandboxCommand(options.image, options.volume, dir, name)}`.quiet();
      const runs: SandboxRun[] = [];
      try {
        for (const [i, command] of [setup, ...commands].entries()) {
          if (!command) continue;
          const argv = ["docker", "exec", name, "sh", "-c", `exec 2>&1\n${command}`];
          const result = await runCli(argv, { cwd: "/", stdin: "", env: process.env as Record<string, string>, timeoutMs: deadline - Date.now() });
          if ("timeout" in result) return { runs, timedOut: true };
          if ("startError" in result) throw new Error(result.startError);
          runs.push({ command, exitCode: result.exitCode, log: result.stdout + result.stderr });
          if (i === 0 && result.exitCode) break;
        }
        return { runs, timedOut: false };
      } finally {
        await $`docker rm -f ${name}`.quiet().nothrow();
      }
    },
  };
}

/** What a harness's runner containers get on top of the workspace: variable names and --mount specs. */
export type RunnerAccess = { env?: string[]; mounts?: string[] };

/**
 * Disposable nonroot Docker containers with the workspace (a directory on the workspaces volume) mounted at /work.
 * Only the chosen harness's own variables and mounts reach the container, and no socket or host path is mounted.
 */
export function dockerRunner(options: { image: string; volume: string; access: Record<string, RunnerAccess> }): Runner {
  return {
    command: (workspace, harness) => [
      "docker", "run", "--rm", "-i", "--label", LABEL, ...LIMITS, ...workMount(options.volume, workspace),
      // Names without values: docker copies them from its own environment, keeping secrets off the command line.
      ...(options.access[harness]?.env ?? []).flatMap((name) => ["--env", name]),
      ...(options.access[harness]?.mounts ?? []).flatMap((spec) => ["--mount", spec]),
      options.image,
    ],
    async cleanup() {
      const ids = (await $`docker ps -aq --filter label=${LABEL}`.text()).split("\n").filter(Boolean);
      if (ids.length) await $`docker rm -f ${ids}`.quiet();
    },
  };
}
