import { describe, expect, it } from "vitest";

import { makeAgentId } from "../execution/index.js";
import { GovernanceStateStore, NoOpGovernancePlugin, type GovernanceStateGraph } from "./index.js";

// Example state graphs covering different governance models.

const S3_TENSION: GovernanceStateGraph = {
  kind: "tension",
  initialState: "open",
  terminalStates: ["resolved", "withdrawn"],
  defaultReviewDays: 90,
  transitions: [
    { from: "open", to: "deliberating", trigger: "agent-action" },
    { from: "deliberating", to: "consent-round", trigger: "agent-action" },
    { from: "consent-round", to: "resolved", trigger: "approval" },
    { from: "consent-round", to: "deliberating", trigger: "objection" },
    { from: "open", to: "withdrawn", trigger: "agent-action" },
    { from: "deliberating", to: "withdrawn", trigger: "agent-action" },
  ],
};

const CC_DIRECTIVE: GovernanceStateGraph = {
  kind: "directive",
  initialState: "drafted",
  terminalStates: ["completed", "rejected"],
  defaultReviewDays: 30,
  transitions: [
    { from: "drafted", to: "submitted", trigger: "agent-action" },
    { from: "submitted", to: "approved", trigger: "approval" },
    { from: "submitted", to: "rejected", trigger: "approval" },
    { from: "approved", to: "executing", trigger: "agent-action" },
    { from: "executing", to: "completed", trigger: "agent-action" },
  ],
};

describe("GovernanceStateStore", () => {
  const AGENT = makeAgentId("01-research");

  it("registers graphs and creates items in the initial state", () => {
    const store = new GovernanceStateStore();
    store.registerGraph(S3_TENSION);

    const item = store.create("tension", AGENT, { topic: "pricing strategy" });
    expect(item.currentState).toBe("open");
    expect(item.kind).toBe("tension");
    expect(item.createdBy.value).toBe("01-research");
    expect(item.history).toHaveLength(0);
    expect(item.reviewAt).toBeNull(); // not terminal yet
  });

  it("transitions through states with audit trail", () => {
    const store = new GovernanceStateStore();
    store.registerGraph(S3_TENSION);

    const created = store.create("tension", AGENT, { topic: "test" });
    const deliberating = store.transition(
      created.id,
      "deliberating",
      AGENT.value,
      "needs discussion",
    );
    expect(deliberating.currentState).toBe("deliberating");
    expect(deliberating.history).toHaveLength(1);
    expect(deliberating.history[0]?.from).toBe("open");
    expect(deliberating.history[0]?.to).toBe("deliberating");
    expect(deliberating.history[0]?.reason).toBe("needs discussion");

    const round = store.transition(created.id, "consent-round", AGENT.value);
    expect(round.currentState).toBe("consent-round");
    expect(round.history).toHaveLength(2);
  });

  it("rejects invalid transitions", () => {
    const store = new GovernanceStateStore();
    store.registerGraph(S3_TENSION);

    const item = store.create("tension", AGENT, {});
    // "open" → "resolved" is not a valid transition (must go through deliberating + consent-round)
    expect(() => store.transition(item.id, "resolved", AGENT.value)).toThrow(
      /not valid for kind "tension"/,
    );
  });

  it("sets reviewAt when reaching a terminal state with defaultReviewDays", () => {
    const now = new Date("2026-04-10T12:00:00.000Z");
    const store = new GovernanceStateStore({ now: () => now });
    store.registerGraph(S3_TENSION);

    const item = store.create("tension", AGENT, {});
    store.transition(item.id, "deliberating", AGENT.value);
    store.transition(item.id, "consent-round", AGENT.value);
    const resolved = store.transition(item.id, "resolved", AGENT.value, "consent achieved");

    expect(resolved.currentState).toBe("resolved");
    expect(resolved.reviewAt).not.toBeNull();
    // 90 days from now
    const expected = new Date(now.getTime() + 90 * 86_400_000);
    expect(resolved.reviewAt?.getTime()).toBe(expected.getTime());
  });

  it("query filters by state, kind, and reviewDue", () => {
    const now = new Date("2026-04-10T12:00:00.000Z");
    const store = new GovernanceStateStore({ now: () => now });
    store.registerGraph(S3_TENSION);
    store.registerGraph(CC_DIRECTIVE);

    store.create("tension", AGENT, { topic: "a" });
    const b = store.create("directive", AGENT, { topic: "b" });
    store.transition(b.id, "submitted", AGENT.value);

    expect(store.query({ kind: "tension" })).toHaveLength(1);
    expect(store.query({ state: "submitted" })).toHaveLength(1);
    expect(store.query({ kind: "directive", state: "drafted" })).toHaveLength(0);
    expect(store.query()).toHaveLength(2);
  });

  it("reviewDue query surfaces items past their review date", () => {
    // Create a store where "now" is 91 days after a resolved tension.
    const day0 = new Date("2026-01-01T00:00:00.000Z");
    let currentTime = day0;
    const store = new GovernanceStateStore({ now: () => currentTime });
    store.registerGraph(S3_TENSION);

    const item = store.create("tension", AGENT, {});
    store.transition(item.id, "deliberating", AGENT.value);
    store.transition(item.id, "consent-round", AGENT.value);
    store.transition(item.id, "resolved", AGENT.value); // reviewAt = day0 + 90d

    // At day 0, not yet due.
    expect(store.query({ reviewDue: true })).toHaveLength(0);

    // Jump to day 91.
    currentTime = new Date(day0.getTime() + 91 * 86_400_000);
    expect(store.query({ reviewDue: true })).toHaveLength(1);
    expect(store.query({ reviewDue: true })[0]?.id).toBe(item.id);
  });

  it("buildDecisionRecord captures the full audit trail", () => {
    const store = new GovernanceStateStore();
    store.registerGraph(CC_DIRECTIVE);

    const item = store.create("directive", AGENT, { directive: "deploy to prod" });
    store.transition(item.id, "submitted", AGENT.value);
    store.transition(item.id, "approved", "source", "LGTM");
    store.transition(item.id, "executing", AGENT.value);
    store.transition(item.id, "completed", AGENT.value);

    const record = store.buildDecisionRecord(item.id, "Production deployment completed");
    expect(record.kind).toBe("directive");
    expect(record.finalState).toBe("completed");
    expect(record.summary).toBe("Production deployment completed");
    expect(record.history).toHaveLength(4);
    expect(record.createdBy).toBe("01-research");
    expect(record.reviewAt).not.toBeNull();
  });

  it("works with the command-and-control graph (amber model)", () => {
    const store = new GovernanceStateStore();
    store.registerGraph(CC_DIRECTIVE);

    const item = store.create("directive", AGENT, { action: "reassign team" });
    store.transition(item.id, "submitted", AGENT.value);
    // Rejected by authority.
    const rejected = store.transition(item.id, "rejected", "source", "budget constraints");
    expect(rejected.currentState).toBe("rejected");
    expect(rejected.history).toHaveLength(2);
  });
});

describe("NoOpGovernancePlugin", () => {
  it("declares no state graphs", () => {
    const plugin = new NoOpGovernancePlugin();
    expect(plugin.stateGraphs()).toEqual([]);
  });

  it("allows every action", async () => {
    const plugin = new NoOpGovernancePlugin();
    const store = new GovernanceStateStore();
    const decision = await plugin.evaluateAction(makeAgentId("x"), "anything", {}, store);
    expect(decision.allow).toBe(true);
  });

  it("discards every event (returns empty routing)", async () => {
    const plugin = new NoOpGovernancePlugin();
    const store = new GovernanceStateStore();
    const decisions = await plugin.onEventsEmitted(
      {
        wakeId: { kind: "wake-id", value: "w1" },
        agentId: makeAgentId("x"),
        events: [{ kind: "some-custom-kind", payload: {} }],
      },
      store,
    );
    expect(decisions).toEqual([]);
  });
});
