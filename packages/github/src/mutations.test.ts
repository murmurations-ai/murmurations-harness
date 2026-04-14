/**
 * ADR-0017 — GitHub mutation surface test specs.
 *
 * Covers the 15-18 specs enumerated in §10 of the ADR:
 *  - happy paths for createIssueComment, createIssue, createCommitOnBranch
 *  - default-deny (no writeScopes), per-kind scope denials, glob matching
 *  - multi-addition denial short-circuits before any network I/O
 *  - 409 stale HEAD → GithubConflictError
 *  - 422 → GithubValidationError on REST mutation body
 *  - single-attempt regression guards on 503 and transport reject
 *  - cost hook fires once per mutation with correct `transport`
 *  - cost hook fires on scope denial without `rateLimitRemaining`
 *  - token scrubbing on mutation error path
 *  - base64 encoding invariant
 *  - in-flight abort → GithubMutationAbortedError Result, phase "in-flight"
 */

import { makeSecretValue } from "@murmurations-ai/core";
import { beforeEach, describe, expect, it } from "vitest";

import { makeIssueNumber, makeRepoCoordinate } from "./branded.js";
import { createGithubClient, type GithubCostHook } from "./client.js";
import {
  GithubConflictError,
  GithubMutationAbortedError,
  GithubTransportError,
  GithubValidationError,
  GithubWriteScopeError,
} from "./errors.js";
import type { GithubWriteScopes } from "./write-scopes.js";

// ---------------------------------------------------------------------------
// Fake fetch with call counting and optional body introspection
// ---------------------------------------------------------------------------

interface FakeResponse {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
  readonly throwOnCall?: unknown; // throw this instead of returning
}

interface FakeFetchHandle {
  readonly fetch: typeof fetch;
  readonly calls: { url: string; method: string; body: string | null }[];
}

const makeFakeFetch = (responses: readonly FakeResponse[]): FakeFetchHandle => {
  const calls: { url: string; method: string; body: string | null }[] = [];
  let idx = 0;
  // eslint-disable-next-line @typescript-eslint/require-await
  const fake: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const rawBody = init?.body;
    const body = typeof rawBody === "string" ? rawBody : null;
    calls.push({ url, method, body });
    const next = responses[idx++];
    if (!next) throw new Error("fake fetch: no more responses queued");
    if (next.throwOnCall !== undefined) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- test helper replays arbitrary thrown values
      throw next.throwOnCall;
    }
    const h = new Headers(next.headers);
    return new Response(next.body !== undefined ? JSON.stringify(next.body) : null, {
      status: next.status,
      headers: h,
    });
  };
  return { fetch: fake, calls };
};

const TOKEN = makeSecretValue("ghp_mutation_test_token_abcdefgh");
const REPO = makeRepoCoordinate("xeeban", "emergent-praxis");

const SCOPES_ALL: GithubWriteScopes = {
  issueComments: ["xeeban/emergent-praxis"],
  branchCommits: [
    { repo: "xeeban/emergent-praxis", paths: ["notes/weekly/**", "chronicles/**/*.md"] },
  ],
  labels: ["xeeban/emergent-praxis"],
  issues: ["xeeban/emergent-praxis"],
};

describe("GithubClient mutations (ADR-0017)", () => {
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

  // -- Spec 1 --------------------------------------------------------------
  it("createIssueComment happy path", async () => {
    const { fetch: f, calls } = makeFakeFetch([
      {
        status: 201,
        headers: {
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": "4900",
          "x-ratelimit-reset": "9999999999",
        },
        body: {
          id: 99887766,
          body: "weekly digest is live: notes/weekly/2026-04-09.md",
          created_at: "2026-04-09T18:00:00Z",
          html_url: "https://github.com/xeeban/emergent-praxis/issues/241#issuecomment-99887766",
        },
      },
    ]);
    const client = createGithubClient({ token: TOKEN, fetch: f, writeScopes: SCOPES_ALL });
    const result = await client.createIssueComment(
      REPO,
      makeIssueNumber(241),
      { body: "weekly digest is live: notes/weekly/2026-04-09.md" },
      { costHook: hook },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe(99887766);
      expect(result.value.issueNumber.value).toBe(241);
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/issues/241/comments");
    expect(costCalls).toEqual([{ transport: "rest", cacheHit: false, rateLimitRemaining: 4900 }]);
  });

  // -- Spec 2 --------------------------------------------------------------
  it("createIssueComment denies when repo not in issueComments scope", async () => {
    const { fetch: f, calls } = makeFakeFetch([]);
    const scoped: GithubWriteScopes = {
      ...SCOPES_ALL,
      issueComments: ["other/repo"],
    };
    const client = createGithubClient({ token: TOKEN, fetch: f, writeScopes: scoped });
    const result = await client.createIssueComment(
      REPO,
      makeIssueNumber(1),
      { body: "nope" },
      { costHook: hook },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(GithubWriteScopeError);
      expect((result.error as GithubWriteScopeError).scopeKind).toBe("issue-comment");
      expect((result.error as GithubWriteScopeError).attemptedRepo).toBe("xeeban/emergent-praxis");
    }
    expect(calls).toHaveLength(0);
    expect(costCalls).toHaveLength(1);
    expect(costCalls[0]?.rateLimitRemaining).toBeUndefined();
  });

  // -- Spec 3 --------------------------------------------------------------
  it("mutations default-deny when no writeScopes config is provided", async () => {
    const { fetch: f, calls } = makeFakeFetch([]);
    const client = createGithubClient({ token: TOKEN, fetch: f }); // no writeScopes
    const result = await client.createIssueComment(
      REPO,
      makeIssueNumber(1),
      { body: "x" },
      { costHook: hook },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(GithubWriteScopeError);
      expect(result.error.message).toContain("no write scopes configured");
    }
    expect(calls).toHaveLength(0);
    expect(costCalls).toHaveLength(1);
  });

  // -- Spec 4 --------------------------------------------------------------
  it("createCommitOnBranch happy path (GraphQL, parses oid + url)", async () => {
    const { fetch: f, calls } = makeFakeFetch([
      {
        status: 200,
        headers: {
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": "4800",
          "x-ratelimit-reset": "9999999999",
          "x-ratelimit-resource": "graphql",
        },
        body: {
          data: {
            createCommitOnBranch: {
              commit: {
                oid: "deadbeefcafef00d0000000000000000deadbeef",
                url: "https://github.com/xeeban/emergent-praxis/commit/deadbeef",
              },
            },
          },
        },
      },
    ]);
    const client = createGithubClient({ token: TOKEN, fetch: f, writeScopes: SCOPES_ALL });
    const result = await client.createCommitOnBranch(
      REPO,
      "main",
      { headline: "research: weekly digest 2026-04-09" },
      {
        additions: [{ path: "notes/weekly/2026-04-09.md", contents: "# hello\n" }],
      },
      "feedface0000000000000000000000000000face",
      { costHook: hook },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.oid).toBe("deadbeefcafef00d0000000000000000deadbeef");
      expect(result.value.branch).toBe("main");
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.endsWith("/graphql")).toBe(true);
    expect(costCalls).toEqual([
      { transport: "graphql", cacheHit: false, rateLimitRemaining: 4800 },
    ]);
  });

  // -- Spec 5 --------------------------------------------------------------
  it("createCommitOnBranch denies when repo not in branchCommits scope", async () => {
    const { fetch: f, calls } = makeFakeFetch([]);
    const scoped: GithubWriteScopes = {
      ...SCOPES_ALL,
      branchCommits: [{ repo: "other/repo", paths: ["**"] }],
    };
    const client = createGithubClient({ token: TOKEN, fetch: f, writeScopes: scoped });
    const result = await client.createCommitOnBranch(
      REPO,
      "main",
      { headline: "x" },
      { additions: [{ path: "notes/weekly/x.md", contents: "x" }] },
      "headoid",
      { costHook: hook },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(GithubWriteScopeError);
    expect(calls).toHaveLength(0);
  });

  // -- Spec 6 --------------------------------------------------------------
  it("createCommitOnBranch allows path matching ** glob", async () => {
    const { fetch: f } = makeFakeFetch([
      {
        status: 200,
        body: {
          data: {
            createCommitOnBranch: {
              commit: { oid: "a".repeat(40), url: "https://x" },
            },
          },
        },
      },
    ]);
    const scoped: GithubWriteScopes = {
      ...SCOPES_ALL,
      branchCommits: [{ repo: "xeeban/emergent-praxis", paths: ["**"] }],
    };
    const client = createGithubClient({ token: TOKEN, fetch: f, writeScopes: scoped });
    const result = await client.createCommitOnBranch(
      REPO,
      "main",
      { headline: "x" },
      { additions: [{ path: "anywhere/at/all/file.md", contents: "x" }] },
      "headoid",
    );
    expect(result.ok).toBe(true);
  });

  // -- Spec 7 --------------------------------------------------------------
  it("createCommitOnBranch denies paths outside the configured globs", async () => {
    const { fetch: f, calls } = makeFakeFetch([]);
    const client = createGithubClient({ token: TOKEN, fetch: f, writeScopes: SCOPES_ALL });
    const result = await client.createCommitOnBranch(
      REPO,
      "main",
      { headline: "x" },
      { additions: [{ path: "src/secret.ts", contents: "x" }] },
      "headoid",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(GithubWriteScopeError);
      expect((result.error as GithubWriteScopeError).attemptedPath).toBe("src/secret.ts");
    }
    expect(calls).toHaveLength(0);
  });

  // -- Spec 8 --------------------------------------------------------------
  it("createCommitOnBranch with two additions, one non-matching, denies entire commit without any network call", async () => {
    const { fetch: f, calls } = makeFakeFetch([]);
    const client = createGithubClient({ token: TOKEN, fetch: f, writeScopes: SCOPES_ALL });
    const result = await client.createCommitOnBranch(
      REPO,
      "main",
      { headline: "x" },
      {
        additions: [
          { path: "notes/weekly/ok.md", contents: "ok" },
          { path: "packages/evil.ts", contents: "nope" },
        ],
      },
      "headoid",
    );
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0); // fake fetch called zero times
  });

  // -- Spec 9 --------------------------------------------------------------
  it("createCommitOnBranch stale HEAD → GithubConflictError with expectedHeadOid", async () => {
    const { fetch: f } = makeFakeFetch([
      {
        status: 200,
        body: {
          data: { createCommitOnBranch: null },
          errors: [
            {
              type: undefined,
              message: "Expected branch to have oid abc123 but it is not a fast-forward",
            },
          ],
        },
      },
    ]);
    const client = createGithubClient({ token: TOKEN, fetch: f, writeScopes: SCOPES_ALL });
    const result = await client.createCommitOnBranch(
      REPO,
      "main",
      { headline: "x" },
      { additions: [{ path: "notes/weekly/x.md", contents: "x" }] },
      "feedface0000000000000000000000000000face",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(GithubConflictError);
      expect((result.error as GithubConflictError).expectedHeadOid).toBe(
        "feedface0000000000000000000000000000face",
      );
    }
  });

  // -- Spec 10 -------------------------------------------------------------
  it("createIssue happy path", async () => {
    const { fetch: f } = makeFakeFetch([
      {
        status: 201,
        headers: {
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": "4700",
          "x-ratelimit-reset": "9999999999",
        },
        body: {
          number: 242,
          title: "tension: content flow underperforming",
          html_url: "https://github.com/xeeban/emergent-praxis/issues/242",
          created_at: "2026-04-09T19:00:00Z",
        },
      },
    ]);
    const client = createGithubClient({ token: TOKEN, fetch: f, writeScopes: SCOPES_ALL });
    const result = await client.createIssue(
      REPO,
      { title: "tension: content flow underperforming", labels: ["tension"] },
      { costHook: hook },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.number.value).toBe(242);
      expect(result.value.title).toBe("tension: content flow underperforming");
    }
    expect(costCalls).toEqual([{ transport: "rest", cacheHit: false, rateLimitRemaining: 4700 }]);
  });

  // -- Spec 11 -------------------------------------------------------------
  it("createIssue 422 → GithubValidationError", async () => {
    const { fetch: f } = makeFakeFetch([{ status: 422, body: { message: "Validation Failed" } }]);
    const client = createGithubClient({ token: TOKEN, fetch: f, writeScopes: SCOPES_ALL });
    const result = await client.createIssue(REPO, { title: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(GithubValidationError);
  });

  // -- Spec 12 -------------------------------------------------------------
  it("mutation transport reject → GithubTransportError attempts=1 (single-attempt regression guard)", async () => {
    const { fetch: f, calls } = makeFakeFetch([
      { status: 0, throwOnCall: new TypeError("socket hang up") },
    ]);
    const client = createGithubClient({ token: TOKEN, fetch: f, writeScopes: SCOPES_ALL });
    const result = await client.createIssueComment(REPO, makeIssueNumber(1), { body: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(GithubTransportError);
      expect((result.error as GithubTransportError).attempts).toBe(1);
    }
    expect(calls).toHaveLength(1); // fetch called exactly once — no retry
  });

  // -- Spec 13 -------------------------------------------------------------
  it("mutation 503 → GithubTransportError attempts=1, fetch called once", async () => {
    const { fetch: f, calls } = makeFakeFetch([{ status: 503 }]);
    const client = createGithubClient({ token: TOKEN, fetch: f, writeScopes: SCOPES_ALL });
    const result = await client.createIssueComment(REPO, makeIssueNumber(1), { body: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(GithubTransportError);
      expect((result.error as GithubTransportError).attempts).toBe(1);
    }
    expect(calls).toHaveLength(1);
  });

  // -- Spec 14 -------------------------------------------------------------
  it("cost hook fires exactly once per mutation with correct transport (parameterized)", async () => {
    const { fetch: f } = makeFakeFetch([
      {
        status: 201,
        body: {
          id: 1,
          body: "b",
          created_at: "2026-04-09T19:00:00Z",
          html_url: "https://x",
        },
      },
      {
        status: 200,
        body: {
          data: {
            createCommitOnBranch: { commit: { oid: "a".repeat(40), url: "https://x" } },
          },
        },
      },
    ]);
    const client = createGithubClient({ token: TOKEN, fetch: f, writeScopes: SCOPES_ALL });
    await client.createIssueComment(REPO, makeIssueNumber(1), { body: "x" }, { costHook: hook });
    await client.createCommitOnBranch(
      REPO,
      "main",
      { headline: "x" },
      { additions: [{ path: "notes/weekly/x.md", contents: "x" }] },
      "headoid",
      { costHook: hook },
    );
    expect(costCalls).toHaveLength(2);
    expect(costCalls[0]?.transport).toBe("rest");
    expect(costCalls[1]?.transport).toBe("graphql");
  });

  // -- Spec 15 -------------------------------------------------------------
  it("cost hook fires on scope denial without rateLimitRemaining", async () => {
    const { fetch: f } = makeFakeFetch([]);
    const client = createGithubClient({ token: TOKEN, fetch: f }); // no scopes
    await client.createIssueComment(REPO, makeIssueNumber(1), { body: "x" }, { costHook: hook });
    expect(costCalls).toHaveLength(1);
    expect(costCalls[0]?.rateLimitRemaining).toBeUndefined();
    expect(costCalls[0]?.cacheHit).toBe(false);
  });

  // -- Spec 16 -------------------------------------------------------------
  it("token scrubbing on mutation error path", async () => {
    const rawToken = "ghp_dont_leak_meXXXXXXXXXXXXXXXX";
    const secret = makeSecretValue(rawToken);
    const { fetch: f } = makeFakeFetch([
      { status: 0, throwOnCall: new Error(`fetch failed with header token ${rawToken}`) },
    ]);
    const client = createGithubClient({ token: secret, fetch: f, writeScopes: SCOPES_ALL });
    const result = await client.createIssueComment(REPO, makeIssueNumber(1), { body: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const serialised = JSON.stringify({
        message: result.error.message,
        code: result.error.code,
      });
      expect(serialised).not.toContain(rawToken);
    }
  });

  // -- Spec 17 -------------------------------------------------------------
  it("createCommitOnBranch base64-encodes UTF-8 contents ('# hello\\n' → 'IyBoZWxsbwo=')", async () => {
    const { fetch: f, calls } = makeFakeFetch([
      {
        status: 200,
        body: {
          data: {
            createCommitOnBranch: { commit: { oid: "a".repeat(40), url: "https://x" } },
          },
        },
      },
    ]);
    const client = createGithubClient({ token: TOKEN, fetch: f, writeScopes: SCOPES_ALL });
    await client.createCommitOnBranch(
      REPO,
      "main",
      { headline: "x" },
      { additions: [{ path: "notes/weekly/x.md", contents: "# hello\n" }] },
      "headoid",
    );
    const sent = JSON.parse(calls[0]?.body ?? "{}") as {
      variables: {
        input: {
          fileChanges: { additions: { path: string; contents: string }[] };
        };
      };
    };
    expect(sent.variables.input.fileChanges.additions[0]?.contents).toBe("IyBoZWxsbwo=");
  });

  // -- Spec 18 -------------------------------------------------------------
  it("mutation in-flight abort → GithubMutationAbortedError Result (not throw), phase 'in-flight'", async () => {
    const abortError = new Error("aborted");
    (abortError as { name: string }).name = "AbortError";
    const { fetch: f } = makeFakeFetch([{ status: 0, throwOnCall: abortError }]);
    const client = createGithubClient({ token: TOKEN, fetch: f, writeScopes: SCOPES_ALL });
    const controller = new AbortController();
    const result = await client.createIssueComment(
      REPO,
      makeIssueNumber(1),
      { body: "x" },
      { signal: controller.signal },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(GithubMutationAbortedError);
      expect((result.error as GithubMutationAbortedError).phase).toBe("in-flight");
    }
  });

  // -- addLabels -------------------------------------------------------------
  it("addLabels happy path", async () => {
    const { fetch: f, calls } = makeFakeFetch([
      {
        status: 200,
        body: [
          { id: 1, name: "priority:high" },
          { id: 2, name: "group:content" },
        ],
      },
    ]);
    const client = createGithubClient({ token: TOKEN, fetch: f, writeScopes: SCOPES_ALL });
    const result = await client.addLabels(REPO, makeIssueNumber(42), ["priority:high"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toContain("priority:high");
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/issues/42/labels");
  });

  it("addLabels denied without label write scope", async () => {
    const { fetch: f } = makeFakeFetch([]);
    const client = createGithubClient({
      token: TOKEN,
      fetch: f,
      writeScopes: { ...SCOPES_ALL, labels: [] },
    });
    const result = await client.addLabels(REPO, makeIssueNumber(1), ["priority:high"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(GithubWriteScopeError);
  });

  // -- removeLabel -----------------------------------------------------------
  it("removeLabel happy path", async () => {
    const { fetch: f, calls } = makeFakeFetch([{ status: 200, body: [] }]);
    const client = createGithubClient({ token: TOKEN, fetch: f, writeScopes: SCOPES_ALL });
    const result = await client.removeLabel(REPO, makeIssueNumber(42), "priority:low");
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toContain("/issues/42/labels/priority%3Alow");
  });

  // -- updateIssueState ------------------------------------------------------
  it("updateIssueState closes an issue", async () => {
    const { fetch: f, calls } = makeFakeFetch([{ status: 200, body: { id: 42, state: "closed" } }]);
    const client = createGithubClient({ token: TOKEN, fetch: f, writeScopes: SCOPES_ALL });
    const result = await client.updateIssueState(REPO, makeIssueNumber(42), "closed");
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("PATCH");
    const body = JSON.parse(calls[0]?.body ?? "{}") as { state: string };
    expect(body.state).toBe("closed");
  });

  it("updateIssueState denied without issue write scope", async () => {
    const { fetch: f } = makeFakeFetch([]);
    const client = createGithubClient({
      token: TOKEN,
      fetch: f,
      writeScopes: { ...SCOPES_ALL, issues: [] },
    });
    const result = await client.updateIssueState(REPO, makeIssueNumber(1), "closed");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(GithubWriteScopeError);
  });
});
