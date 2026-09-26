// Shared by the controller and the dashboard.
export const JOB_STATES = ["queued", "running", "needs_info", "pr_created", "failed", "skipped"] as const;

export const UNTRUSTED_AUTHOR = "untrusted author";

export type Job = {
  id: number;
  repo_full_name: string;
  issue_number: number;
  issue_title: string;
  issue_url: string;
  state: (typeof JOB_STATES)[number];
  /** Why the job was skipped; null unless state is "skipped". */
  skip_reason: string | null;
  created_at: string;
  updated_at: string;
};
