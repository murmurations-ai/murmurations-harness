import { describe, it, expect, vi } from "vitest";
import { GovernanceGitHubSync } from "./github-sync.js";
import type { GovernanceItem, GovernanceStateTransition } from "./index.js";
import {
  CollaborationError,
  type CollaborationProvider,
  type ItemRef,
} from "../collaboration/types.js";
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

interface MockProvider extends CollaborationProvider {
  calls: { method: string; args: unknown[] }[];
}

const makeMockProvider = (): MockProvider => {
  const calls: { method: string; args: unknown[] }[] = [];
  return {
    calls,
    createItem: vi.fn((input: unknown) => {
      calls.push({ method: "createItem", args: [input] });
      const ref: ItemRef = { id: "42", url: "https://github.com/test/repo/issues/42" };
      return Promise.resolve({ ok: true as const, value: ref });
    }),
    postComment: vi.fn((ref: ItemRef, body: string) => {
      calls.push({ method: "postComment", args: [ref, body] });
      return Promise.resolve({ ok: true as const, value: undefined });
    }),
    addLabels: vi.fn((ref: ItemRef, labels: readonly string[]) => {
      calls.push({ method: "addLabels", args: [ref, [...labels]] });
      return Promise.resolve({ ok: true as const, value: undefined });
    }),
    removeLabel: vi.fn((ref: ItemRef, label: string) => {
      calls.push({ method: "removeLabel", args: [ref, label] });
      return Promise.resolve({ ok: true as const, value: undefined });
    }),
    updateItemState: vi.fn((ref: ItemRef, state: "open" | "closed") => {
      calls.push({ method: "updateItemState", args: [ref, state] });
      return Promise.resolve({ ok: true as const, value: undefined });
    }),
  } as unknown as MockProvider;
};

describe("GovernanceGitHubSync (CollaborationProvider)", () => {
  it("onCreate creates item with correct labels and returns URL", async () => {
    const provider = makeMockProvider();
    const sync = new GovernanceGitHubSync({ provider, defaultGroup: "intelligence" });
    const item = makeItem();

    const url = await sync.onCreate(item);

    expect(url).toBe("https://github.com/test/repo/issues/42");
    expect(provider.calls[0]?.method).toBe("createItem");
    const input = provider.calls[0]?.args[0] as { title: string; labels: string[] };
    expect(input.title).toContain("[TENSION]");
    expect(input.title).toContain("Agent needs web search tools");
    expect(input.labels).toContain("governance:tension");
    expect(input.labels).toContain("state:open");
    expect(input.labels).toContain("agent:01-research");
    expect(input.labels).toContain("group:intelligence");
  });

  it("onCreate stores item ref in itemMap", async () => {
    const provider = makeMockProvider();
    const sync = new GovernanceGitHubSync({ provider });

    await sync.onCreate(makeItem());

    expect(sync.itemMap.get("test-item-001")?.id).toBe("42");
    expect(sync.issueMap.get("test-item-001")).toBe(42);
  });

  it("onCreate returns undefined on failure", async () => {
    const provider = makeMockProvider();
    provider.createItem = vi.fn(() =>
      Promise.resolve({
        ok: false as const,
        error: new CollaborationError("test", "RATE_LIMITED", "rate limited"),
      }),
    );
    const sync = new GovernanceGitHubSync({ provider });

    const url = await sync.onCreate(makeItem());

    expect(url).toBeUndefined();
  });

  it("onTransition posts comment and swaps labels", async () => {
    const provider = makeMockProvider();
    const sync = new GovernanceGitHubSync({ provider });

    await sync.onCreate(makeItem());
    provider.calls.length = 0;

    await sync.onTransition(makeItem({ currentState: "resolved" }), makeTransition(), false);

    const methods = provider.calls.map((c) => c.method);
    expect(methods).toContain("postComment");
    expect(methods).toContain("removeLabel");
    expect(methods).toContain("addLabels");

    const removeCall = provider.calls.find((c) => c.method === "removeLabel");
    expect(removeCall?.args[1]).toBe("state:open");

    const addCall = provider.calls.find((c) => c.method === "addLabels");
    expect(addCall?.args[1]).toEqual(["state:resolved"]);
  });

  it("onTransition closes item when isTerminal is true", async () => {
    const provider = makeMockProvider();
    const sync = new GovernanceGitHubSync({ provider });

    await sync.onCreate(makeItem());
    provider.calls.length = 0;

    await sync.onTransition(makeItem({ currentState: "resolved" }), makeTransition(), true);

    const methods = provider.calls.map((c) => c.method);
    expect(methods).toContain("updateItemState");
    const closeCall = provider.calls.find((c) => c.method === "updateItemState");
    expect(closeCall?.args[1]).toBe("closed");
  });

  it("onTransition does NOT close when isTerminal is false", async () => {
    const provider = makeMockProvider();
    const sync = new GovernanceGitHubSync({ provider });

    await sync.onCreate(makeItem());
    provider.calls.length = 0;

    await sync.onTransition(
      makeItem({ currentState: "proposal-needed" }),
      makeTransition({ from: "open", to: "proposal-needed" }),
      false,
    );

    const methods = provider.calls.map((c) => c.method);
    expect(methods).not.toContain("updateItemState");
  });

  it("onTransition skips unknown items (not in itemMap)", async () => {
    const provider = makeMockProvider();
    const sync = new GovernanceGitHubSync({ provider });

    await sync.onTransition(makeItem(), makeTransition(), true);

    expect(provider.calls).toHaveLength(0);
  });
});
