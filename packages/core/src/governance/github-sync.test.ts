/* eslint-disable @typescript-eslint/no-deprecated -- testing legacy interface backwards compat */
import { describe, it, expect, vi } from "vitest";
import { GovernanceGitHubSync, type GovernanceSyncGitHub } from "./github-sync.js";
import type { GovernanceItem, GovernanceStateTransition } from "./index.js";
import { makeAgentId } from "../execution/index.js";

const makeItem = (overrides: Partial<GovernanceItem> = {}): GovernanceItem => ({
  id: "test-item-001",
  kind: "tension",
  currentState: "open",
  payload: { topic: "Agent needs web search tools" },
  createdBy: makeAgentId("01-research"),
  createdAt: new Date("2026-04-13"),
  reviewAt: null,
  history: [],
  ...overrides,
});

const makeTransition = (
  overrides: Partial<GovernanceStateTransition> = {},
): GovernanceStateTransition => ({
  from: "open",
  to: "resolved",
  triggeredBy: "governance-meeting",
  at: new Date("2026-04-13T12:00:00Z"),
  ...overrides,
});

const makeMockGitHub = (): GovernanceSyncGitHub & {
  calls: { method: string; args: unknown[] }[];
} => {
  const calls: { method: string; args: unknown[] }[] = [];
  return {
    calls,
    createIssue: vi.fn((input) => {
      calls.push({ method: "createIssue", args: [input] });
      return Promise.resolve({
        ok: true as const,
        issueNumber: 42,
        htmlUrl: "https://github.com/test/repo/issues/42",
      });
    }),
    createIssueComment: vi.fn((n: number, b: string) => {
      calls.push({ method: "createIssueComment", args: [n, b] });
      return Promise.resolve({ ok: true as const });
    }),
    addLabels: vi.fn((n: number, l: readonly string[]) => {
      calls.push({ method: "addLabels", args: [n, [...l]] });
      return Promise.resolve({ ok: true as const });
    }),
    removeLabels: vi.fn((n: number, l: readonly string[]) => {
      calls.push({ method: "removeLabels", args: [n, [...l]] });
      return Promise.resolve({ ok: true as const });
    }),
    closeIssue: vi.fn((n: number) => {
      calls.push({ method: "closeIssue", args: [n] });
      return Promise.resolve({ ok: true as const });
    }),
  };
};

describe("GovernanceGitHubSync", () => {
  it("onCreate creates issue with correct labels and returns URL", async () => {
    const gh = makeMockGitHub();
    const sync = new GovernanceGitHubSync({ github: gh, defaultGroup: "intelligence" });
    const item = makeItem();

    const url = await sync.onCreate(item);

    expect(url).toBe("https://github.com/test/repo/issues/42");
    expect(gh.calls[0]?.method).toBe("createIssue");
    const input = gh.calls[0]?.args[0] as { title: string; labels: string[] };
    expect(input.title).toContain("[TENSION]");
    expect(input.title).toContain("Agent needs web search tools");
    expect(input.labels).toContain("governance:tension");
    expect(input.labels).toContain("state:open");
    expect(input.labels).toContain("agent:01-research");
    expect(input.labels).toContain("group:intelligence");
  });

  it("onCreate stores issue number in issueMap", async () => {
    const gh = makeMockGitHub();
    const sync = new GovernanceGitHubSync({ github: gh });
    const item = makeItem();

    await sync.onCreate(item);

    expect(sync.issueMap.get("test-item-001")).toBe(42);
  });

  it("onCreate returns undefined on failure", async () => {
    const gh = makeMockGitHub();
    gh.createIssue = vi.fn(() => Promise.resolve({ ok: false as const, error: "rate limited" }));
    const sync = new GovernanceGitHubSync({ github: gh });

    const url = await sync.onCreate(makeItem());

    expect(url).toBeUndefined();
  });

  it("onTransition posts comment and swaps labels", async () => {
    const gh = makeMockGitHub();
    const sync = new GovernanceGitHubSync({ github: gh });

    // First create to populate issueMap
    await sync.onCreate(makeItem());
    gh.calls.length = 0;

    // Now transition
    const transition = makeTransition();
    await sync.onTransition(makeItem({ currentState: "resolved" }), transition, false);

    // Should: comment + removeLabels(state:open) + addLabels(state:resolved)
    const methods = gh.calls.map((c) => c.method);
    expect(methods).toContain("createIssueComment");
    expect(methods).toContain("removeLabels");
    expect(methods).toContain("addLabels");

    const removeCall = gh.calls.find((c) => c.method === "removeLabels");
    expect(removeCall?.args[1]).toEqual(["state:open"]);

    const addCall = gh.calls.find((c) => c.method === "addLabels");
    expect(addCall?.args[1]).toEqual(["state:resolved"]);
  });

  it("onTransition closes issue when isTerminal is true", async () => {
    const gh = makeMockGitHub();
    const sync = new GovernanceGitHubSync({ github: gh });

    await sync.onCreate(makeItem());
    gh.calls.length = 0;

    await sync.onTransition(makeItem({ currentState: "resolved" }), makeTransition(), true);

    const methods = gh.calls.map((c) => c.method);
    expect(methods).toContain("closeIssue");
    const closeCall = gh.calls.find((c) => c.method === "closeIssue");
    expect(closeCall?.args[0]).toBe(42);
  });

  it("onTransition does NOT close issue when isTerminal is false", async () => {
    const gh = makeMockGitHub();
    const sync = new GovernanceGitHubSync({ github: gh });

    await sync.onCreate(makeItem());
    gh.calls.length = 0;

    await sync.onTransition(
      makeItem({ currentState: "proposal-needed" }),
      makeTransition({ from: "open", to: "proposal-needed" }),
      false,
    );

    const methods = gh.calls.map((c) => c.method);
    expect(methods).not.toContain("closeIssue");
  });

  it("onTransition skips unknown items (not in issueMap)", async () => {
    const gh = makeMockGitHub();
    const sync = new GovernanceGitHubSync({ github: gh });

    // Don't call onCreate — issueMap is empty
    await sync.onTransition(makeItem(), makeTransition(), true);

    expect(gh.calls).toHaveLength(0);
  });
});
