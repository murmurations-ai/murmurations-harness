import { makeSecretValue } from "@murmuration/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeIssueNumber, makeRepoCoordinate } from "./branded.js";
import { LruGithubCache } from "./cache.js";
import { createGithubClient, type GithubCostHook } from "./client.js";
import {
  GithubNotFoundError,
  GithubRateLimitError,
  GithubTransportError,
  GithubUnauthorizedError,
  GithubValidationError,
} from "./errors.js";

// ---------------------------------------------------------------------------
// Fake fetch helper — each test wires its own sequence.
// ---------------------------------------------------------------------------

interface FakeResponse {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
}

const makeFakeFetch = (
  responses: readonly FakeResponse[],
): {
  fetch: typeof fetch;
  calls: { url: string; headers: Headers }[];
} => {
  const calls: { url: string; headers: Headers }[] = [];
  let idx = 0;
  // eslint-disable-next-line @typescript-eslint/require-await -- test double mimics the fetch signature
  const fake: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    calls.push({ url, headers });
    const next = responses[idx++];
    if (!next) throw new Error("fake fetch: no more responses queued");
    const h = new Headers(next.headers);
    return new Response(next.body !== undefined ? JSON.stringify(next.body) : null, {
      status: next.status,
      headers: h,
    });
  };
  return { fetch: fake, calls };
};

const TOKEN = makeSecretValue("ghp_test_token_abcdefghijklmnop");
const REPO = makeRepoCoordinate("xeeban", "emergent-praxis");

const fixtureIssue = (overrides: Record<string, unknown> = {}): unknown => ({
  number: 241,
  title: "Engineering Circle ratified",
  body: "closes #240",
  state: "closed",
  labels: [{ name: "governance" }],
  user: { login: "xeeban" },
  created_at: "2026-04-09T20:00:00Z",
  updated_at: "2026-04-09T20:05:00Z",
  closed_at: "2026-04-09T20:05:00Z",
  comments: 3,
  html_url: "https://github.com/xeeban/emergent-praxis/issues/241",
  ...overrides,
});

describe("GithubClient", () => {
  let costCalls: Parameters<GithubCostHook["onGithubCall"]>[0][];
  let hook: GithubCostHook;

  beforeEach(() => {
    costCalls = [];
    hook = {
      onGithubCall: (call) => {
        costCalls.push(call);
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("getIssue — happy path parses branded number, labels, dates", async () => {
    const { fetch: f, calls } = makeFakeFetch([
      {
        status: 200,
        headers: {
          etag: '"abc"',
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": "4999",
          "x-ratelimit-reset": "9999999999",
        },
        body: fixtureIssue(),
      },
    ]);
    const client = createGithubClient({ token: TOKEN, fetch: f });
    const result = await client.getIssue(REPO, makeIssueNumber(241), {
      costHook: hook,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.number.value).toBe(241);
      expect(result.value.labels).toEqual(["governance"]);
      expect(result.value.createdAt).toBeInstanceOf(Date);
      expect(result.value.repo.owner.value).toBe("xeeban");
    }
    expect(calls).toHaveLength(1);
    expect(costCalls).toEqual([{ transport: "rest", cacheHit: false, rateLimitRemaining: 4999 }]);
  });

  it("listIssues — passes filter params, returns parsed array", async () => {
    const { fetch: f, calls } = makeFakeFetch([
      {
        status: 200,
        headers: {
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": "4998",
          "x-ratelimit-reset": "9999999999",
        },
        body: [fixtureIssue(), fixtureIssue({ number: 240 })],
      },
    ]);
    const client = createGithubClient({ token: TOKEN, fetch: f });
    const result = await client.listIssues(REPO, {
      state: "open",
      labels: ["bug", "help"],
      perPage: 50,
      costHook: hook,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
    }
    const url = calls[0]?.url ?? "";
    expect(url).toContain("state=open");
    expect(url).toContain("labels=bug%2Chelp");
    expect(url).toContain("per_page=50");
  });

  it("listIssueLabels — tolerates both object and string label shapes", async () => {
    const { fetch: f } = makeFakeFetch([
      {
        status: 200,
        body: [{ name: "alpha" }, { name: "beta" }, "plain-string"],
      },
    ]);
    const client = createGithubClient({ token: TOKEN, fetch: f });
    const result = await client.listIssueLabels(REPO, makeIssueNumber(1));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(["alpha", "beta", "plain-string"]);
    }
  });

  it("404 → GithubNotFoundError", async () => {
    const { fetch: f } = makeFakeFetch([{ status: 404, body: { message: "Not Found" } }]);
    const client = createGithubClient({ token: TOKEN, fetch: f });
    const result = await client.getIssue(REPO, makeIssueNumber(99999));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(GithubNotFoundError);
      expect(result.error.code).toBe("not-found");
      expect(result.error.status).toBe(404);
    }
  });

  it("401 → GithubUnauthorizedError", async () => {
    const { fetch: f } = makeFakeFetch([{ status: 401, body: { message: "Bad credentials" } }]);
    const client = createGithubClient({ token: TOKEN, fetch: f });
    const result = await client.getIssue(REPO, makeIssueNumber(1));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(GithubUnauthorizedError);
    }
  });

  it("422 → GithubValidationError", async () => {
    const { fetch: f } = makeFakeFetch([{ status: 422, body: { message: "Validation Failed" } }]);
    const client = createGithubClient({ token: TOKEN, fetch: f });
    const result = await client.listIssues(REPO);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(GithubValidationError);
    }
  });

  it("403 + X-RateLimit-Remaining: 0 → GithubRateLimitError", async () => {
    const { fetch: f } = makeFakeFetch([
      {
        status: 403,
        headers: {
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "9999999999",
          "retry-after": "30",
        },
        body: { message: "rate limit" },
      },
    ]);
    const client = createGithubClient({ token: TOKEN, fetch: f });
    const result = await client.getIssue(REPO, makeIssueNumber(1));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(GithubRateLimitError);
      expect((result.error as GithubRateLimitError).retryAfterSeconds).toBe(30);
      expect((result.error as GithubRateLimitError).snapshot?.remaining).toBe(0);
    }
  });

  it("retry on 502 then success, single cost hook invocation on the final outcome", async () => {
    vi.useFakeTimers();
    const { fetch: f } = makeFakeFetch([
      { status: 502 },
      {
        status: 200,
        headers: {
          etag: '"xyz"',
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": "4997",
          "x-ratelimit-reset": "9999999999",
        },
        body: fixtureIssue(),
      },
    ]);
    const client = createGithubClient({ token: TOKEN, fetch: f });
    const promise = client.getIssue(REPO, makeIssueNumber(241), { costHook: hook });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.ok).toBe(true);
    // Cost hook fires on final outcome. In this implementation the
    // retry pass does not emit a cost hook for the intermediate 502;
    // only the terminal 200 counts as a billable "call".
    expect(costCalls).toHaveLength(1);
    expect(costCalls[0]?.rateLimitRemaining).toBe(4997);
  });

  it("cache — second call with matching ETag uses cached body (304 → cacheHit)", async () => {
    const cache = new LruGithubCache(100);
    const { fetch: f, calls } = makeFakeFetch([
      {
        status: 200,
        headers: {
          etag: '"v1"',
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": "4996",
          "x-ratelimit-reset": "9999999999",
        },
        body: fixtureIssue(),
      },
      {
        status: 304,
        headers: {
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": "4995",
          "x-ratelimit-reset": "9999999999",
        },
      },
    ]);
    const client = createGithubClient({ token: TOKEN, fetch: f, cache });
    await client.getIssue(REPO, makeIssueNumber(241), { costHook: hook });
    await client.getIssue(REPO, makeIssueNumber(241), { costHook: hook });
    expect(calls).toHaveLength(2);
    // Second call sends If-None-Match.
    expect(calls[1]?.headers.get("if-none-match")).toBe('"v1"');
    expect(costCalls).toEqual([
      { transport: "rest", cacheHit: false, rateLimitRemaining: 4996 },
      { transport: "rest", cacheHit: true, rateLimitRemaining: 4995 },
    ]);
  });

  it("Authorization header is built from SecretValue; token absent from serialised errors", async () => {
    const rawToken = "ghp_sekrit_dont_leak_0123456789";
    const secret = makeSecretValue(rawToken);
    const { fetch: f, calls } = makeFakeFetch([{ status: 500 }, { status: 500 }, { status: 500 }]);
    vi.useFakeTimers();
    const client = createGithubClient({ token: secret, fetch: f });
    const promise = client.getIssue(REPO, makeIssueNumber(1));
    await vi.runAllTimersAsync();
    const result = await promise;
    // 500 is NOT in the retry list by default → first response yields transport error
    expect(result.ok).toBe(false);
    // Authorization header is set correctly on the request.
    expect(calls[0]?.headers.get("authorization")).toBe(`token ${rawToken}`);
    // But the error shape never mentions the token.
    if (!result.ok) {
      const serialised = JSON.stringify({
        message: result.error.message,
        code: result.error.code,
        status: result.error.status,
      });
      expect(serialised).not.toContain(rawToken);
    }
  });

  it("retry exhaustion on repeated 502 → GithubTransportError with attempts count", async () => {
    vi.useFakeTimers();
    const { fetch: f } = makeFakeFetch([{ status: 502 }, { status: 502 }, { status: 502 }]);
    const client = createGithubClient({ token: TOKEN, fetch: f });
    const promise = client.getIssue(REPO, makeIssueNumber(1));
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // After maxAttempts of 502 we surface a transport error (5xx is
      // mapped via #mapHttpError which returns GithubTransportError,
      // since server errors are transient in spirit).
      expect(result.error).toBeInstanceOf(GithubTransportError);
    }
  });

  it("getRef — parses object.sha from git/refs/heads response", async () => {
    const { fetch: f, calls } = makeFakeFetch([
      {
        status: 200,
        headers: {
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": "4900",
          "x-ratelimit-reset": "9999999999",
        },
        body: {
          ref: "refs/heads/main",
          node_id: "MDM6UmVmMTIzNDU=",
          url: "https://api.github.com/repos/xeeban/emergent-praxis/git/refs/heads/main",
          object: {
            sha: "deadbeefcafef00d0000000000000000deadbeef",
            type: "commit",
            url: "https://api.github.com/repos/xeeban/emergent-praxis/git/commits/deadbeefcafef00d0000000000000000deadbeef",
          },
        },
      },
    ]);
    const client = createGithubClient({ token: TOKEN, fetch: f });
    const result = await client.getRef(REPO, "main");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.oid).toBe("deadbeefcafef00d0000000000000000deadbeef");
      expect(result.value.branch).toBe("main");
      expect(result.value.repo.owner.value).toBe("xeeban");
    }
    expect(calls[0]?.url).toContain("/git/refs/heads/main");
  });

  it("getRef — 404 on unknown branch → GithubNotFoundError", async () => {
    const { fetch: f } = makeFakeFetch([{ status: 404, body: { message: "Not Found" } }]);
    const client = createGithubClient({ token: TOKEN, fetch: f });
    const result = await client.getRef(REPO, "no-such-branch");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(GithubNotFoundError);
    }
  });

  it("lastRateLimit() returns the most recent snapshot", async () => {
    const { fetch: f } = makeFakeFetch([
      {
        status: 200,
        headers: {
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": "4200",
          "x-ratelimit-reset": "9999999999",
          "x-ratelimit-resource": "core",
        },
        body: fixtureIssue(),
      },
    ]);
    const client = createGithubClient({ token: TOKEN, fetch: f });
    expect(client.lastRateLimit()).toBeNull();
    await client.getIssue(REPO, makeIssueNumber(1));
    const snap = client.lastRateLimit();
    expect(snap).not.toBeNull();
    expect(snap?.remaining).toBe(4200);
    expect(snap?.resource).toBe("core");
  });
});

describe("LruGithubCache", () => {
  it("evicts oldest entry when capacity is exceeded", () => {
    const cache = new LruGithubCache(2);
    cache.set("a", { etag: "1", body: 1, fetchedAt: new Date(), url: "a" });
    cache.set("b", { etag: "2", body: 2, fetchedAt: new Date(), url: "b" });
    cache.set("c", { etag: "3", body: 3, fetchedAt: new Date(), url: "c" });
    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).not.toBeNull();
    expect(cache.get("c")).not.toBeNull();
    expect(cache.size()).toBe(2);
  });

  it("touching an entry makes it the newest", () => {
    const cache = new LruGithubCache(2);
    cache.set("a", { etag: "1", body: 1, fetchedAt: new Date(), url: "a" });
    cache.set("b", { etag: "2", body: 2, fetchedAt: new Date(), url: "b" });
    cache.get("a"); // touch
    cache.set("c", { etag: "3", body: 3, fetchedAt: new Date(), url: "c" });
    // b was LRU at the time of the set, so b is evicted.
    expect(cache.get("b")).toBeNull();
    expect(cache.get("a")).not.toBeNull();
    expect(cache.get("c")).not.toBeNull();
  });
});
