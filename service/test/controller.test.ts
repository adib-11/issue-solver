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
  test("queues open issues and creates no job for an issue already closed", async () => {
    t = setup();
    t.github.repos.set(10, [repo(1)]);
    t.github.issues.set(1, [issue(1), issue(3, { state: "CLOSED" })]);
    await t.app.scan();
    const { jobs } = await t.json("/api/jobs");
    expect(jobs.map((j: any) => [j.issue_number, j.state])).toEqual([[1, "queued"]]);
  });

  test("each issue produces exactly one job however many scans see it", async () => {
    t = setup();
    t.github.repos.set(10, [repo(1), repo(2, "lib")]);
    t.github.issues.set(1, [issue(7, { updatedAt: "2026-01-01T00:00:30Z" })]);
    t.github.issues.set(2, [issue(7, { updatedAt: "2026-01-01T00:00:30Z" })]);
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
    t.github.issues.get(1)!.push(issue(2, { updatedAt: "2026-01-01T00:00:30Z" }));
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

const jobStates = async () =>
  Object.fromEntries(
    (await t.json("/api/jobs")).jobs.map((j: any) => [j.issue_number, j.skip_reason ? `${j.state}: ${j.skip_reason}` : j.state]),
  );

describe("intake filters", () => {
  test("skips forks and archived repos without listing their issues", async () => {
    t = setup();
    t.github.repos.set(10, [repo(1), repo(2, "fork", { fork: true }), repo(3, "old", { archived: true })]);
    for (const id of [1, 2, 3]) t.github.issues.set(id, [issue(id)]);
    await t.app.scan();
    expect(t.github.calls.filter((c) => c.op === "listIssues").map((c) => c.args[1])).toEqual(["octo/app"]);
    expect(await jobStates()).toEqual({ 1: "queued" });
  });

  test("only OWNER and COLLABORATOR issues are queued; others are skipped as untrusted author", async () => {
    t = setup();
    t.github.repos.set(10, [repo(1)]);
    const associations = ["OWNER", "COLLABORATOR", "MEMBER", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "NONE"];
    t.github.issues.set(1, associations.map((authorAssociation, i) => issue(i + 1, { authorAssociation })));
    await t.app.scan();
    expect(await jobStates()).toEqual({
      1: "queued",
      2: "queued",
      3: "skipped: untrusted author",
      4: "skipped: untrusted author",
      5: "skipped: untrusted author",
      6: "skipped: untrusted author",
    });
  });

  test("applies the skill bundle's candidate filter to its recorded GraphQL response", async () => {
    t = setup();
    const fixture = await Bun.file(new URL("../../scripts/fixtures/issues.json", import.meta.url)).json();
    t.github.repos.set(10, [repo(1)]);
    t.github.issues.set(1, fixture.data.repository.issues.nodes.map((node: any) => issue(node.number, node)));
    await t.app.scan();
    expect(await jobStates()).toEqual({
      1: "queued",
      2: "skipped: assigned",
      3: "skipped: open closing PR",
      4: "queued",
      5: "skipped: referenced by open PR",
    });
  });

  test("the candidate filter wins over the untrusted-author skip, so Run anyway cannot bypass it", async () => {
    t = setup();
    t.github.repos.set(10, [repo(1)]);
    t.github.issues.set(1, [issue(1, { authorAssociation: "NONE", assignees: { totalCount: 1 } })]);
    await t.app.scan();
    expect(await jobStates()).toEqual({ 1: "skipped: assigned" });
  });

  test("a queued job is skipped when a later scan sees its issue closed or taken", async () => {
    t = setup();
    t.github.repos.set(10, [repo(1)]);
    t.github.issues.set(1, [issue(1), issue(2), issue(3)]);
    await t.app.scan();
    await t.clock.advance(60_000);
    t.github.issues.set(1, [
      issue(1, { state: "CLOSED", updatedAt: "2026-01-01T00:00:30Z" }),
      issue(2, { assignees: { totalCount: 1 }, updatedAt: "2026-01-01T00:00:30Z" }),
      issue(3),
    ]);
    await t.app.scan();
    expect(await jobStates()).toEqual({ 1: "skipped: closed", 2: "skipped: assigned", 3: "queued" });
    const [job] = (await t.json("/api/jobs")).jobs.filter((j: any) => j.issue_number === 1);
    expect((await t.json(`/api/jobs/${job.id}`)).skip_reason).toBe("closed");
  });

  test("a filtered skip lifts when a later scan sees the issue reopened or free, keeping the trust check", async () => {
    t = setup();
    t.github.repos.set(10, [repo(1)]);
    const taken = { assignees: { totalCount: 1 } };
    t.github.issues.set(1, [issue(1), issue(2, taken), issue(3, { ...taken, authorAssociation: "NONE" })]);
    await t.app.scan();
    t.github.issues.set(1, [issue(1, { state: "CLOSED", updatedAt: "2026-01-01T00:00:30Z" }), issue(2, taken), issue(3, taken)]);
    await t.clock.advance(60_000);
    await t.app.scan();
    expect(await jobStates()).toEqual({ 1: "skipped: closed", 2: "skipped: assigned", 3: "skipped: assigned" });
    const later = "2026-01-01T00:01:30Z";
    t.github.issues.set(1, [
      issue(1, { updatedAt: later }),
      issue(2, { updatedAt: later }),
      issue(3, { authorAssociation: "NONE", updatedAt: later }),
    ]);
    await t.clock.advance(60_000);
    await t.app.scan();
    expect(await jobStates()).toEqual({ 1: "queued", 2: "queued", 3: "skipped: untrusted author" });
  });

  test("open issues from every repo are queued oldest first", async () => {
    t = setup();
    t.github.repos.set(10, [repo(1), repo(2, "lib")]);
    t.github.issues.set(1, [
      issue(1, { createdAt: "2024-03-01T00:00:00Z" }),
      issue(2, { createdAt: "2023-01-01T00:00:00Z" }),
    ]);
    t.github.issues.set(2, [issue(9, { createdAt: "2023-06-01T00:00:00Z", updatedAt: "2020-01-01T00:00:00Z" })]);
    await t.app.scan();
    const { jobs } = await t.json("/api/jobs");
    const byId = [...jobs].sort((a: any, b: any) => a.id - b.id);
    expect(byId.map((j: any) => `${j.repo_full_name}#${j.issue_number}`)).toEqual(["octo/app#2", "octo/lib#9", "octo/app#1"]);
  });
});

describe("run anyway", () => {
  test("re-queues an untrusted-author job, and later scans leave it queued", async () => {
    t = setup();
    t.github.repos.set(10, [repo(1)]);
    t.github.issues.set(1, [issue(1, { authorAssociation: "NONE" })]);
    await t.app.scan();
    const [{ id }] = (await t.json("/api/jobs")).jobs;
    await t.clock.advance(1_000);
    const res = await t.post(`/api/jobs/${id}/run-anyway`);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ id, state: "queued", skip_reason: null, updated_at: "2026-01-01T00:00:01.000Z" });
    t.github.issues.set(1, [issue(1, { authorAssociation: "NONE", updatedAt: "2026-01-01T00:00:30Z" })]);
    await t.clock.advance(60_000);
    await t.app.scan();
    expect(await jobStates()).toEqual({ 1: "queued" });
  });

  test("is refused with 409 on any job not skipped for an untrusted author", async () => {
    t = setup();
    t.github.repos.set(10, [repo(1)]);
    t.github.issues.set(1, [issue(1), issue(2, { assignees: { totalCount: 1 } })]);
    await t.app.scan();
    for (const job of (await t.json("/api/jobs")).jobs) {
      expect((await t.post(`/api/jobs/${job.id}/run-anyway`)).status).toBe(409);
    }
    expect(await jobStates()).toEqual({ 1: "queued", 2: "skipped: assigned" });
    expect((await t.post("/api/jobs/999/run-anyway")).status).toBe(404);
  });
});

describe("harness setup", () => {
  test("starts with no harness chosen and lists each harness with its login help", async () => {
    t = setup();
    expect(await t.json("/api/setup")).toEqual({
      harness: null,
      harnesses: [
        { name: "claude-code", label: "Label of claude-code", loginHelp: "Log in to claude-code like this." },
        { name: "other", label: "Label of other", loginHelp: "Log in to other like this." },
      ],
      auth: null,
      paused: null,
      credentialSince: null,
    });
  });

  test("the chosen harness is stored and survives a restart; unknown harnesses are refused", async () => {
    t = setup();
    expect((await t.post("/api/setup", { harness: "claude-code" }, "PUT")).status).toBe(200);
    expect((await t.post("/api/setup", { harness: "nope" }, "PUT")).status).toBe(400);
    expect((await t.post("/api/setup", {}, "PUT")).status).toBe(400);
    t.restart();
    expect((await t.json("/api/setup")).harness).toBe("claude-code");
  });

  test("Test auth needs a chosen harness", async () => {
    t = setup();
    expect((await t.post("/api/setup/test-auth")).status).toBe(409);
    expect(t.harnesses.map((h) => h.authChecks)).toEqual([0, 0]);
  });

  test("Test auth checks the chosen harness and records the result for the header", async () => {
    t = setup();
    await t.post("/api/setup", { harness: "other" }, "PUT");
    const res = await t.post("/api/setup/test-auth");
    expect(res.status).toBe(200);
    expect((await res.json()).auth).toEqual({ state: "ok", checkedAt: "2026-01-01T00:00:00.000Z", log: "other auth: ok" });
    expect(t.harnesses.map((h) => h.authChecks)).toEqual([0, 1]);
    t.restart();
    expect((await t.json("/api/setup")).auth.state).toBe("ok");
  });

  test("an auth or quota failure pauses the queue, and a passing Test auth resumes it", async () => {
    t = setup();
    await t.post("/api/setup", { harness: "claude-code" }, "PUT");
    const [claude] = t.harnesses;
    claude!.authState = "auth";
    await t.post("/api/setup/test-auth");
    expect(await t.json("/api/setup")).toMatchObject({ auth: { state: "auth" }, paused: expect.stringContaining("log in") });
    claude!.authState = "quota";
    await t.post("/api/setup/test-auth");
    expect(await t.json("/api/setup")).toMatchObject({ auth: { state: "quota" }, paused: expect.stringContaining("quota") });
    claude!.authState = "error";
    await t.post("/api/setup/test-auth");
    expect(await t.json("/api/setup")).toMatchObject({ auth: { state: "error" }, paused: expect.stringContaining("quota") });
    claude!.authState = "ok";
    await t.post("/api/setup/test-auth");
    expect(await t.json("/api/setup")).toMatchObject({ auth: { state: "ok" }, paused: null });
  });

  test("choosing another harness forgets the previous auth result", async () => {
    t = setup();
    await t.post("/api/setup", { harness: "claude-code" }, "PUT");
    await t.post("/api/setup/test-auth");
    await t.post("/api/setup", { harness: "other" }, "PUT");
    expect((await t.json("/api/setup")).auth).toBeNull();
  });

  test("shows how long the chosen harness's token has been in use, resetting when the token changes", async () => {
    t = setup();
    await t.post("/api/setup", { harness: "claude-code" }, "PUT");
    expect((await t.json("/api/setup")).credentialSince).toBe("2026-01-01T00:00:00.000Z");
    await t.clock.advance(86_400_000);
    t.restart();
    expect((await t.json("/api/setup")).credentialSince).toBe("2026-01-01T00:00:00.000Z");
    t.harnesses[0]!.credential = "token-2";
    t.restart();
    expect((await t.json("/api/setup")).credentialSince).toBe("2026-01-02T00:00:00.000Z");
    await t.post("/api/setup", { harness: "other" }, "PUT");
    expect((await t.json("/api/setup")).credentialSince).toBeNull();
  });
});
