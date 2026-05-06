import { mkdir, mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  makeAgentId,
  makeGroupId,
  makeWakeId,
  type SignalAggregationContext,
} from "@murmurations-ai/core";
import {
  makeIssueNumber,
  makeRepoCoordinate,
  type GithubClient,
  type GithubClientError,
  type GithubIssue,
  type Result,
} from "@murmurations-ai/github";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DefaultSignalAggregator } from "./index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO = makeRepoCoordinate("xeeban", "emergent-praxis");

const fakeIssue = (
  overrides: Partial<Omit<GithubIssue, "number" | "repo">> & { readonly n?: number } = {},
): GithubIssue => ({
  number: makeIssueNumber(overrides.n ?? 1),
  repo: REPO,
  title: overrides.title ?? "Test issue",
  body: overrides.body ?? "body content",
  state: overrides.state ?? "open",
  labels: overrides.labels ?? ["test"],
  authorLogin: overrides.authorLogin ?? "xeeban",
  createdAt: overrides.createdAt ?? new Date("2026-04-09T10:00:00Z"),
  updatedAt: overrides.updatedAt ?? new Date("2026-04-09T11:00:00Z"),
  closedAt: overrides.closedAt ?? null,
  commentCount: overrides.commentCount ?? 0,
  htmlUrl:
    overrides.htmlUrl ??
    `https://github.com/xeeban/emergent-praxis/issues/${String(overrides.n ?? 1)}`,
});

/* eslint-disable @typescript-eslint/require-await -- fake clients mimic the async interface */
// ADR-0017 added three mutation methods to GithubClient. Signals tests
// only exercise the read path, so the fakes return a `write-scope-denied`
// Result for each mutation — the aggregator never calls these, so the
// behavior is only satisfying the type.
const mutationDenied = async (): Promise<{
  readonly ok: false;
  readonly error: GithubClientError;
}> => ({
  ok: false,
  error: { code: "write-scope-denied" } as unknown as GithubClientError,
});

const notFound = async (): Promise<{
  readonly ok: false;
  readonly error: GithubClientError;
}> => ({
  ok: false,
  error: { code: "not-found" } as unknown as GithubClientError,
});

const makeFakeGithub = (issues: readonly GithubIssue[]): GithubClient => ({
  async getIssue() {
    return {
      ok: false,
      error: { code: "not-found" } as unknown as GithubClientError,
    };
  },
  async listIssues() {
    return { ok: true, value: issues };
  },
  async listIssueComments() {
    return { ok: true, value: [] };
  },
  async listIssueLabels() {
    return { ok: true, value: [] };
  },
  getRef: notFound,
  getPullRequest: notFound,
  listPullRequests: notFound,
  getPullRequestFiles: notFound,
  getCommit: notFound,
  getFileAtRef: notFound,
  async searchIssues() {
    return { ok: true, value: [] };
  },
  createIssueComment: mutationDenied,
  createIssue: mutationDenied,
  createCommitOnBranch: mutationDenied,
  addLabels: mutationDenied,
  removeLabel: mutationDenied,
  updateIssueState: mutationDenied,
  lastRateLimit: () => null,
});

const makeFailingGithub = (): GithubClient => ({
  async getIssue() {
    return { ok: false, error: { code: "not-found" } as unknown as GithubClientError };
  },
  async listIssues(): Promise<Result<readonly GithubIssue[], GithubClientError>> {
    return {
      ok: false,
      error: { code: "rate-limited" } as unknown as GithubClientError,
    };
  },
  async listIssueComments() {
    return { ok: true, value: [] };
  },
  async listIssueLabels() {
    return { ok: true, value: [] };
  },
  getRef: notFound,
  getPullRequest: notFound,
  listPullRequests: notFound,
  getPullRequestFiles: notFound,
  getCommit: notFound,
  getFileAtRef: notFound,
  async searchIssues() {
    return { ok: true, value: [] };
  },
  createIssueComment: mutationDenied,
  createIssue: mutationDenied,
  createCommitOnBranch: mutationDenied,
  addLabels: mutationDenied,
  removeLabel: mutationDenied,
  updateIssueState: mutationDenied,
  lastRateLimit: () => null,
});
/* eslint-enable @typescript-eslint/require-await */

const mkContext = (
  agentDir: string,
  overrides: Partial<SignalAggregationContext> = {},
): SignalAggregationContext => ({
  wakeId: makeWakeId("wake-test"),
  agentId: makeAgentId("07-wren"),
  agentDir,
  frontmatter: {
    agentId: makeAgentId("07-wren"),
    name: "Wren",
    modelTier: "balanced",
    groupMemberships: [makeGroupId("engineering")],
  },
  groupMemberships: [makeGroupId("engineering")],
  wakeReason: { kind: "manual", invokedBy: "test" },
  now: new Date("2026-04-09T14:00:00Z"),
  ...overrides,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DefaultSignalAggregator", () => {
  let rootDir = "";

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "murmuration-signals-"));
  });

  afterEach(async () => {
    if (rootDir) await rm(rootDir, { recursive: true, force: true });
  });

  it("capabilities reports active sources with github when scopes are provided", () => {
    const agg = new DefaultSignalAggregator({
      rootDir,
      github: makeFakeGithub([]),
      githubScopes: [{ repo: REPO }],
    });
    const caps = agg.capabilities();
    expect(caps.id).toBe("default");
    expect(caps.activeSources).toContain("github-issue");
    expect(caps.activeSources).toContain("private-note");
    expect(caps.activeSources).toContain("inbox-message");
  });

  it("capabilities omits github when no scopes are configured", () => {
    const agg = new DefaultSignalAggregator({ rootDir });
    expect(agg.capabilities().activeSources).not.toContain("github-issue");
  });

  it("empty fixture (no sources configured, no notes) returns empty bundle", async () => {
    const agg = new DefaultSignalAggregator({ rootDir });
    const result = await agg.aggregate(mkContext("07-wren"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bundle.signals).toEqual([]);
      expect(result.bundle.warnings).toEqual([]);
    }
  });

  it("github source: trusted scope produces trusted signals", async () => {
    const agg = new DefaultSignalAggregator({
      rootDir,
      github: makeFakeGithub([fakeIssue({ n: 241, title: "Engineering Circle ratified" })]),
      githubScopes: [{ repo: REPO, trusted: true }],
    });
    const result = await agg.aggregate(mkContext("07-wren"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bundle.signals).toHaveLength(1);
      const s = result.bundle.signals[0];
      expect(s?.kind).toBe("github-issue");
      expect(s?.trust).toBe("trusted");
      if (s?.kind === "github-issue") {
        expect(s.number).toBe(241);
        expect(s.title).toBe("Engineering Circle ratified");
        expect(s.labels).toEqual(["test"]);
      }
    }
  });

  it("github source: non-trusted scope produces semi-trusted signals", async () => {
    const agg = new DefaultSignalAggregator({
      rootDir,
      github: makeFakeGithub([fakeIssue({ n: 1 })]),
      githubScopes: [{ repo: REPO }],
    });
    const result = await agg.aggregate(mkContext("07-wren"));
    if (result.ok) {
      expect(result.bundle.signals[0]?.trust).toBe("semi-trusted");
    }
  });

  it("github source failure becomes a warning, not a fatal error", async () => {
    const agg = new DefaultSignalAggregator({
      rootDir,
      github: makeFailingGithub(),
      githubScopes: [{ repo: REPO }],
    });
    const result = await agg.aggregate(mkContext("07-wren"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bundle.signals).toEqual([]);
      expect(result.bundle.warnings.length).toBeGreaterThan(0);
      expect(result.bundle.warnings[0]).toContain("github source");
    }
  });

  it("github source truncates and emits cap warning", async () => {
    const many = Array.from({ length: 20 }, (_, i) => fakeIssue({ n: i + 1 }));
    const agg = new DefaultSignalAggregator({
      rootDir,
      github: makeFakeGithub(many),
      githubScopes: [{ repo: REPO }],
      caps: { githubIssue: 5 },
    });
    const result = await agg.aggregate(mkContext("07-wren"));
    if (result.ok) {
      const githubSignals = result.bundle.signals.filter((s) => s.kind === "github-issue");
      expect(githubSignals).toHaveLength(5);
      expect(result.bundle.warnings.some((w) => w.includes("truncated to 5"))).toBe(true);
    }
  });

  it("private-note source reads markdown files, freshest first", async () => {
    const notesDir = join(rootDir, "agents", "07-wren", "notes");
    await mkdir(notesDir, { recursive: true });
    await writeFile(join(notesDir, "older.md"), "# Older\n\nFirst paragraph of older note.\n");
    await writeFile(join(notesDir, "newer.md"), "# Newer\n\nFirst paragraph of newer note.\n");
    // Force older mtime on "older.md".
    const oldTime = new Date("2026-04-01T00:00:00Z");
    await utimes(join(notesDir, "older.md"), oldTime, oldTime);

    const agg = new DefaultSignalAggregator({ rootDir });
    const result = await agg.aggregate(mkContext("07-wren"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const notes = result.bundle.signals.filter((s) => s.kind === "private-note");
      expect(notes).toHaveLength(2);
      // Freshest first → "newer.md" ahead of "older.md".
      expect(notes[0]?.id).toBe("private-note:newer.md");
      expect(notes[1]?.id).toBe("private-note:older.md");
      if (notes[0]?.kind === "private-note") {
        expect(notes[0].trust).toBe("trusted");
        expect(notes[0].summary).toContain("Newer");
      }
    }
  });

  it("inbox-message source is FIFO (oldest first)", async () => {
    const inboxDir = join(rootDir, "agents", "07-wren", "inbox");
    await mkdir(inboxDir, { recursive: true });
    await writeFile(join(inboxDir, "08-editorial__2026-04-01__first.md"), "first message content");
    await writeFile(
      join(inboxDir, "09-fact-checking__2026-04-05__second.md"),
      "second message content",
    );
    const oldTime = new Date("2026-04-01T00:00:00Z");
    await utimes(join(inboxDir, "08-editorial__2026-04-01__first.md"), oldTime, oldTime);

    const agg = new DefaultSignalAggregator({ rootDir });
    const result = await agg.aggregate(mkContext("07-wren"));
    if (result.ok) {
      const inbox = result.bundle.signals.filter((s) => s.kind === "inbox-message");
      expect(inbox).toHaveLength(2);
      expect(inbox[0]?.id).toContain("08-editorial");
      expect(inbox[1]?.id).toContain("09-fact-checking");
    }
  });

  it("inbox-message trust upgrade via trustedSenderAgentIds", async () => {
    const inboxDir = join(rootDir, "agents", "07-wren", "inbox");
    await mkdir(inboxDir, { recursive: true });
    await writeFile(join(inboxDir, "08-editorial__2026-04-01__hi.md"), "content");

    const agg = new DefaultSignalAggregator({
      rootDir,
      trustedSenderAgentIds: ["08-editorial"],
    });
    const result = await agg.aggregate(mkContext("07-wren"));
    if (result.ok) {
      const inbox = result.bundle.signals.filter((s) => s.kind === "inbox-message");
      expect(inbox[0]?.trust).toBe("trusted");
    }
  });

  it("multi-source order: github → private-note → inbox-message", async () => {
    const notesDir = join(rootDir, "agents", "07-wren", "notes");
    const inboxDir = join(rootDir, "agents", "07-wren", "inbox");
    await mkdir(notesDir, { recursive: true });
    await mkdir(inboxDir, { recursive: true });
    await writeFile(join(notesDir, "a.md"), "note a");
    await writeFile(join(inboxDir, "08__t__msg.md"), "inbox a");

    const agg = new DefaultSignalAggregator({
      rootDir,
      github: makeFakeGithub([fakeIssue({ n: 1 })]),
      githubScopes: [{ repo: REPO }],
    });
    const result = await agg.aggregate(mkContext("07-wren"));
    if (result.ok) {
      const kinds = result.bundle.signals.map((s) => s.kind);
      expect(kinds).toEqual(["github-issue", "private-note", "inbox-message"]);
    }
  });

  it("issue body content reaches the agent intact for normal-sized payloads", async () => {
    // Live regression 2026-04-30: a 2800-char source-directive body was
    // truncated to 500 chars, dropping per-agent task definitions. Modern
    // context windows make summary-style truncation harmful by default —
    // pass full content through and reserve slicing for runaway-payload
    // protection only.
    const longBody = `**Header**\n\n${"x".repeat(2500)}\n\n**Per-agent asks below.**`;
    const agg = new DefaultSignalAggregator({
      rootDir,
      github: makeFakeGithub([fakeIssue({ body: longBody, labels: ["source-directive"] })]),
      githubScopes: [{ repo: REPO }],
    });
    const result = await agg.aggregate(mkContext("07-wren"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const signal = result.bundle.signals[0];
      expect(signal?.kind).toBe("github-issue");
      if (signal?.kind === "github-issue") {
        expect(signal.excerpt.length).toBeGreaterThan(2500);
        expect(signal.excerpt).toContain("Per-agent asks below.");
        expect(signal.excerpt).not.toContain("[...]");
      }
    }
  });

  it("only at extreme size does runaway-payload protection slice the excerpt", async () => {
    // The cap exists as a defense-in-depth runaway guard. It should not
    // fire for any reasonable directive or issue body. When it does fire,
    // operators see [...] as the explicit "this was truncated" marker.
    const runaway = "z".repeat(70_000); // > 64K cap
    const agg = new DefaultSignalAggregator({
      rootDir,
      github: makeFakeGithub([fakeIssue({ body: runaway, labels: ["bug"] })]),
      githubScopes: [{ repo: REPO }],
    });
    const result = await agg.aggregate(mkContext("07-wren"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const signal = result.bundle.signals[0];
      if (signal?.kind === "github-issue") {
        expect(signal.excerpt.length).toBeLessThan(70_000);
        expect(signal.excerpt).toContain("[...]");
      }
    }
  });

  it("control characters are stripped from excerpts", async () => {
    const agg = new DefaultSignalAggregator({
      rootDir,
      github: makeFakeGithub([fakeIssue({ body: "clean\x00\x01\x02text\nhere" })]),
      githubScopes: [{ repo: REPO }],
    });
    const result = await agg.aggregate(mkContext("07-wren"));
    if (result.ok) {
      const signal = result.bundle.signals[0];
      if (signal?.kind === "github-issue") {
        expect(signal.excerpt).not.toContain("\x00");
        expect(signal.excerpt).not.toContain("\x01");
        expect(signal.excerpt).toContain("clean");
      }
    }
  });

  it("partitions action items assigned to the waking agent into actionItems", async () => {
    const issues = [
      fakeIssue({
        n: 259,
        title: "Action: do something",
        labels: ["action-item", "assigned:07-wren"],
      }),
      fakeIssue({
        n: 260,
        title: "Action: other thing",
        labels: ["action-item", "assigned:02-content"],
      }),
      fakeIssue({ n: 100, title: "Regular issue", labels: ["bug"] }),
    ];
    const agg = new DefaultSignalAggregator({
      rootDir,
      github: makeFakeGithub(issues),
      githubScopes: [{ repo: REPO }],
    });
    const result = await agg.aggregate(mkContext("07-wren"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bundle.signals).toHaveLength(3);
      // Only #259 is assigned to 07-wren
      expect(result.bundle.actionItems).toHaveLength(1);
      const item = result.bundle.actionItems[0];
      expect(item?.kind).toBe("github-issue");
      if (item?.kind === "github-issue") {
        expect((item as unknown as { number: number }).number).toBe(259);
      }
    }
  });

  it("returns empty actionItems when no action items are assigned", async () => {
    const issues = [fakeIssue({ n: 1, title: "Bug", labels: ["bug"] })];
    const agg = new DefaultSignalAggregator({
      rootDir,
      github: makeFakeGithub(issues),
      githubScopes: [{ repo: REPO }],
    });
    const result = await agg.aggregate(mkContext("07-wren"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bundle.actionItems).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Collaboration provider integration (ADR-0021)
// ---------------------------------------------------------------------------

describe("DefaultSignalAggregator + collaborationProvider", () => {
  it("includes signals from collaboration provider", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "sig-collab-"));
    try {
      await mkdir(join(rootDir, "notes", "private"), { recursive: true });
      await mkdir(join(rootDir, "notes", "inbox"), { recursive: true });

      const mockProvider = {
        collectSignals: () =>
          Promise.resolve([
            {
              kind: "custom" as const,
              id: "local-item-abc",
              trust: "trusted" as const,
              fetchedAt: new Date(),
              sourceId: "local-item",
              data: {
                id: "abc",
                title: "Test directive",
                body: "Do something",
                labels: ["source-directive"],
              },
            },
          ]),
      };

      const agg = new DefaultSignalAggregator({
        rootDir,
        collaborationProvider: mockProvider,
      });

      const result = await agg.aggregate(mkContext("the-researcher"));
      expect(result.ok).toBe(true);
      if (result.ok) {
        const localItems = result.bundle.signals.filter(
          (s) => s.kind === "custom" && (s as { sourceId?: string }).sourceId === "local-item",
        );
        expect(localItems.length).toBeGreaterThanOrEqual(1);
      }
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("works without collaboration provider (returns only filesystem signals)", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "sig-no-collab-"));
    try {
      await mkdir(join(rootDir, "notes", "private"), { recursive: true });
      await mkdir(join(rootDir, "notes", "inbox"), { recursive: true });

      const agg = new DefaultSignalAggregator({ rootDir });
      const result = await agg.aggregate(mkContext("the-researcher"));
      expect(result.ok).toBe(true);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("handles collaboration provider errors gracefully", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "sig-collab-err-"));
    try {
      await mkdir(join(rootDir, "notes", "private"), { recursive: true });
      await mkdir(join(rootDir, "notes", "inbox"), { recursive: true });

      const failingProvider = {
        collectSignals: () => Promise.reject(new Error("provider crashed")),
      };

      const agg = new DefaultSignalAggregator({
        rootDir,
        collaborationProvider: failingProvider,
      });

      const result = await agg.aggregate(mkContext("the-researcher"));
      expect(result.ok).toBe(true);
      if (result.ok) {
        // The #collectCollaborationItems method catches errors internally
        // and returns [], so it resolves (not rejects). No warning — graceful.
        const localItems = result.bundle.signals.filter(
          (s) => s.kind === "custom" && (s as { sourceId?: string }).sourceId === "local-item",
        );
        expect(localItems).toHaveLength(0); // error was swallowed, no items
      }
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// v0.7.0 — priority-tiered bundle composition (ADR-0042 / Workstream G)
// ---------------------------------------------------------------------------

describe("DefaultSignalAggregator + priorityBundle", () => {
  let rootDir = "";

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "sig-priority-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("preserves legacy behavior when priorityBundle is unset (default false)", async () => {
    const issues = Array.from({ length: 8 }, (_, i) =>
      fakeIssue({ n: i + 1, labels: ["priority:critical"] }),
    );
    const agg = new DefaultSignalAggregator({
      rootDir,
      github: makeFakeGithub(issues),
      githubScopes: [{ repo: REPO }],
    });
    const result = await agg.aggregate(mkContext("07-wren"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const githubSignals = result.bundle.signals.filter((s) => s.kind === "github-issue");
      // Legacy path = github cap (default 15) caps it; all 8 fit.
      expect(githubSignals).toHaveLength(8);
    }
  });

  it("composes a tiered bundle when priorityBundle is true", async () => {
    const issues = [
      fakeIssue({ n: 1, labels: ["priority:critical"] }),
      fakeIssue({ n: 2, labels: ["priority:critical"] }),
      ...Array.from({ length: 10 }, (_, i) => fakeIssue({ n: 100 + i, labels: ["priority:low"] })),
    ];
    const agg = new DefaultSignalAggregator({
      rootDir,
      github: makeFakeGithub(issues),
      githubScopes: [{ repo: REPO }],
      priorityBundle: true,
    });
    const result = await agg.aggregate(mkContext("07-wren"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 2 critical + low fills budget. The order in the emitted
      // bundle should put a critical-tier item first (regardless of
      // which one — the github-source pre-sort by updatedAt may
      // permute order within a tier when timestamps tie).
      const first = result.bundle.signals[0];
      expect(first?.kind).toBe("github-issue");
      if (first?.kind === "github-issue") {
        expect([1, 2]).toContain(first.number);
      }
    }
  });

  it("excludes done items via getDoneSignalIds hook", async () => {
    const issues = [
      fakeIssue({ n: 1, labels: ["priority:critical"] }),
      fakeIssue({ n: 2, labels: ["priority:critical"] }),
      fakeIssue({ n: 3, labels: ["priority:critical"] }),
    ];
    let capturedIds: ReadonlySet<string> | undefined;
    const agg = new DefaultSignalAggregator({
      rootDir,
      github: makeFakeGithub(issues),
      githubScopes: [{ repo: REPO }],
      priorityBundle: true,
      // eslint-disable-next-line @typescript-eslint/require-await -- async to match interface
      getDoneSignalIds: async () => {
        // Pretend issue #2's signal is verified done. Signal IDs use
        // the format `github-issue:owner/repo#N` (see issueToSignal).
        const ids = new Set<string>(["github-issue:xeeban/emergent-praxis#2"]);
        capturedIds = ids;
        return ids;
      },
    });
    const result = await agg.aggregate(mkContext("07-wren"));
    expect(result.ok).toBe(true);
    expect(capturedIds).toBeDefined();
    if (result.ok) {
      const numbers = result.bundle.signals.flatMap((s) =>
        s.kind === "github-issue" ? [s.number] : [],
      );
      // #2 should be excluded; #1 and #3 remain.
      expect(numbers).not.toContain(2);
      expect(numbers).toContain(1);
      expect(numbers).toContain(3);
    }
  });

  it("facilitator-agent sees awaiting:source-close as critical", async () => {
    const issues = [
      fakeIssue({ n: 50, labels: ["awaiting:source-close"] }),
      fakeIssue({ n: 51, labels: ["test"] }),
    ];
    const agg = new DefaultSignalAggregator({
      rootDir,
      github: makeFakeGithub(issues),
      githubScopes: [{ repo: REPO }],
      priorityBundle: true,
    });
    const result = await agg.aggregate(
      mkContext("facilitator-agent", { agentId: makeAgentId("facilitator-agent") }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // awaiting:source-close is critical for facilitator → emitted first.
      const first = result.bundle.signals[0];
      if (first?.kind === "github-issue") {
        expect(first.number).toBe(50);
      }
    }
  });

  /* eslint-disable @typescript-eslint/require-await -- fake clients mimic the async interface */
  it("multi-query anyLabel: source-directive scoped to agent reaches the bundle (harness#331/#233)", async () => {
    // Repro for chinook-wind 2026-05-05: a directive filed as
    // `source-directive` + `scope:agent:rentals-agent` was invisible to
    // the aggregator because the configured filter was AND-only with
    // `assigned:rentals-agent`. With anyLabel routing, the issue should
    // now show up in the bundle.
    const directiveForRentals = fakeIssue({
      n: 100,
      title: "[DIRECTIVE] bootstrap",
      labels: ["source-directive", "scope:agent:rentals-agent"],
    });
    // Track which label-set each query was asked for, so we can assert
    // the multi-query fan-out happened.
    const queriedFilters: (readonly string[] | undefined)[] = [];
    const fakeClient: GithubClient = {
      async getIssue() {
        return {
          ok: false,
          error: { code: "not-found" } as unknown as GithubClientError,
        };
      },
      async listIssues(_repo, filter): Promise<Result<readonly GithubIssue[], GithubClientError>> {
        queriedFilters.push(filter?.labels);
        // Mimic GitHub's AND-semantics: return the directive only when
        // the query asks for `scope:agent:rentals-agent`.
        const wantsScopeAgent = filter?.labels?.includes("scope:agent:rentals-agent") ?? false;
        return { ok: true, value: wantsScopeAgent ? [directiveForRentals] : [] };
      },
      async listIssueComments() {
        return { ok: true, value: [] };
      },
      async listIssueLabels() {
        return { ok: true, value: [] };
      },
      getRef: notFound,
      getPullRequest: notFound,
      listPullRequests: notFound,
      getPullRequestFiles: notFound,
      getCommit: notFound,
      getFileAtRef: notFound,
      async searchIssues() {
        return { ok: true, value: [] };
      },
      createIssueComment: mutationDenied,
      createIssue: mutationDenied,
      createCommitOnBranch: mutationDenied,
      addLabels: mutationDenied,
      removeLabel: mutationDenied,
      updateIssueState: mutationDenied,
      lastRateLimit: () => null,
    };

    const agg = new DefaultSignalAggregator({
      rootDir,
      github: fakeClient,
      githubScopes: [
        {
          repo: REPO,
          anyLabel: [
            "assigned:rentals-agent",
            "scope:agent:rentals-agent",
            "scope:group:partnership",
            "scope:all",
          ],
        },
      ],
    });

    const result = await agg.aggregate(mkContext("rentals-agent"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The directive should be in the bundle.
    const directives = result.bundle.signals.filter(
      (s) => s.kind === "github-issue" && s.number === 100,
    );
    expect(directives).toHaveLength(1);

    // And we should have run one query per anyLabel value (4 queries).
    expect(queriedFilters).toHaveLength(4);
  });

  it("multi-query anyLabel: dedupes issues that match multiple labels (harness#331)", async () => {
    // An issue tagged with both `assigned:foo` AND `scope:all` matches
    // two queries; the aggregator should emit it once.
    const issue = fakeIssue({
      n: 200,
      labels: ["assigned:rentals-agent", "scope:all"],
    });
    const fakeClient: GithubClient = {
      async getIssue() {
        return {
          ok: false,
          error: { code: "not-found" } as unknown as GithubClientError,
        };
      },
      async listIssues(): Promise<Result<readonly GithubIssue[], GithubClientError>> {
        // Same issue returned by every query — dedup is the aggregator's job.
        return { ok: true, value: [issue] };
      },
      async listIssueComments() {
        return { ok: true, value: [] };
      },
      async listIssueLabels() {
        return { ok: true, value: [] };
      },
      getRef: notFound,
      getPullRequest: notFound,
      listPullRequests: notFound,
      getPullRequestFiles: notFound,
      getCommit: notFound,
      getFileAtRef: notFound,
      async searchIssues() {
        return { ok: true, value: [] };
      },
      createIssueComment: mutationDenied,
      createIssue: mutationDenied,
      createCommitOnBranch: mutationDenied,
      addLabels: mutationDenied,
      removeLabel: mutationDenied,
      updateIssueState: mutationDenied,
      lastRateLimit: () => null,
    };

    const agg = new DefaultSignalAggregator({
      rootDir,
      github: fakeClient,
      githubScopes: [{ repo: REPO, anyLabel: ["assigned:rentals-agent", "scope:all"] }],
    });

    const result = await agg.aggregate(mkContext("rentals-agent"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const matching = result.bundle.signals.filter(
      (s) => s.kind === "github-issue" && s.number === 200,
    );
    expect(matching).toHaveLength(1);
  });
  /* eslint-enable @typescript-eslint/require-await */

  /* eslint-disable @typescript-eslint/require-await -- fake clients mimic the async interface */
  it("multi-query anyLabel: cap keeps newest issues even when they came from a later fan-out query (QA #1)", async () => {
    // QA review of harness#331: the original fan-out collected in
    // collection order — `assigned:` query first, then `scope:agent:`,
    // etc. With a small cap and many older `assigned:` items, a freshly
    // filed `scope:agent:<self>` directive could be silently dropped.
    // After the fix, sort by updatedAt DESC means the newest-N survive.
    const recentDirective = fakeIssue({
      n: 999,
      title: "[DIRECTIVE] urgent",
      labels: ["source-directive", "scope:agent:rentals-agent"],
      // Most recent — must survive the cap.
      updatedAt: new Date("2026-05-05T12:00:00Z"),
    });
    const olderActionItems = Array.from({ length: 5 }, (_, i) =>
      fakeIssue({
        n: 100 + i,
        title: `Old action ${String(i)}`,
        labels: ["assigned:rentals-agent", "action-item"],
        // All older than the directive.
        updatedAt: new Date(`2026-05-0${String(i + 1)}T08:00:00Z`),
      }),
    );
    const fakeClient: GithubClient = {
      async getIssue() {
        return { ok: false, error: { code: "not-found" } as unknown as GithubClientError };
      },
      async listIssues(_repo, filter): Promise<Result<readonly GithubIssue[], GithubClientError>> {
        const wantsAssigned = filter?.labels?.includes("assigned:rentals-agent") ?? false;
        const wantsScopeAgent = filter?.labels?.includes("scope:agent:rentals-agent") ?? false;
        if (wantsAssigned) return { ok: true, value: olderActionItems };
        if (wantsScopeAgent) return { ok: true, value: [recentDirective] };
        return { ok: true, value: [] };
      },
      async listIssueComments() {
        return { ok: true, value: [] };
      },
      async listIssueLabels() {
        return { ok: true, value: [] };
      },
      getRef: notFound,
      getPullRequest: notFound,
      listPullRequests: notFound,
      getPullRequestFiles: notFound,
      getCommit: notFound,
      getFileAtRef: notFound,
      async searchIssues() {
        return { ok: true, value: [] };
      },
      createIssueComment: mutationDenied,
      createIssue: mutationDenied,
      createCommitOnBranch: mutationDenied,
      addLabels: mutationDenied,
      removeLabel: mutationDenied,
      updateIssueState: mutationDenied,
      lastRateLimit: () => null,
    };
    const agg = new DefaultSignalAggregator({
      rootDir,
      github: fakeClient,
      githubScopes: [
        {
          repo: REPO,
          anyLabel: ["assigned:rentals-agent", "scope:agent:rentals-agent", "scope:all"],
        },
      ],
      // Cap of 3 — would have dropped the directive under collection-order
      // truncation (older `assigned:` items came first).
      caps: { githubIssue: 3, total: 50 },
    });
    const result = await agg.aggregate(mkContext("rentals-agent"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const directive = result.bundle.signals.find(
      (s) => s.kind === "github-issue" && s.number === 999,
    );
    expect(directive, "newest directive must survive the per-source cap").toBeDefined();
    // Cap respected.
    const ghIssues = result.bundle.signals.filter((s) => s.kind === "github-issue");
    expect(ghIssues).toHaveLength(3);
  });

  it("multi-query anyLabel: surfaces structured partialFailures when a sub-query fails (QA #3)", async () => {
    // QA review of harness#331: a single failed sub-query used to push
    // a string into `warnings` and silently lose data. Now also pushes
    // a structured entry to `partialFailures` so callers can distinguish
    // "no signals matched" from "1 of 4 fan-out queries failed".
    const fakeClient: GithubClient = {
      async getIssue() {
        return { ok: false, error: { code: "not-found" } as unknown as GithubClientError };
      },
      async listIssues(_repo, filter): Promise<Result<readonly GithubIssue[], GithubClientError>> {
        const failOn = "scope:agent:rentals-agent";
        if (filter?.labels?.includes(failOn) ?? false) {
          return {
            ok: false,
            error: {
              code: "rate-limited",
              message: "secondary rate limit",
            } as unknown as GithubClientError,
          };
        }
        return { ok: true, value: [] };
      },
      async listIssueComments() {
        return { ok: true, value: [] };
      },
      async listIssueLabels() {
        return { ok: true, value: [] };
      },
      getRef: notFound,
      getPullRequest: notFound,
      listPullRequests: notFound,
      getPullRequestFiles: notFound,
      getCommit: notFound,
      getFileAtRef: notFound,
      async searchIssues() {
        return { ok: true, value: [] };
      },
      createIssueComment: mutationDenied,
      createIssue: mutationDenied,
      createCommitOnBranch: mutationDenied,
      addLabels: mutationDenied,
      removeLabel: mutationDenied,
      updateIssueState: mutationDenied,
      lastRateLimit: () => null,
    };
    const agg = new DefaultSignalAggregator({
      rootDir,
      github: fakeClient,
      githubScopes: [
        {
          repo: REPO,
          anyLabel: ["assigned:rentals-agent", "scope:agent:rentals-agent", "scope:all"],
        },
      ],
    });
    const result = await agg.aggregate(mkContext("rentals-agent"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const failures = result.bundle.partialFailures ?? [];
    expect(failures).toHaveLength(1);
    expect(failures[0]?.source).toBe("github");
    expect(failures[0]?.anyLabel).toBe("scope:agent:rentals-agent");
    expect(failures[0]?.code).toBe("rate-limited");
    // The string warning is still there too — same info, both surfaces.
    expect(result.bundle.warnings.some((w) => w.includes("rate-limited"))).toBe(true);
  });
  /* eslint-enable @typescript-eslint/require-await */

  it("emits warnings naming tier counts when items are dropped", async () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      fakeIssue({ n: i + 1, labels: ["priority:critical"] }),
    );
    const agg = new DefaultSignalAggregator({
      rootDir,
      github: makeFakeGithub(many),
      githubScopes: [{ repo: REPO }],
      caps: { githubIssue: 20, total: 15 },
      priorityBundle: true,
    });
    const result = await agg.aggregate(mkContext("07-wren"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      // critical cap is 5; rest dropped.
      const counted = result.bundle.signals.filter((s) => s.kind === "github-issue");
      expect(counted).toHaveLength(5);
      expect(result.bundle.warnings.some((w) => w.includes("priority bundle"))).toBe(true);
    }
  });
});

describe("DefaultSignalAggregator — scope:all provenance check (Sec M1, harness#339)", () => {
  let rootDir = "";
  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "signals-m1-"));
  });
  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("back-compat: scope:all without scopeAllTrustedAuthors keeps baseTrust", async () => {
    const issues = [fakeIssue({ n: 1, labels: ["scope:all"], authorLogin: "unknown-bot" })];
    const agg = new DefaultSignalAggregator({
      rootDir,
      github: makeFakeGithub(issues),
      githubScopes: [{ repo: REPO, anyLabel: ["scope:all"] }],
    });
    const result = await agg.aggregate(mkContext("01-alpha"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const sig = result.bundle.signals.find((s) => s.kind === "github-issue");
      expect(sig?.trust).toBe("semi-trusted");
    }
  });

  it("scope:all from trusted author keeps baseTrust (Sec M1)", async () => {
    const issues = [fakeIssue({ n: 1, labels: ["scope:all"], authorLogin: "nori" })];
    const agg = new DefaultSignalAggregator({
      rootDir,
      github: makeFakeGithub(issues),
      githubScopes: [{ repo: REPO, anyLabel: ["scope:all"], scopeAllTrustedAuthors: ["nori"] }],
    });
    const result = await agg.aggregate(mkContext("01-alpha"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const sig = result.bundle.signals.find((s) => s.kind === "github-issue");
      expect(sig?.trust).toBe("semi-trusted");
    }
  });

  it("scope:all from untrusted author is downgraded to untrusted (Sec M1)", async () => {
    const issues = [fakeIssue({ n: 1, labels: ["scope:all"], authorLogin: "external-bot" })];
    const agg = new DefaultSignalAggregator({
      rootDir,
      github: makeFakeGithub(issues),
      githubScopes: [{ repo: REPO, anyLabel: ["scope:all"], scopeAllTrustedAuthors: ["nori"] }],
    });
    const result = await agg.aggregate(mkContext("01-alpha"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const sig = result.bundle.signals.find((s) => s.kind === "github-issue");
      expect(sig?.trust).toBe("untrusted");
    }
  });

  it("scope:all from untrusted author is dropped when dropScopeAllFromUntrusted=true (Sec M1)", async () => {
    const issues = [
      fakeIssue({ n: 1, labels: ["scope:all"], authorLogin: "external-bot" }),
      fakeIssue({ n: 2, labels: ["assigned:alpha"], authorLogin: "nori" }),
    ];
    const agg = new DefaultSignalAggregator({
      rootDir,
      github: makeFakeGithub(issues),
      githubScopes: [
        {
          repo: REPO,
          anyLabel: ["scope:all", "assigned:alpha"],
          scopeAllTrustedAuthors: ["nori"],
          dropScopeAllFromUntrusted: true,
        },
      ],
    });
    const result = await agg.aggregate(mkContext("01-alpha"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const ghSignals = result.bundle.signals.filter((s) => s.kind === "github-issue");
      // issue #1 (scope:all, untrusted) dropped; issue #2 (assigned, trusted author) kept
      expect(ghSignals).toHaveLength(1);
      expect(ghSignals[0]?.trust).toBe("semi-trusted");
    }
  });

  it("non-scope:all issue is not affected by scopeAllTrustedAuthors (Sec M1)", async () => {
    const issues = [fakeIssue({ n: 1, labels: ["assigned:alpha"], authorLogin: "unknown-bot" })];
    const agg = new DefaultSignalAggregator({
      rootDir,
      github: makeFakeGithub(issues),
      githubScopes: [
        { repo: REPO, anyLabel: ["assigned:alpha"], scopeAllTrustedAuthors: ["nori"] },
      ],
    });
    const result = await agg.aggregate(mkContext("01-alpha"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const sig = result.bundle.signals.find((s) => s.kind === "github-issue");
      expect(sig?.trust).toBe("semi-trusted");
    }
  });
});
