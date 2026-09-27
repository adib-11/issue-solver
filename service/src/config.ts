import { readFileSync } from "node:fs";

export type Config = {
  ownerLogin: string;
  appId: string;
  privateKey: string;
  adminPassword: string;
  /** Subscription token from `claude setup-token`; optional because the harness is chosen on the setup page. */
  claudeOauthToken?: string;
  dbPath: string;
  /** Per-attempt checkouts; the workspaces volume is mounted here. */
  workspacesDir: string;
  runnerImage: string;
  /** The Docker volume mounted at workspacesDir, which runner containers mount a subpath of. */
  workspaceVolume: string;
  port: number;
};

export function loadConfig(env: Record<string, string | undefined>): Config {
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Missing required config: ${name}`);
    return value;
  };
  const ownerLogin = required("OWNER_LOGIN");
  const appId = required("GITHUB_APP_ID");
  const keyFile = required("GITHUB_APP_PRIVATE_KEY_FILE");
  const adminPassword = required("ADMIN_PASSWORD");
  let privateKey: string;
  try {
    privateKey = readFileSync(keyFile, "utf8");
  } catch {
    throw new Error(`Cannot read GITHUB_APP_PRIVATE_KEY_FILE at ${keyFile}`);
  }
  return {
    ownerLogin,
    appId,
    privateKey,
    adminPassword,
    claudeOauthToken: env.CLAUDE_CODE_OAUTH_TOKEN?.trim() || undefined,
    dbPath: env.DB_PATH || "/data/auto-solve.sqlite",
    workspacesDir: env.WORKSPACES_DIR || "/workspaces",
    runnerImage: env.RUNNER_IMAGE || "auto-solve-runner:local",
    workspaceVolume: env.WORKSPACE_VOLUME || "auto-solve-workspaces",
    port: Number(env.PORT || 3000),
  };
}
