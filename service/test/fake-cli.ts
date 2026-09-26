// Stands in for a harness CLI: replays a recorded run and captures what it was given.
// Usage: bun test/fake-cli.ts <recording.json> <capture.json> [...the adapter's CLI arguments]
// A recording's stdout is a list of lines; objects are written as one JSON line each (stream-json).
// orphanSleepMs starts a grandchild that holds stdout open, like a tool process the CLI left running.
type Recording = { stdout: (string | object)[]; stderr?: string; exit: number; sleepMs?: number; orphanSleepMs?: number };

const [recordingPath, capturePath, ...args] = process.argv.slice(2);
const recording: Recording = await Bun.file(recordingPath!).json();
await Bun.write(capturePath!, JSON.stringify({ args, stdin: await Bun.stdin.text(), env: process.env, cwd: process.cwd() }));
if (recording.orphanSleepMs) Bun.spawn(["sleep", String(recording.orphanSleepMs / 1000)], { stdout: "inherit", stderr: "inherit" }).unref();
if (recording.sleepMs) await Bun.sleep(recording.sleepMs);
for (const line of recording.stdout) process.stdout.write(`${typeof line === "string" ? line : JSON.stringify(line)}\n`);
process.stderr.write(recording.stderr ?? "");
process.exit(recording.exit);

export {};
