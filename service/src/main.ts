import { join } from "node:path";
import { createApp } from "./app";
import { claudeCode } from "./claude-code";
import { codex } from "./codex";
import { realClock } from "./clock";
import { loadConfig, type Config } from "./config";
import { createGitHubClient } from "./github";
import { dockerRunner, dockerSandbox } from "./runner";

let config: Config;
try {
  config = loadConfig(process.env);
} catch (err) {
  console.error(`auto-solve cannot start: ${(err as Error).message}`);
  process.exit(1);
}

// The same commands run here (Test auth) and in the runner image; both images put claude and codex on the PATH,
// and both mount the codex volume at the same path.
const harnesses = [claudeCode({ token: config.claudeOauthToken, command: ["claude"] }), codex({ home: config.codexHome, command: ["codex"] })];
const runner = dockerRunner({
  image: config.runnerImage,
  volume: config.workspaceVolume,
  access: {
    "claude-code": { env: ["CLAUDE_CODE_OAUTH_TOKEN"] },
    codex: { env: ["CODEX_HOME"], mounts: [`type=volume,src=${config.codexVolume},dst=${config.codexHome}`] },
  },
});
const sandbox = dockerSandbox({ image: config.runnerImage, volume: config.workspaceVolume });
const app = createApp({ config, github: createGitHubClient(config.appId, config.privateKey), clock: realClock, harnesses, runner, sandbox });
Bun.serve({ port: config.port, fetch: app.fetch });
console.log(`auto-solve listening on port ${config.port}`);
await app.start();
