import { $ } from "bun";
import { basename } from "node:path";

/** Where agent phases run. Tests replace this with a fake. */
export interface Runner {
  /** The command prefix that runs a CLI in a fresh runner container with this workspace as its working directory. */
  command(workspace: string): string[];
  /** Removes every runner container, finished or not. */
  cleanup(): Promise<void>;
}

// ponytail: one label for every runner on the Docker host; scope it per controller if two ever share a daemon.
const LABEL = "auto-solve.runner";

/**
 * Disposable nonroot Docker containers with the workspace (a directory on the workspaces volume) mounted at /work.
 * Only the variables named here reach the container, and no socket or host path is mounted.
 */
export function dockerRunner(options: { image: string; volume: string; env: string[] }): Runner {
  return {
    command: (workspace) => [
      "docker", "run", "--rm", "-i", "--label", LABEL,
      "--user", "1000:1000",
      "--cpus", "2", "--memory", "4g", "--memory-swap", "4g", "--pids-limit", "256",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--mount", `type=volume,src=${options.volume},dst=/work,volume-subpath=${basename(workspace)}`,
      "--workdir", "/work",
      // Names without values: docker copies them from its own environment, keeping secrets off the command line.
      ...options.env.flatMap((name) => ["--env", name]),
      options.image,
    ],
    async cleanup() {
      const ids = (await $`docker ps -aq --filter label=${LABEL}`.text()).split("\n").filter(Boolean);
      if (ids.length) await $`docker rm -f ${ids}`.quiet();
    },
  };
}
