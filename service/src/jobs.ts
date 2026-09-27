// Shared by the controller and the dashboard.
export const JOB_STATES = ["queued", "running", "needs_info", "pr_created", "failed", "skipped"] as const;

export const UNTRUSTED_AUTHOR = "untrusted author";
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
  created_at: string;
  updated_at: string;
};

/** GET /api/jobs/:id: the job with every attempt, oldest first. */
export type JobDetail = Job & { attempts: Attempt[] };

export type Attempt = {
  id: number;
  harness: string;
  base_sha: string | null;
  started_at: string;
  finished_at: string | null;
  /** How the attempt ended; null while it runs. */
  result: string | null;
  phases: Phase[];
};

export type Phase = {
  name: string;
  started_at: string;
  finished_at: string | null;
  /** "ok" or the harness error; null while it runs. */
  outcome: string | null;
  /** Redacted, and only the last 200 KiB. */
  log: string;
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
