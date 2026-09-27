import { expect, test } from "bun:test";
import { dockerRunner } from "../src/runner";

test("runs a disposable, limited, nonroot container that mounts only the attempt's workspace", () => {
  const runner = dockerRunner({ image: "auto-solve-runner:local", volume: "auto-solve-workspaces", env: ["CLAUDE_CODE_OAUTH_TOKEN"] });
  const command = runner.command("/workspaces/attempt-7").join(" ");
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
