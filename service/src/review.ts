import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonSchema } from "./harness";
import type { Brief, Commit, Conventions, Decision, Finding, IssueSnapshot } from "./jobs";

export const REVIEW_TIMEOUT_MS = 10 * 60_000;
export const FIX_TIMEOUT_MS = 20 * 60_000;
/** How many review rounds the loop runs at most; a 3rd round's findings stay open. */
export const REVIEW_ROUNDS = 3;

// The skill file is the single source of truth for how to review; only its frontmatter is dropped.
const SKILL = readFileSync(join(import.meta.dir, "../../skills/code-review/SKILL.md"), "utf8").replace(/^---\n[\s\S]*?\n---\n/, "").trim();

export type Reviewed = { findings: Finding[] };
export type Fixed = { decisions: Decision[]; commit_message: string };

export const REVIEW_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "A short id, unique within the axis: S1, S2… for Standards; P1, P2… for Spec." },
          kind: { type: "string", description: "The smell's name, or the kind of breach or gap this is." },
          quote: { type: "string", description: "The exact lines from the diff the finding is about." },
          rationale: { type: "string", description: "Why it is a finding: the file and rule it breaches, or the brief or issue line it misses." },
        },
        required: ["id", "kind", "quote", "rationale"],
        additionalProperties: false,
      },
      description: "Every finding; [] when the change is clean.",
    },
  },
  required: ["findings"],
  additionalProperties: false,
};

export const FIX_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "The finding's id." },
          decision: { enum: ["fixed", "rejected"] },
          reason: { type: "string", description: "What you changed, or why the finding is rejected; a rejection must give a reason." },
        },
        required: ["id", "decision", "reason"],
        additionalProperties: false,
      },
      description: "One decision per finding.",
    },
    commit_message: { type: "string", description: "One commit message for all the fixes, in the repository's commit style." },
  },
  required: ["decisions", "commit_message"],
  additionalProperties: false,
};

const PREAMBLE = `You are running unattended: no user is present, so decide everything yourself and ask nothing.
Do not edit, create, or delete files. Do not commit or push, and do not create branches. Do not touch CI configuration: any edit under .github/workflows/ fails the attempt.

Your job is the one review session below. Work in the repository in your working directory and inspect the change with git.`;

const commitList = (commits: Commit[]) => commits.map((c) => `- ${c.sha} ${c.message.split("\n")[0]!.trim()}`).join("\n");

export function standardsPrompt(base: string, commits: Commit[], conventions: Conventions) {
  return `${PREAMBLE}

${SKILL}

## This session's axis: Standards

Judge only the Standards axis: does the change follow how this repository says code should be written? Read the repository's own standards files yourself (CONTRIBUTING.md, a style guide, an ADR folder, CLAUDE.md or AGENTS.md, and the like) and apply them. Apply the smell list above with its two rules: a documented repository standard overrides a smell, and every smell is a judgement call reported as "possible <smell>". Ignore anything a linter or formatter already enforces.

The change is these commits on top of ${base}:

${commitList(commits)}

Inspect it with \`git diff ${base}...HEAD\` and by reading the files it changes. Then report:

- findings: one entry per finding, with id (S1, S2, …), kind (the smell's name, or "documented standard"), quote (the exact lines from the diff), and rationale (why it is a breach, citing the file and rule). Report [] when the change is clean.

## The repository's conventions

${JSON.stringify(conventions, null, 2)}`;
}

export function specPrompt(base: string, commits: Commit[], brief: Brief, issue: IssueSnapshot) {
  return `${PREAMBLE}

${SKILL}

## This session's axis: Spec

Judge only the Spec axis: does the change do what the brief and the issue asked, no more and no less? The brief and the issue below are the spec. Report requirements that are missing or only partly done, behavior the brief and the issue did not ask for, and requirements that seem implemented but look wrong. Quote the brief or issue line behind each finding.

The change is these commits on top of ${base}:

${commitList(commits)}

Inspect it with \`git diff ${base}...HEAD\` and by reading the files it changes. Then report:

- findings: one entry per finding, with id (P1, P2, …), kind, quote (the exact lines from the diff), and rationale (quoting the brief or issue line it breaches). Report [] when the change is clean.

## The agent brief

${brief.brief}

## The issue

${JSON.stringify(issue, null, 2)}`;
}

export function fixPrompt(base: string, commits: Commit[], conventions: Conventions, findings: Finding[]) {
  return `You are running unattended: no user is present, so decide everything yourself and ask nothing.
Only edit files in this repository. Do not commit or push, and do not create branches: the controller commits your change. Do not touch CI configuration: any edit under .github/workflows/ fails the attempt.

A Standards review and a Spec review of the change below produced the findings that follow. Fix the ones you accept, directly in the working directory, and reject the rest with a reason. Keep the repository's tests passing and follow its conventions.

Decide every finding, with no exceptions: report its id, a decision of "fixed" or "rejected", and a reason (what you changed, or why the finding does not warrant a change). A rejection must give a reason. Then report one commit_message for your fixes, in the repository's commit style.

The change is these commits on top of ${base}:

${commitList(commits)}

## The findings

${findings.map((f) => `- ${f.id} (${f.kind}): ${f.rationale}\n  quote: ${f.quote}`).join("\n")}

## The repository's conventions

${JSON.stringify(conventions, null, 2)}`;
}

/** Only called on schema-valid output. Returns why output is unacceptable, or null. */
export function fixError(output: unknown, findings: Finding[]) {
  const { decisions, commit_message } = output as Fixed;
  const expected = new Set(findings.map((f) => f.id));
  const decided = new Set<string>();
  for (const { id, decision, reason } of decisions) {
    if (!expected.has(id)) return `decision ${id} does not match a finding`;
    if (decided.has(id)) return `there are two decisions for ${id}`;
    decided.add(id);
    if (decision === "rejected" && !reason.trim()) return `finding ${id} is rejected without a reason`;
  }
  const undecided = findings.find((f) => !decided.has(f.id));
  if (undecided) return `finding ${undecided.id} has no decision`;
  if (decisions.some((d) => d.decision === "fixed") && !commit_message.trim()) return "the fixes have no commit message";
  return null;
}
