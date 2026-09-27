// Shared by the controller and the dashboard.
export const JOB_STATES = ["queued", "running", "needs_info", "pr_created", "failed", "skipped"] as const;

export const UNTRUSTED_AUTHOR = "untrusted author";
/** Author associations whose issues and comments reach the agent without Run anyway. */
export const TRUSTED_AUTHORS = ["OWNER", "COLLABORATOR"];
export const NO_CHECKS = "no checks";

export type Job = {
  id: number;
  repo_id: number;
  repo_full_name: string;
  issue_number: number;
  issue_title: string;
  issue_url: string;
  state: (typeof JOB_STATES)[number];
  /** The current phase; null unless state is "running". */
  phase: string | null;
  /** Why the job was skipped; null unless state is "skipped". */
  skip_reason: string | null;
  /** The attempt the next attempt resumes from, set by a Retry of a failed job; null otherwise. */
  resume_from: number | null;
  created_at: string;
  updated_at: string;
};

/** GET /api/jobs/:id: the job with every attempt, oldest first. */
export type JobDetail = Job & {
  attempts: Attempt[];
  /** The phase a Retry of a failed job would resume at; null unless state is "failed". */
  resume_phase: string | null;
};

export type Attempt = {
  id: number;
  harness: string;
  base_sha: string | null;
  started_at: string;
  finished_at: string | null;
  /** How the attempt ended; null while it runs. */
  result: string | null;
  /** The issue as the brief phase saw it; null until the attempt takes it. */
  issue: IssueSnapshot | null;
  /** The controller's commits on top of base_sha, oldest first. */
  commits: Commit[];
  /** The branch the commits are pushed to, recorded before the push; null until publishing. */
  branch: string | null;
  branch_url: string | null;
  /** The draft PR, opened or reused; null until it exists. */
  pr_url: string | null;
  /** The attempt this one continued, when a Retry resumed one; null for a fresh attempt. */
  resumed_from: number | null;
  phases: Phase[];
};

export type Commit = { sha: string; message: string; /** git's diff stat of the commit. */ stat: string };

export type IssueComment = { author: string; authorAssociation: string; body: string };

/** An issue at one moment. Only comments by trusted authors are kept, since the agent reads them. */
export type IssueSnapshot = {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED";
  body: string;
  comments: IssueComment[];
};

/** The brief phase's output: a brief with criteria and seams, or questions; never both. */
export type Brief = {
  outcome: "brief" | "needs_info";
  /** Markdown in the agent-brief template; "" for needs_info. */
  brief: string;
  acceptance_criteria: string[];
  /** The public boundaries the new tests will exercise. */
  seams: string[];
  questions: string[];
};

/** A command the controller ran in a sandbox: on the base with the new test files overlaid, or on the change. */
export type CommandRun = { on: "base" | "head"; command: string; exit_code: number };

/** The red/green and checks phases' output. */
export type CommandRuns = { runs: CommandRun[]; /** Why the phase was skipped, when it was. */ skipped?: string };

/** One finding from a review axis. */
export type Finding = { id: string; kind: string; quote: string; rationale: string };

/** The fix phase's verdict on one finding. */
export type Decision = { id: string; decision: "fixed" | "rejected"; reason: string };

/**
 * One round of the review loop: both axes' findings and the fix decisions on them. decisions is empty when the
 * round found nothing or when the round cap stopped the loop before fixing, leaving its findings open.
 */
export type ReviewRound = { standards: Finding[]; spec: Finding[]; decisions: Decision[] };

export type Phase = {
  name: string;
  started_at: string;
  finished_at: string | null;
  /** "ok" or the harness error; null while it runs. */
  outcome: string | null;
  /** Redacted, and only the last 200 KiB. */
  log: string;
  /** The validated output; null while running or when the phase failed. */
  output: unknown;
};

/** How to build and verify changes to a repo. An empty string means "none". */
export type Conventions = {
  setup_command: string;
  check_commands: string[];
  test_file_command: string;
  has_tests: boolean;
  commit_style: string;
  notes: string;
};

/** GET /api/repos */
export type RepoView = {
  id: number;
  full_name: string;
  discovered: Conventions | null;
  discovered_at: string | null;
  /** Wins over discovered conventions when set. */
  override: Conventions | null;
};
