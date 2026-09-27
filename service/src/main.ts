import { join } from "node:path";
import { createApp } from "./app";
import { claudeCode } from "./claude-code";
import { realClock } from "./clock";
import { loadConfig, type Config } from "./config";
import { createGitHubClient } from "./github";
import { dockerRunner } from "./runner";

let config: Config;
try {
  config = loadConfig(process.env);
} catch (err) {
  console.error(`auto-solve cannot start: ${(err as Error).message}`);
  process.exit(1);
}

// The same command runs here (Test auth) and in the runner image; both images put claude on the PATH.
const harnesses = [claudeCode({ token: config.claudeOauthToken, command: ["claude"] })];
const runner = dockerRunner({ image: config.runnerImage, volume: config.workspaceVolume, env: ["CLAUDE_CODE_OAUTH_TOKEN"] });
const app = createApp({ config, github: createGitHubClient(config.appId, config.privateKey), clock: realClock, harnesses, runner });
Bun.serve({ port: config.port, fetch: app.fetch });
console.log(`auto-solve listening on port ${config.port}`);
await app.start();
