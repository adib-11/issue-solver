// Shared by the controller and the dashboard.
export const JOB_STATES = ["queued", "running", "needs_info", "pr_created", "failed", "skipped"] as const;

export type Job = {
  id: number;
  repo_full_name: string;
  issue_number: number;
  issue_title: string;
  issue_url: string;
  state: (typeof JOB_STATES)[number];
  created_at: string;
  updated_at: string;
};
