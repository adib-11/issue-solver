// The contract every harness adapter (Claude Code, Codex) implements.

export type AuthState = "ok" | "auth" | "quota";
/** An auth check's outcome: "error" when the check failed for another reason (see its log). */
export type AuthCheckState = AuthState | "error";
export type RunError = "auth" | "quota" | "timeout" | "bad_output" | "crash";

export type RunResult = { ok: true; output: unknown; log: string } | { ok: false; error: RunError; log: string };

export type RunOptions = {
  prompt: string;
  schema: JsonSchema;
  workspace: string;
  timeoutMs: number;
  /** A command prefix that runs the CLI inside the runner container, which mounts the workspace. */
  wrap?: string[];
};

export interface Harness {
  name: string;
  label: string;
  /** Shown on the setup page as plain text. */
  loginHelp: string;
  /** The long-lived secret the harness logs in with, when it has one; the setup page shows its age. */
  credential?: string;
  checkAuth(): Promise<{ state: AuthCheckState; log: string }>;
  /** A fresh, non-interactive session. The output is re-validated against the schema, whatever the CLI claims. */
  run(options: RunOptions): Promise<RunResult>;
}

export type CliResult = { stdout: string; stderr: string; exitCode: number } | { timeout: true } | { startError: string };

/** Runs a CLI with the prompt on stdin, and stops waiting at the deadline even if a leftover subprocess still holds the pipes open. */
export async function runCli(argv: string[], options: { cwd: string; stdin: string; env: Record<string, string>; timeoutMs: number }): Promise<CliResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, { cwd: options.cwd, stdin: new Blob([options.stdin]), stdout: "pipe", stderr: "pipe", env: options.env });
  } catch (err) {
    return { startError: `Could not start ${argv.join(" ")}: ${(err as Error).message}` };
  }
  let timer: Timer | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), options.timeoutMs);
  });
  const stdout = new Response(proc.stdout as ReadableStream).text();
  const stderr = new Response(proc.stderr as ReadableStream).text();
  const finished = await Promise.race([Promise.all([stdout, stderr, proc.exited]), deadline]);
  clearTimeout(timer);
  if (finished === "timeout") {
    proc.kill("SIGKILL");
    return { timeout: true };
  }
  return { stdout: finished[0], stderr: finished[1], exitCode: finished[2] };
}

/** GET /api/setup: shared by the controller and the dashboard. */
export type SetupView = {
  harness: string | null;
  harnesses: { name: string; label: string; loginHelp: string }[];
  auth: { state: AuthCheckState; checkedAt: string; log: string } | null;
  /** Why dispatch is paused, or null. */
  paused: string | null;
  /** When the chosen harness's credential was first seen. */
  credentialSince: string | null;
};

/** The subset of JSON Schema that phase schemas use. */
export type JsonSchema = {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: unknown[];
  description?: string;
};

// ponytail: covers only the keywords in JsonSchema above; swap in ajv if phase schemas need more.
/** Returns why value does not match schema, or null when it does. */
export function schemaError(schema: JsonSchema, value: unknown, path = "$"): string | null {
  if (schema.enum && !schema.enum.some((v) => v === value)) return `${path} is not one of ${JSON.stringify(schema.enum)}`;
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (schema.type) {
    const matches = schema.type === actual || (schema.type === "integer" && Number.isInteger(value));
    if (!matches) return `${path} should be ${schema.type}, got ${actual}`;
  }
  if (actual === "array" && schema.items) {
    for (const [i, item] of (value as unknown[]).entries()) {
      const err = schemaError(schema.items, item, `${path}[${i}]`);
      if (err) return err;
    }
  }
  if (actual === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in obj)) return `${path}.${key} is required`;
    for (const [key, v] of Object.entries(obj)) {
      const sub = schema.properties?.[key];
      if (sub) {
        const err = schemaError(sub, v, `${path}.${key}`);
        if (err) return err;
      } else if (schema.additionalProperties === false) return `${path}.${key} is not allowed`;
    }
  }
  return null;
}
