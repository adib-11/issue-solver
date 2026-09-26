import { join } from "node:path";
import { createApp } from "./app";
import { claudeCode } from "./claude-code";
import { realClock } from "./clock";
import { loadConfig, type Config } from "./config";
import { createGitHubClient } from "./github";

let config: Config;
try {
  config = loadConfig(process.env);
} catch (err) {
  console.error(`auto-solve cannot start: ${(err as Error).message}`);
  process.exit(1);
}

const harnesses = [claudeCode({ token: config.claudeOauthToken, command: [join(import.meta.dir, "../node_modules/.bin/claude")] })];
const app = createApp({ config, github: createGitHubClient(config.appId, config.privateKey), clock: realClock, harnesses });
Bun.serve({ port: config.port, fetch: app.fetch });
console.log(`auto-solve listening on port ${config.port}`);
await app.start();
