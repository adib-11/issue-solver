import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";

const dir = mkdtempSync(join(tmpdir(), "auto-solve-config-"));
const keyFile = join(dir, "app.pem");
writeFileSync(keyFile, "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const full = {
  OWNER_LOGIN: "octo",
  GITHUB_APP_ID: "123",
  GITHUB_APP_PRIVATE_KEY_FILE: keyFile,
  ADMIN_PASSWORD: "pw",
};

test("loads required config", () => {
  expect(loadConfig(full)).toMatchObject({
    ownerLogin: "octo",
    appId: "123",
    privateKey: expect.stringContaining("BEGIN RSA PRIVATE KEY"),
    adminPassword: "pw",
  });
});

for (const name of Object.keys(full)) {
  test(`aborts with a clear message when ${name} is missing`, () => {
    expect(() => loadConfig({ ...full, [name]: "" })).toThrow(`Missing required config: ${name}`);
  });
}

test("aborts with a clear message when the private key file cannot be read", () => {
  const missing = join(dir, "nope.pem");
  expect(() => loadConfig({ ...full, GITHUB_APP_PRIVATE_KEY_FILE: missing })).toThrow(
    `Cannot read GITHUB_APP_PRIVATE_KEY_FILE at ${missing}`,
  );
});

test("the Claude Code token is optional and trimmed", () => {
  expect(loadConfig(full).claudeOauthToken).toBeUndefined();
  expect(loadConfig({ ...full, CLAUDE_CODE_OAUTH_TOKEN: " sk-ant-oat01-x \n" }).claudeOauthToken).toBe("sk-ant-oat01-x");
});

test("Codex keeps its login on the codex volume at /codex by default", () => {
  expect(loadConfig(full)).toMatchObject({ codexHome: "/codex", codexVolume: "auto-solve-codex" });
});

test("publicUrl and webhookSecret are optional and trimmed", () => {
  expect(loadConfig(full).publicUrl).toBeUndefined();
  expect(loadConfig(full).webhookSecret).toBeUndefined();
  expect(
    loadConfig({
      ...full,
      PUBLIC_URL: " https://solve.example.com/api/webhook \n",
      WEBHOOK_SECRET: " whsec_123 \n",
    }),
  ).toMatchObject({
    publicUrl: "https://solve.example.com/api/webhook",
    webhookSecret: "whsec_123",
  });
});
