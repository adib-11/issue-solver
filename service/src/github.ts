import { createSign } from "node:crypto";

export type Installation = { id: number; account: { login: string; type: string } };
export type Repo = { id: number; full_name: string; fork: boolean; archived: boolean };
export type Issue = {
  number: number;
  title: string;
  html_url: string;
  state: "open" | "closed";
  user: { login: string } | null;
  author_association: string;
  created_at: string;
  updated_at: string;
  pull_request?: unknown;
};

/** The only GitHub operations the controller uses. Tests replace this with a fake. */
export interface GitHub {
  listInstallations(): Promise<Installation[]>;
  listInstallationRepos(installationId: number): Promise<Repo[]>;
  /** Issues and PRs updated at or after `since` (ISO time), all states. */
  listIssues(installationId: number, repo: Repo, since: string | undefined): Promise<Issue[]>;
}

const API = "https://api.github.com";

export function createGitHubClient(appId: string, privateKey: string): GitHub {
  const tokens = new Map<number, { token: string; expiresAt: number }>();

  function appJwt() {
    const now = Math.floor(Date.now() / 1000);
    const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const body = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: now - 60, exp: now + 540, iss: appId })}`;
    const signature = createSign("RSA-SHA256").update(body).sign(privateKey, "base64url");
    return `${body}.${signature}`;
  }

  async function request(url: string, auth: string, init: RequestInit = {}) {
    const res = await fetch(url.startsWith("http") ? url : API + url, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${auth}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "auto-solve",
      },
    });
    if (!res.ok) throw new Error(`GitHub ${init.method ?? "GET"} ${url} -> ${res.status}`);
    return res;
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
      const query = new URLSearchParams({ state: "all", sort: "updated", direction: "asc", per_page: "100" });
      if (since) query.set("since", since);
      return paginate<Issue>(`/repos/${repo.full_name}/issues?${query}`, token);
    },
  };
}
