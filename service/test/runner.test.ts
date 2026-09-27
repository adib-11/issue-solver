import { expect, test } from "bun:test";
import { dockerRunner, sandboxCommand } from "../src/runner";

const runner = dockerRunner({
  image: "auto-solve-runner:local",
  volume: "auto-solve-workspaces",
  access: {
    "claude-code": { env: ["CLAUDE_CODE_OAUTH_TOKEN"] },
    codex: { env: ["CODEX_HOME"], mounts: ["type=volume,src=auto-solve-codex,dst=/codex"] },
  },
});

test("runs a disposable, limited, nonroot container that mounts only the attempt's workspace", () => {
  const command = runner.command("/workspaces/attempt-7", "claude-code").join(" ");
  expect(command).toStartWith("docker run --rm -i ");
  expect(command).toEndWith(" auto-solve-runner:local");
  for (const flag of [
    "--user 1000:1000",
    "--cpus 2",
    "--memory 4g",
    "--pids-limit 256",
    "--cap-drop ALL",
    "--security-opt no-new-privileges",
    "--mount type=volume,src=auto-solve-workspaces,dst=/work,volume-subpath=attempt-7",
    "--workdir /work",
    "--env CLAUDE_CODE_OAUTH_TOKEN ",
  ]) {
    expect(command).toContain(flag);
  }
  expect(command).not.toMatch(/ (-v|--volume|--privileged|--network host)/);
  expect(command).not.toContain("docker.sock");
});

test("gives each harness only its own credentials", () => {
  const claude = runner.command("/workspaces/attempt-7", "claude-code").join(" ");
  const codex = runner.command("/workspaces/attempt-7", "codex").join(" ");
  expect(claude).not.toContain("codex");
  expect(codex).toContain("--env CODEX_HOME --mount type=volume,src=auto-solve-codex,dst=/codex ");
  expect(codex).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
});

test("checks run in a fresh container with the runner's limits and no credentials of any kind", () => {
  const command = sandboxCommand("auto-solve-runner:local", "auto-solve-workspaces", "/workspaces/attempt-7-check", "c").join(" ");
  expect(command).toStartWith("docker run -d --rm --name c ");
  for (const flag of ["--user 1000:1000", "--cpus 2", "--memory 4g", "--pids-limit 256", "--cap-drop ALL", "--security-opt no-new-privileges"]) {
    expect(command).toContain(flag);
  }
  expect(command).toContain("--mount type=volume,src=auto-solve-workspaces,dst=/work,volume-subpath=attempt-7-check --workdir /work");
  expect(command.match(/--mount/g)).toHaveLength(1);
  expect(command).not.toMatch(/ (-e|--env|--env-file|-v|--volume|--privileged|--network host) /);
  expect(command).not.toMatch(/codex|CLAUDE|docker\.sock/);
});
