import { $ } from "bun";
import { createSign } from "node:crypto";
import type { IssueSnapshot } from "./jobs";

export type Installation = { id: number; account: { login: string; type: string } };
export type PullRequest = { number: number; url: string };
export type Repo = { id: number; full_name: string; fork: boolean; archived: boolean };
/** An issue as the GraphQL query below returns it. Pull requests are never included. */
export type Issue = {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED";
  authorAssociation: string;
  createdAt: string;
  updatedAt: string;
  assignees: { totalCount: number };
  closedByPullRequestsReferences: { nodes: { state: string }[] };
  /** Cross-referenced events; `source.state` is set only when the source is a pull request. */
  timelineItems: { nodes: { isCrossRepository?: boolean; source?: { state?: string } }[] };
};

// Same fields as the skill bundle's candidate filter (skills/solve-issue/scripts/candidates.sh).
const ISSUES_QUERY = `
query($owner: String!, $name: String!, $since: DateTime, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(first: 100, after: $after, filterBy: {since: $since}, orderBy: {field: UPDATED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title url state authorAssociation createdAt updatedAt
        assignees { totalCount }
        closedByPullRequestsReferences(first: 10) { nodes { state } }
        timelineItems(itemTypes: [CROSS_REFERENCED_EVENT], last: 20) {
          nodes { ... on CrossReferencedEvent { isCrossRepository source { ... on PullRequest { state } } } }
        }
      }
    }
  }
}`;

/** The only GitHub operations the controller uses. Tests replace this with a fake. */
export interface GitHub {
  listInstallations(): Promise<Installation[]>;
  listInstallationRepos(installationId: number): Promise<Repo[]>;
  /** Issues (not PRs) updated at or after `since` (ISO time), all states. */
  listIssues(installationId: number, repo: Repo, since: string | undefined): Promise<Issue[]>;
  /** Clones the repo's default branch into dir. No credential is left in the clone. */
  checkout(installationId: number, fullName: string, dir: string): Promise<void>;
  /** The issue now, with every comment. */
  getIssue(installationId: number, fullName: string, number: number): Promise<IssueSnapshot>;
  comment(installationId: number, fullName: string, number: number, body: string): Promise<void>;
  /** The branch's commit on GitHub, or null when there is no such branch. */
  branchSha(installationId: number, fullName: string, branch: string): Promise<string | null>;
  /** Pushes sha from the clone in dir to branch, never forcing. */
  push(installationId: number, fullName: string, dir: string, sha: string, branch: string): Promise<void>;
  /** The pull request from branch, in any state, or null. */
  findPullRequest(installationId: number, fullName: string, branch: string): Promise<PullRequest | null>;
  createDraftPullRequest(installationId: number, fullName: string, pr: { head: string; base: string; title: string; body: string }): Promise<PullRequest>;
}

const API = "https://api.github.com";

export type GitHubClientOptions = {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  baseDelayMs?: number;
};

export function createGitHubClient(appId: string, privateKey: string, options: GitHubClientOptions = {}): GitHub {
  const fetchFn = options.fetch ?? fetch;
  const sleepFn = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const nowFn = options.now ?? (() => Date.now());
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const tokens = new Map<number, { token: string; expiresAt: number }>();

  function appJwt() {
    const now = Math.floor(nowFn() / 1000);
    const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const body = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: now - 60, exp: now + 540, iss: appId })}`;
    const signature = createSign("RSA-SHA256").update(body).sign(privateKey, "base64url");
    return `${body}.${signature}`;
  }

  function computeDelay(res: Response | null, attempt: number): number {
    let delay = baseDelayMs * Math.pow(2, attempt);
    if (res) {
      const retryAfter = res.headers.get("retry-after");
      if (retryAfter) {
        const seconds = parseFloat(retryAfter);
        if (!isNaN(seconds)) delay = Math.max(delay, seconds * 1000);
      }
      const remaining = res.headers.get("x-ratelimit-remaining");
      const reset = res.headers.get("x-ratelimit-reset");
      if (remaining === "0" && reset) {
        const resetSec = parseFloat(reset);
        if (!isNaN(resetSec)) {
          const diffMs = resetSec * 1000 - nowFn();
          if (diffMs > 0) delay = Math.max(delay, diffMs);
        }
      }
    }
    return Math.max(0, delay);
  }

  async function request(url: string, auth: string, init: RequestInit = {}) {
    const fullUrl = url.startsWith("http") ? url : API + url;
    const reqInit: RequestInit = {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${auth}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "auto-solve",
        ...init.headers,
      },
    };

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= 3; attempt++) {
      let res: Response | null = null;
      try {
        res = await fetchFn(fullUrl, reqInit);
      } catch (err) {
        lastError = err as Error;
        if (attempt < 3) {
          await sleepFn(computeDelay(null, attempt));
          continue;
        }
        throw lastError;
      }

      if (res.ok) return res;

      const isRateLimit403 =
        res.status === 403 &&
        (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after"));
      const isTransient = (res.status >= 500 && res.status <= 599) || res.status === 429 || isRateLimit403;

      if (!isTransient || attempt >= 3) {
        throw new Error(`GitHub ${init.method ?? "GET"} ${url} -> ${res.status}`);
      }

      await sleepFn(computeDelay(res, attempt));
    }
    throw lastError ?? new Error(`GitHub ${init.method ?? "GET"} ${url} failed`);
  }

  async function paginate<T>(path: string, auth: string, pick: (body: any) => T[] = (b) => b) {
    const items: T[] = [];
    let url: string | undefined = path;
    while (url) {
      const res = await request(url, auth);
      items.push(...pick(await res.json()));
      url = res.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    }
    return items;
  }

  /** Runs git with the installation token as a header from the environment, so it is neither on the command line nor written to .git/config. */
  async function git(installationId: number, what: string, args: string[]) {
    const token = await installationToken(installationId);
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    };
    const result = await $`git -c core.hooksPath=/dev/null ${args}`.env(env).nothrow().quiet();
    const stderr = result.stderr.toString().replaceAll(token, "[redacted]").replaceAll(basic, "[redacted]");
    if (result.exitCode !== 0) throw new Error(`${what} failed: ${stderr}`);
    return result.stdout.toString();
  }

  async function installationToken(installationId: number) {
    const cached = tokens.get(installationId);
    if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token;
    const res = await request(`/app/installations/${installationId}/access_tokens`, appJwt(), { method: "POST" });
    const body = (await res.json()) as { token: string; expires_at: string };
    tokens.set(installationId, { token: body.token, expiresAt: Date.parse(body.expires_at) });
    return body.token;
  }

  return {
    listInstallations: () => paginate<Installation>("/app/installations?per_page=100", appJwt()),

    async listInstallationRepos(installationId) {
      const token = await installationToken(installationId);
      return paginate<Repo>("/installation/repositories?per_page=100", token, (b) => b.repositories);
    },

    async listIssues(installationId, repo, since) {
      const token = await installationToken(installationId);
      const [owner, name] = repo.full_name.split("/");
      const issues: Issue[] = [];
      let after: string | null = null;
      do {
        const res = await request("/graphql", token, {
          method: "POST",
          body: JSON.stringify({ query: ISSUES_QUERY, variables: { owner, name, since: since ?? null, after } }),
        });
        const body = (await res.json()) as any;
        if (body.errors || !body.data?.repository) {
          throw new Error(`GitHub GraphQL issues of ${repo.full_name}: ${JSON.stringify(body.errors ?? "repository not found")}`);
        }
        const page = body.data.repository.issues;
        issues.push(...page.nodes);
        after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
      } while (after);
      return issues;
    },

    async checkout(installationId, fullName, dir) {
      await git(installationId, `git clone of ${fullName}`, ["clone", "-q", `https://github.com/${fullName}.git`, dir]);
    },

    async getIssue(installationId, fullName, number) {
      const token = await installationToken(installationId);
      const issue = (await (await request(`/repos/${fullName}/issues/${number}`, token)).json()) as any;
      const comments = await paginate<any>(`/repos/${fullName}/issues/${number}/comments?per_page=100`, token);
      return {
        number,
        title: issue.title,
        url: issue.html_url,
        state: issue.state === "closed" ? "CLOSED" : "OPEN",
        body: issue.body ?? "",
        comments: comments.map((c) => ({ author: c.user?.login ?? "ghost", authorAssociation: c.author_association, body: c.body ?? "" })),
      };
    },

    async comment(installationId, fullName, number, body) {
      const token = await installationToken(installationId);
      await request(`/repos/${fullName}/issues/${number}/comments`, token, { method: "POST", body: JSON.stringify({ body }) });
    },

    async branchSha(installationId, fullName, branch) {
      const out = await git(installationId, `git ls-remote of ${fullName}`, ["ls-remote", `https://github.com/${fullName}.git`, `refs/heads/${branch}`]);
      return out.split("\t")[0]!.trim() || null;
    },

    async push(installationId, fullName, dir, sha, branch) {
      await git(installationId, `git push to ${fullName} ${branch}`, ["-C", dir, "push", "-q", `https://github.com/${fullName}.git`, `${sha}:refs/heads/${branch}`]);
    },

    async findPullRequest(installationId, fullName, branch) {
      const token = await installationToken(installationId);
      const owner = fullName.split("/")[0];
      const res = await request(`/repos/${fullName}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}`, token);
      const [pr] = (await res.json()) as any[];
      return pr ? { number: pr.number, url: pr.html_url } : null;
    },

    async createDraftPullRequest(installationId, fullName, { head, base, title, body }) {
      const token = await installationToken(installationId);
      const res = await request(`/repos/${fullName}/pulls`, token, { method: "POST", body: JSON.stringify({ head, base, title, body, draft: true }) });
      const pr = (await res.json()) as any;
      return { number: pr.number, url: pr.html_url };
    },
  };
}
