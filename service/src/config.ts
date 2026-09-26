import { readFileSync } from "node:fs";

export type Config = {
  ownerLogin: string;
  appId: string;
  privateKey: string;
  adminPassword: string;
  dbPath: string;
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
    dbPath: env.DB_PATH || "/data/auto-solve.sqlite",
    port: Number(env.PORT || 3000),
  };
}
