import { afterEach, describe, expect, test } from "bun:test";
import { issue, OWNER, PASSWORD, repo, setup } from "./fakes";

let t: ReturnType<typeof setup>;
afterEach(() => t.cleanup());

describe("installation ownership", () => {
  test("scans an installation on the owner's user account", async () => {
    t = setup();
    t.github.repos.set(10, [repo(1)]);
    t.github.issues.set(1, [issue(1)]);
    await t.app.scan();
    expect((await t.json("/api/jobs")).jobs).toHaveLength(1);
  });

  for (const account of [
    { login: "some-org", type: "Organization" },
    { login: OWNER, type: "Organization" },
    { login: "someone-else", type: "User" },
  ]) {
    test(`rejects an installation on ${account.type} ${account.login} and scans nothing`, async () => {
      t = setup();
      t.github.installations = [{ id: 20, account }];
      t.github.repos.set(20, [repo(1)]);
      t.github.issues.set(1, [issue(1)]);
      await t.app.scan();
      expect(t.github.calls.map((c) => c.op)).toEqual(["listInstallations"]);
      expect((await t.json("/api/jobs")).jobs).toHaveLength(0);
    });
  }
});

describe("scan", () => {
  test("queues open issues and ignores pull requests and closed issues", async () => {
    t = setup();
    t.github.repos.set(10, [repo(1)]);
    t.github.issues.set(1, [
      issue(1),
      issue(2, { pull_request: { url: "x" } }),
      issue(3, { state: "closed" }),
    ]);
    await t.app.scan();
    const { jobs } = await t.json("/api/jobs");
    expect(jobs.map((j: any) => [j.issue_number, j.state])).toEqual([[1, "queued"]]);
  });

  test("each issue produces exactly one job however many scans see it", async () => {
    t = setup();
    t.github.repos.set(10, [repo(1), repo(2, "lib")]);
    t.github.issues.set(1, [issue(7, { updated_at: "2026-01-01T00:00:30Z" })]);
    t.github.issues.set(2, [issue(7, { updated_at: "2026-01-01T00:00:30Z" })]);
    await t.app.scan();
    await t.clock.advance(60_000);
    await t.app.scan();
    const { jobs, total } = await t.json("/api/jobs");
    expect(total).toBe(2);
    expect(jobs.map((j: any) => j.repo_full_name).sort()).toEqual(["octo/app", "octo/lib"]);
  });

  test("lists issues since the stored cursor minus 60s and advances it only after a successful scan", async () => {
    t = setup();
    t.github.repos.set(10, [repo(1)]);
    await t.app.scan(); // 00:00:00, no cursor yet
    await t.clock.advance(60_000);
    t.github.failNextListIssues = true;
    await t.app.scan(); // 00:01:00, fails
    await t.clock.advance(60_000);
    await t.app.scan(); // 00:02:00
    expect(t.github.sinceArgs()).toEqual([
      undefined,
      "2025-12-31T23:59:00.000Z",
      "2025-12-31T23:59:00.000Z",
    ]);
    await t.clock.advance(60_000);
    await t.app.scan();
    expect(t.github.sinceArgs()[3]).toBe("2026-01-01T00:01:00.000Z");
  });

  test("a failing repo does not stop other repos from being scanned", async () => {
    t = setup();
    t.github.repos.set(10, [repo(1), repo(2, "lib")]);
    t.github.issues.set(2, [issue(1)]);
    t.github.failNextListIssues = true;
    await t.app.scan();
    expect((await t.json("/api/jobs")).jobs.map((j: any) => j.repo_full_name)).toEqual(["octo/lib"]);
  });

  test("a failing installation does not stop other installations from being scanned", async () => {
    t = setup();
    t.github.installations.unshift({ id: 11, account: { login: OWNER, type: "User" } });
    t.github.failingInstallations.add(11);
    t.github.repos.set(10, [repo(1)]);
    t.github.issues.set(1, [issue(1)]);
    await t.app.scan();
    expect((await t.json("/api/jobs")).jobs).toHaveLength(1);
  });

  test("start queues issues immediately and then picks up new ones every 60 seconds", async () => {
    t = setup();
    t.github.repos.set(10, [repo(1)]);
    t.github.issues.set(1, [issue(1)]);
    await t.app.start();
    expect((await t.json("/api/jobs")).total).toBe(1);
    t.github.issues.get(1)!.push(issue(2, { updated_at: "2026-01-01T00:00:30Z" }));
    await t.clock.advance(59_000);
    expect((await t.json("/api/jobs")).total).toBe(1);
    await t.clock.advance(1_000);
    expect((await t.json("/api/jobs")).total).toBe(2);
  });
});

describe("API", () => {
  test("requires Basic Auth as admin", async () => {
    t = setup();
    expect((await t.get("/api/jobs", {})).status).toBe(401);
    const wrongUser = { Authorization: `Basic ${btoa(`root:${PASSWORD}`)}` };
    expect((await t.get("/api/jobs", wrongUser)).status).toBe(401);
    const wrongPassword = { Authorization: `Basic ${btoa("admin:nope")}` };
    expect((await t.get("/api/jobs", wrongPassword)).status).toBe(401);
    expect((await t.get("/", {})).status).toBe(401);
    expect((await t.get("/api/jobs")).status).toBe(200);
  });

  test("mutations require a matching Origin", async () => {
    t = setup();
    const post = (headers: Record<string, string>) =>
      t.app.fetch(new Request("http://localhost/api/jobs/1/retry", { method: "POST", headers: { ...t.auth, ...headers } }));
    expect((await post({})).status).toBe(403);
    expect((await post({ Origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ Origin: "http://localhost" })).status).not.toBe(403);
  });

  test("lists the newest jobs first, 50 per page", async () => {
    t = setup();
    t.github.repos.set(10, [repo(1)]);
    t.github.issues.set(1, Array.from({ length: 51 }, (_, i) => issue(i + 1)));
    await t.app.scan();
    const first = await t.json("/api/jobs");
    expect(first.total).toBe(51);
    expect(first.jobs).toHaveLength(50);
    const second = await t.json("/api/jobs?page=2");
    expect(second.jobs).toHaveLength(1);
    expect(first.jobs[0].issue_number).toBe(51);
    expect(first.jobs[49].issue_number).toBe(2);
    expect(second.jobs[0].issue_number).toBe(1);
  });

  test("filters jobs by state", async () => {
    t = setup();
    t.github.repos.set(10, [repo(1)]);
    t.github.issues.set(1, [issue(1)]);
    await t.app.scan();
    expect((await t.json("/api/jobs?state=queued")).total).toBe(1);
    expect((await t.json("/api/jobs?state=failed")).total).toBe(0);
    expect((await t.get("/api/jobs?state=bogus")).status).toBe(400);
  });

  test("gets one job with issue link and timestamps", async () => {
    t = setup();
    t.github.repos.set(10, [repo(1)]);
    t.github.issues.set(1, [issue(4)]);
    await t.app.scan();
    const [{ id }] = (await t.json("/api/jobs")).jobs;
    const job = await t.json(`/api/jobs/${id}`);
    expect(job).toMatchObject({
      id,
      repo_full_name: "octo/app",
      issue_number: 4,
      issue_url: "https://github.com/octo/app/issues/4",
      state: "queued",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    expect((await t.get("/api/jobs/999")).status).toBe(404);
  });

  test("returns issue text verbatim as JSON data", async () => {
    t = setup();
    const title = `<img src=x onerror="alert(1)"> & </script>`;
    t.github.repos.set(10, [repo(1)]);
    t.github.issues.set(1, [issue(1, { title })]);
    await t.app.scan();
    const res = await t.get("/api/jobs");
    expect(res.headers.get("content-type")).toStartWith("application/json");
    expect((await res.json()).jobs[0].issue_title).toBe(title);
  });
});
