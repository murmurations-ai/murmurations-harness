import { mkdir, mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  makeAgentId,
  makeGroupId,
  makeWakeId,
  type SignalAggregationContext,
} from "@murmuration/core";
import {
  makeIssueNumber,
  makeRepoCoordinate,
  type GithubClient,
  type GithubClientError,
  type GithubIssue,
  type Result,
} from "@murmuration/github";
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
