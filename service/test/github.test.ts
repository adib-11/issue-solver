import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { createGitHubClient } from "../src/github";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

test("retries transient 502 error 3 times with exponential delay and succeeds on retry", async () => {
  const calls: string[] = [];
  const sleeps: number[] = [];
  let attempts = 0;

  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = url.toString();
    calls.push(urlStr);
    if (urlStr.includes("access_tokens")) {
      return new Response(JSON.stringify({ token: "tok-1", expires_at: new Date(Date.now() + 3600_000).toISOString() }), { status: 200 });
    }
    attempts++;
    if (attempts <= 2) {
      return new Response("Bad Gateway", { status: 502, statusText: "Bad Gateway" });
    }
    return new Response(JSON.stringify([{ id: 1, full_name: "octo/app", fork: false, archived: false }]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const client = createGitHubClient("app-123", privateKey, {
    fetch: fakeFetch as any,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    baseDelayMs: 1000,
  });

  const installations = await client.listInstallations();
  expect(installations).toHaveLength(1);
  expect(attempts).toBe(3); // 1 initial + 2 retries
  expect(sleeps).toEqual([1000, 2000]);
});

test("retries 429 respecting Retry-After header", async () => {
  const sleeps: number[] = [];
  let attempts = 0;

  const fakeFetch = async (url: string | URL | Request) => {
    const urlStr = url.toString();
    if (urlStr.includes("access_tokens")) {
      return new Response(JSON.stringify({ token: "tok-1", expires_at: new Date(Date.now() + 3600_000).toISOString() }), { status: 200 });
    }
    if (urlStr.includes("comments")) {
      return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    attempts++;
    if (attempts === 1) {
      return new Response("Too Many Requests", {
        status: 429,
        headers: { "Retry-After": "5" },
      });
    }
    return new Response(JSON.stringify({ title: "Issue 1", html_url: "https://github.com/octo/app/issues/1", state: "open" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const client = createGitHubClient("app-123", privateKey, {
    fetch: fakeFetch as any,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    baseDelayMs: 1000,
  });

  const issue = await client.getIssue(10, "octo/app", 1);
  expect(issue.title).toBe("Issue 1");
  expect(attempts).toBe(2);
  expect(sleeps).toEqual([5000]);
});

test("retries 403 when x-ratelimit-remaining is 0, respecting x-ratelimit-reset", async () => {
  const sleeps: number[] = [];
  let attempts = 0;
  let currentTime = 1_700_000_000_000;

  const fakeFetch = async (url: string | URL | Request) => {
    const urlStr = url.toString();
    if (urlStr.includes("access_tokens")) {
      return new Response(JSON.stringify({ token: "tok-1", expires_at: new Date(currentTime + 3600_000).toISOString() }), { status: 200 });
    }
    if (urlStr.includes("comments")) {
      return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    attempts++;
    if (attempts === 1) {
      return new Response("Rate limit exceeded", {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1700000012", // 12 seconds in epoch
        },
      });
    }
    return new Response(JSON.stringify({ title: "Issue 1", html_url: "https://github.com/octo/app/issues/1", state: "open" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const client = createGitHubClient("app-123", privateKey, {
    fetch: fakeFetch as any,
    sleep: async (ms) => {
      sleeps.push(ms);
      currentTime += ms;
    },
    now: () => currentTime,
    baseDelayMs: 1000,
  });

  const issue = await client.getIssue(10, "octo/app", 1);
  expect(issue.title).toBe("Issue 1");
  expect(attempts).toBe(2);
  expect(sleeps).toEqual([12000]); // 1700000012 - 1700000000 = 12s = 12000ms
});

test("throws immediately on non-transient errors without retrying", async () => {
  const sleeps: number[] = [];
  let attempts = 0;

  const fakeFetch = async (url: string | URL | Request) => {
    const urlStr = url.toString();
    if (urlStr.includes("access_tokens")) {
      return new Response(JSON.stringify({ token: "tok-1", expires_at: new Date(Date.now() + 3600_000).toISOString() }), { status: 200 });
    }
    attempts++;
    return new Response("Not Found", { status: 404 });
  };

  const client = createGitHubClient("app-123", privateKey, {
    fetch: fakeFetch as any,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  expect(client.getIssue(10, "octo/app", 99)).rejects.toThrow("GitHub GET /repos/octo/app/issues/99 -> 404");
  expect(attempts).toBe(1);
  expect(sleeps).toHaveLength(0);
});

test("fails after exhausting 3 retries on persistent 503 error", async () => {
  const sleeps: number[] = [];
  let attempts = 0;

  const fakeFetch = async (url: string | URL | Request) => {
    const urlStr = url.toString();
    if (urlStr.includes("access_tokens")) {
      return new Response(JSON.stringify({ token: "tok-1", expires_at: new Date(Date.now() + 3600_000).toISOString() }), { status: 200 });
    }
    attempts++;
    return new Response("Service Unavailable", { status: 503 });
  };

  const client = createGitHubClient("app-123", privateKey, {
    fetch: fakeFetch as any,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    baseDelayMs: 1000,
  });

  await expect(client.getIssue(10, "octo/app", 1)).rejects.toThrow("GitHub GET /repos/octo/app/issues/1 -> 503");
  expect(attempts).toBe(4); // 1 initial + 3 retries
  expect(sleeps).toEqual([1000, 2000, 4000]);
});

test("retries on network fetch errors", async () => {
  const sleeps: number[] = [];
  let attempts = 0;

  const fakeFetch = async (url: string | URL | Request) => {
    const urlStr = url.toString();
    if (urlStr.includes("access_tokens")) {
      return new Response(JSON.stringify({ token: "tok-1", expires_at: new Date(Date.now() + 3600_000).toISOString() }), { status: 200 });
    }
    if (urlStr.includes("comments")) {
      return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    attempts++;
    if (attempts === 1) {
      throw new TypeError("Failed to fetch");
    }
    return new Response(JSON.stringify({ title: "Issue 1", html_url: "https://github.com/octo/app/issues/1", state: "open" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const client = createGitHubClient("app-123", privateKey, {
    fetch: fakeFetch as any,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    baseDelayMs: 1000,
  });

  const issue = await client.getIssue(10, "octo/app", 1);
  expect(issue.title).toBe("Issue 1");
  expect(attempts).toBe(2);
  expect(sleeps).toEqual([1000]);
});

test("throws immediately on 403 without rate limit indicators (permission denied)", async () => {
  const sleeps: number[] = [];
  let attempts = 0;

  const fakeFetch = async (url: string | URL | Request) => {
    const urlStr = url.toString();
    if (urlStr.includes("access_tokens")) {
      return new Response(JSON.stringify({ token: "tok-1", expires_at: new Date(Date.now() + 3600_000).toISOString() }), { status: 200 });
    }
    attempts++;
    return new Response("Forbidden", {
      status: 403,
      headers: {
        "x-ratelimit-remaining": "4999",
        "x-ratelimit-reset": "1700003600",
      },
    });
  };

  const client = createGitHubClient("app-123", privateKey, {
    fetch: fakeFetch as any,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  await expect(client.getIssue(10, "octo/app", 1)).rejects.toThrow("GitHub GET /repos/octo/app/issues/1 -> 403");
  expect(attempts).toBe(1);
  expect(sleeps).toHaveLength(0);
});
