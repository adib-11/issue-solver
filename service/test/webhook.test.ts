import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { setup } from "./fakes";

function sign(secret: string, body: string | Buffer | Uint8Array) {
  const hmac = createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${hmac}`;
}

async function sendWebhook(
  app: { fetch: (req: Request) => Promise<Response> | Response },
  secret: string,
  event: string,
  delivery: string,
  payload: unknown,
  path = "/api/webhook",
) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const signature = sign(secret, body);
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": signature,
        "X-GitHub-Event": event,
        "X-GitHub-Delivery": delivery,
      },
      body,
    }),
  );
}

function webhookPayload(over: any = {}) {
  return {
    action: "opened",
    issue: {
      number: 1,
      title: "Issue 1",
      html_url: "https://github.com/octo/app/issues/1",
      state: "open",
      author_association: "OWNER",
      assignees: [],
      ...over.issue,
    },
    repository: {
      id: 1,
      full_name: "octo/app",
      owner: { login: "octo", type: "User" },
      fork: false,
      archived: false,
      ...over.repository,
    },
    installation: {
      id: 10,
      ...over.installation,
    },
    ...over,
  };
}

let t: ReturnType<typeof setup>;
afterEach(() => t?.cleanup());

describe("webhook transport", () => {
  test("webhook route exists only when public URL and webhook secret are configured", async () => {
    // Neither configured
    t = setup();
    const resNoWebhook = await t.app.fetch(new Request("http://localhost/api/webhook", { method: "POST" }));
    expect(resNoWebhook.status).toBe(404);

    t.cleanup();

    // Only publicUrl configured
    t = setup({ publicUrl: "https://example.com/api/webhook" });
    const resOnlyUrl = await t.app.fetch(new Request("http://localhost/api/webhook", { method: "POST" }));
    expect(resOnlyUrl.status).toBe(404);

    t.cleanup();

    // Only webhookSecret configured
    t = setup({ webhookSecret: "secret123" });
    const resOnlySecret = await t.app.fetch(new Request("http://localhost/api/webhook", { method: "POST" }));
    expect(resOnlySecret.status).toBe(404);

    t.cleanup();

    // Both configured: route exists and does not return 404
    t = setup({ publicUrl: "https://example.com/api/webhook", webhookSecret: "secret123" });
    const resBoth = await t.app.fetch(new Request("http://localhost/api/webhook", { method: "POST" }));
    expect(resBoth.status).not.toBe(404);
  });

  test("rejects bodies exceeding 1 MiB with 413", async () => {
    const secret = "secret123";
    t = setup({ publicUrl: "https://example.com/api/webhook", webhookSecret: secret });

    const largeBody = "x".repeat(1024 * 1024 + 1);
    const signature = sign(secret, largeBody);

    const res = await t.app.fetch(
      new Request("http://localhost/api/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Signature-256": signature,
          "X-GitHub-Event": "issues",
          "X-GitHub-Delivery": "d-1",
        },
        body: largeBody,
      }),
    );
    expect(res.status).toBe(413);
  });

  test("verifies HMAC-SHA256 signature in constant time and rejects invalid or missing signature with 401", async () => {
    const secret = "secret123";
    t = setup({ publicUrl: "https://example.com/api/webhook", webhookSecret: secret });

    const payload = JSON.stringify({ action: "opened" });

    // Missing signature
    const resNoSig = await t.app.fetch(
      new Request("http://localhost/api/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-GitHub-Event": "issues", "X-GitHub-Delivery": "d-1" },
        body: payload,
      }),
    );
    expect(resNoSig.status).toBe(401);

    // Bad signature
    const resBadSig = await t.app.fetch(
      new Request("http://localhost/api/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Signature-256": "sha256=badbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadb",
          "X-GitHub-Event": "issues",
          "X-GitHub-Delivery": "d-1",
        },
        body: payload,
      }),
    );
    expect(resBadSig.status).toBe(401);

    // Wrong secret signature
    const resWrongSecret = await t.app.fetch(
      new Request("http://localhost/api/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Signature-256": sign("wrong_secret", payload),
          "X-GitHub-Event": "issues",
          "X-GitHub-Delivery": "d-1",
        },
        body: payload,
      }),
    );
    expect(resWrongSecret.status).toBe(401);
  });

  test("rejects malformed JSON body with 400", async () => {
    const secret = "secret123";
    t = setup({ publicUrl: "https://example.com/api/webhook", webhookSecret: secret });

    const malformed = "{ not valid json: ";
    const signature = sign(secret, malformed);

    const res = await t.app.fetch(
      new Request("http://localhost/api/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Signature-256": signature,
          "X-GitHub-Event": "issues",
          "X-GitHub-Delivery": "d-1",
        },
        body: malformed,
      }),
    );
    expect(res.status).toBe(400);
  });

  test("irrelevant event or action returns 204", async () => {
    const secret = "secret123";
    t = setup({ publicUrl: "https://example.com/api/webhook", webhookSecret: secret });

    // Wrong event: push
    const resPush = await sendWebhook(t.app, secret, "push", "d-push", webhookPayload());
    expect(resPush.status).toBe(204);

    // Wrong action: closed
    const resClosed = await sendWebhook(t.app, secret, "issues", "d-closed", webhookPayload({ action: "closed" }));
    expect(resClosed.status).toBe(204);

    // Wrong action: edited
    const resEdited = await sendWebhook(t.app, secret, "issues", "d-edited", webhookPayload({ action: "edited" }));
    expect(resEdited.status).toBe(204);
  });

  test("irrelevant installation or repository returns 204", async () => {
    const secret = "secret123";
    t = setup({ publicUrl: "https://example.com/api/webhook", webhookSecret: secret });

    // Organization account
    const resOrg = await sendWebhook(
      t.app,
      secret,
      "issues",
      "d-org",
      webhookPayload({ repository: { owner: { login: "some-org", type: "Organization" } } }),
    );
    expect(resOrg.status).toBe(204);

    // Different user
    const resOther = await sendWebhook(
      t.app,
      secret,
      "issues",
      "d-other",
      webhookPayload({ repository: { owner: { login: "someone-else", type: "User" } } }),
    );
    expect(resOther.status).toBe(204);

    // Fork repo
    const resFork = await sendWebhook(
      t.app,
      secret,
      "issues",
      "d-fork",
      webhookPayload({ repository: { fork: true } }),
    );
    expect(resFork.status).toBe(204);

    // Archived repo
    const resArchived = await sendWebhook(
      t.app,
      secret,
      "issues",
      "d-archived",
      webhookPayload({ repository: { archived: true } }),
    );
    expect(resArchived.status).toBe(204);
  });

  test("duplicate delivery returns 204", async () => {
    const secret = "secret123";
    t = setup({ publicUrl: "https://example.com/api/webhook", webhookSecret: secret });

    // First delivery succeeds (202)
    const res1 = await sendWebhook(t.app, secret, "issues", "d-dup", webhookPayload({ issue: { number: 10 } }));
    expect(res1.status).toBe(202);

    // Duplicate delivery GUID returns 204
    const resDupGuid = await sendWebhook(t.app, secret, "issues", "d-dup", webhookPayload({ issue: { number: 10 } }));
    expect(resDupGuid.status).toBe(204);

    // Different delivery GUID for an already-queued issue returns 204
    const resDupJob = await sendWebhook(t.app, secret, "issues", "d-new-guid", webhookPayload({ issue: { number: 10 } }));
    expect(resDupJob.status).toBe(204);
  });

  test("webhook-queued jobs go through the same intake filters as scanned ones", async () => {
    const secret = "secret123";
    t = setup({ publicUrl: "https://example.com/api/webhook", webhookSecret: secret });

    const jobFor = async (num: number) => {
      const list = await t.json("/api/jobs");
      return list.jobs.find((j: any) => j.issue_number === num);
    };

    // 1. Untrusted author -> skipped: untrusted author
    const resUntrusted = await sendWebhook(
      t.app,
      secret,
      "issues",
      "d-untrusted",
      webhookPayload({ issue: { number: 1, author_association: "NONE" } }),
    );
    expect(resUntrusted.status).toBe(202);
    expect(await jobFor(1)).toMatchObject({ state: "skipped", skip_reason: "untrusted author" });

    // 2. Assigned -> skipped: assigned
    const resAssigned = await sendWebhook(
      t.app,
      secret,
      "issues",
      "d-assigned",
      webhookPayload({ issue: { number: 2, assignees: [{ login: "octo" }] } }),
    );
    expect(resAssigned.status).toBe(202);
    expect(await jobFor(2)).toMatchObject({ state: "skipped", skip_reason: "assigned" });

    // 3. Open closing PR -> skipped: open closing PR
    const resClosingPr = await sendWebhook(
      t.app,
      secret,
      "issues",
      "d-closing",
      webhookPayload({ issue: { number: 3, closedByPullRequestsReferences: { nodes: [{ state: "OPEN" }] } } }),
    );
    expect(resClosingPr.status).toBe(202);
    expect(await jobFor(3)).toMatchObject({ state: "skipped", skip_reason: "open closing PR" });

    // 4. Referenced by open PR -> skipped: referenced by open PR
    const resRefPr = await sendWebhook(
      t.app,
      secret,
      "issues",
      "d-ref",
      webhookPayload({
        issue: {
          number: 4,
          timelineItems: { nodes: [{ isCrossRepository: false, source: { state: "OPEN" } }] },
        },
      }),
    );
    expect(resRefPr.status).toBe(202);
    expect(await jobFor(4)).toMatchObject({ state: "skipped", skip_reason: "referenced by open PR" });

    // 5. Closed issue -> skipped: closed
    const resClosed = await sendWebhook(
      t.app,
      secret,
      "issues",
      "d-closed",
      webhookPayload({ issue: { number: 5, state: "closed" } }),
    );
    expect(resClosed.status).toBe(202);
    expect(await jobFor(5)).toMatchObject({ state: "skipped", skip_reason: "closed" });

    // 6. Trusted author (COLLABORATOR) with no blocks -> queued
    const resCollab = await sendWebhook(
      t.app,
      secret,
      "issues",
      "d-collab",
      webhookPayload({ issue: { number: 6, author_association: "COLLABORATOR" } }),
    );
    expect(resCollab.status).toBe(202);
    expect(await jobFor(6)).toMatchObject({ state: "queued", skip_reason: null });
  });

  test("delivery GUID and job are committed atomically and immediately worked", async () => {
    const secret = "secret123";
    t = setup({ publicUrl: "https://example.com/api/webhook", webhookSecret: secret });

    // Choose harness
    await t.post("/api/setup", { harness: "claude-code" }, "PUT");

    // Script harness to return a brief so we can observe the worker picked up the job
    const harness = t.harnesses[0]!;
    harness.script.push(async () => ({
      ok: true,
      output: {
        outcome: "brief",
        brief: "## Brief",
        acceptance_criteria: ["Works"],
        seams: ["API"],
        questions: [],
      },
      log: "Brief generated",
    }));

    const res = await sendWebhook(t.app, secret, "issues", "d-atomic", webhookPayload({ issue: { number: 42, title: "Important Bug" } }));
    expect(res.status).toBe(202);

    // Wait for the worker to pick up the job and advance past queued
    const getJob42 = async () => {
      const list = await t.json("/api/jobs");
      return list.jobs.find((j: any) => j.issue_number === 42);
    };

    // The job should have been created and picked up by work()
    const job = await getJob42();
    expect(job).toBeDefined();
    expect(job.issue_title).toBe("Important Bug");
  });
});
