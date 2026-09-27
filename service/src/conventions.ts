import { $ } from "bun";
import type { JsonSchema } from "./harness";
import type { Conventions } from "./jobs";

export const CONVENTIONS_TIMEOUT_MS = 10 * 60_000;

export const CONVENTIONS_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    setup_command: { type: "string", description: 'Installs dependencies in a fresh container; "" when none is needed.' },
    check_commands: { type: "array", items: { type: "string" }, description: "What CI runs to verify a change, in order; [] when none." },
    test_file_command: { type: "string", description: 'Runs one test file, with {file} for its path; "" when not possible.' },
    has_tests: { type: "boolean" },
    commit_style: { type: "string" },
    notes: { type: "string" },
  },
  required: ["setup_command", "check_commands", "test_file_command", "has_tests", "commit_style", "notes"],
  additionalProperties: false,
};

export const CONVENTIONS_PROMPT = `You are running unattended: no user is present, so decide everything yourself and ask nothing.
Do not edit, create, or delete files. Do not commit or push. Do not install anything.

Work out how changes to this repository are built and verified. Read its CI configuration (for example .github/workflows), its build files (package.json, Makefile, pyproject.toml, Cargo.toml, go.mod and the like), its README, any CLAUDE.md or AGENTS.md, and recent history (git log). Then report:

- setup_command: one shell command that installs dependencies in a fresh container from a clean checkout of this repository, or "" if none is needed.
- check_commands: the shell commands CI runs to verify a change (tests, lint, typecheck, build), in the order CI runs them. Each exits 0 on success. Use only commands the CI configuration or build files define. Report [] if you find none; never invent one.
- test_file_command: a command that runs a single test file, with {file} standing for its path relative to the repository root, or "" if the test runner cannot do that.
- has_tests: whether the repository has any automated tests.
- commit_style: how commit messages are written here, judged from git log, with one real example.
- notes: anything else an agent changing this repository must know, such as where tests live and how they are named. Keep it short.`;

// ponytail: top-level build files only; add nested ones (monorepo packages) if their changes go unnoticed.
const BUILD_FILES = [
  ".github/workflows", ".gitlab-ci.yml", ".circleci", "Makefile", "justfile", "Taskfile.yml",
  "package.json", "deno.json", "deno.jsonc", "bunfig.toml", "pyproject.toml", "setup.py", "setup.cfg", "tox.ini",
  ":(glob)requirements*.txt", "Cargo.toml", "go.mod", "pom.xml", ":(glob)build.gradle*", "Gemfile", "composer.json",
  "mix.exs", "CMakeLists.txt", "CLAUDE.md", "AGENTS.md",
];

/** Identifies the checkout's CI and build files: discovered conventions stay valid while this is unchanged. */
export async function conventionsHash(workspace: string) {
  const blobs = await $`git -C ${workspace} ls-files -s -- ${BUILD_FILES}`.text();
  return new Bun.CryptoHasher("sha256").update(blobs).digest("hex");
}
