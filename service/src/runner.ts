import { $ } from "bun";
import { basename } from "node:path";

/** Where agent phases run. Tests replace this with a fake. */
export interface Runner {
  /** The command prefix that runs the harness's CLI in a fresh runner container with this workspace as its working directory. */
  command(workspace: string, harness: string): string[];
  /** Removes every runner container, finished or not. */
  cleanup(): Promise<void>;
}

// ponytail: one label for every runner on the Docker host; scope it per controller if two ever share a daemon.
const LABEL = "auto-solve.runner";

/** What a harness's runner containers get on top of the workspace: variable names and --mount specs. */
export type RunnerAccess = { env?: string[]; mounts?: string[] };

/**
 * Disposable nonroot Docker containers with the workspace (a directory on the workspaces volume) mounted at /work.
 * Only the chosen harness's own variables and mounts reach the container, and no socket or host path is mounted.
 */
export function dockerRunner(options: { image: string; volume: string; access: Record<string, RunnerAccess> }): Runner {
  return {
    command: (workspace, harness) => [
      "docker", "run", "--rm", "-i", "--label", LABEL,
      "--user", "1000:1000",
      "--cpus", "2", "--memory", "4g", "--memory-swap", "4g", "--pids-limit", "256",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--mount", `type=volume,src=${options.volume},dst=/work,volume-subpath=${basename(workspace)}`,
      "--workdir", "/work",
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
