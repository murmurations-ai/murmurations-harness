import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { makeAgentId } from "../execution/index.js";
import {
  GovernanceStateStore,
  NoOpGovernancePlugin,
  makeGovernanceStateReader,
  type GovernancePlugin,
  type GovernanceStateGraph,
  type GovernanceItem,
} from "./index.js";

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

const CHAIN_OF_COMMAND_DIRECTIVE: GovernanceStateGraph = {
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
    store.registerGraph(CHAIN_OF_COMMAND_DIRECTIVE);

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
    store.registerGraph(CHAIN_OF_COMMAND_DIRECTIVE);

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
    store.registerGraph(CHAIN_OF_COMMAND_DIRECTIVE);

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

// ---------------------------------------------------------------------------
// GovernanceTerminology + DEFAULT_TERMINOLOGY
// ---------------------------------------------------------------------------

describe("GovernanceTerminology", () => {
  it("NoOpGovernancePlugin has no terminology (uses defaults)", () => {
    const plugin: GovernancePlugin = new NoOpGovernancePlugin();
    expect(plugin.terminology).toBeUndefined();
  });

  it("DEFAULT_TERMINOLOGY uses generic terms", async () => {
    const { DEFAULT_TERMINOLOGY } = await import("./index.js");
    expect(DEFAULT_TERMINOLOGY.group).toBe("group");
    expect(DEFAULT_TERMINOLOGY.groupPlural).toBe("groups");
    expect(DEFAULT_TERMINOLOGY.governanceItem).toBe("item");
    expect(DEFAULT_TERMINOLOGY.governanceEvent).toBe("governance event");
  });
});

// ---------------------------------------------------------------------------
// Sync callbacks (#49)
// ---------------------------------------------------------------------------

describe("GovernanceSyncCallbacks", () => {
  const AGENT = makeAgentId("01-research");

  it("fires onCreate callback when an item is created", () => {
    const created: GovernanceItem[] = [];
    const store = new GovernanceStateStore({
      onSync: {
        onCreate: (item) => {
          created.push(item);
          return undefined;
        },
      },
    });
    store.registerGraph(S3_TENSION);
    store.create("tension", AGENT, { topic: "test" });
    expect(created).toHaveLength(1);
    expect(created[0]?.kind).toBe("tension");
  });

  it("fires onTransition callback on state change", () => {
    const transitions: { item: GovernanceItem; transition: { from: string; to: string } }[] = [];
    const store = new GovernanceStateStore({
      onSync: {
        onTransition: (item, t) =>
          transitions.push({ item, transition: { from: t.from, to: t.to } }),
      },
    });
    store.registerGraph(S3_TENSION);
    const item = store.create("tension", AGENT, {});
    store.transition(item.id, "deliberating", AGENT.value);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.transition.from).toBe("open");
    expect(transitions[0]?.transition.to).toBe("deliberating");
  });

  it("swallows errors from sync callbacks without blocking governance ops", () => {
    const store = new GovernanceStateStore({
      onSync: {
        onCreate: () => {
          throw new Error("sync boom");
        },
        onTransition: () => {
          throw new Error("sync boom");
        },
      },
    });
    store.registerGraph(S3_TENSION);
    // Should not throw despite the callbacks throwing
    const item = store.create("tension", AGENT, {});
    const updated = store.transition(item.id, "deliberating", AGENT.value);
    expect(updated.currentState).toBe("deliberating");
  });
});

// ---------------------------------------------------------------------------
// GovernancePlugin contract tests (#48)
// ---------------------------------------------------------------------------

describe("GovernancePlugin + Daemon dispatch contract", () => {
  it("NoOpGovernancePlugin stateGraphs returns empty array", () => {
    const plugin = new NoOpGovernancePlugin();
    expect(plugin.stateGraphs()).toEqual([]);
  });

  it("NoOpGovernancePlugin evaluateAction always allows", async () => {
    const plugin = new NoOpGovernancePlugin();
    const store = new GovernanceStateStore();
    const result = await plugin.evaluateAction(
      makeAgentId("test"),
      "commit",
      { file: "a.md" },
      store,
    );
    expect(result.allow).toBe(true);
  });

  it("GovernancePlugin onEventsEmitted requests creates via decision.create", async () => {
    // Plugins cannot mutate the store directly — they attach a `create`
    // field to their routing decision and the daemon performs the write.
    const store = new GovernanceStateStore();
    store.registerGraph(S3_TENSION);

    const plugin = new NoOpGovernancePlugin();
    plugin.onEventsEmitted = (batch, _reader) => {
      const decisions = batch.events
        .filter((event) => event.kind === "tension")
        .map((event) => ({
          event,
          routes: [{ target: "source" as const }],
          create: { kind: "tension", payload: event.payload },
        }));
      return Promise.resolve(decisions);
    };

    const batch = {
      wakeId: { kind: "wake-id" as const, value: "w1" },
      agentId: makeAgentId("01-research"),
      events: [{ kind: "tension", payload: { topic: "pricing" } }],
    };
    const decisions = await plugin.onEventsEmitted(batch, store);

    // Simulate the daemon applying the plugin's create requests.
    for (const decision of decisions) {
      if (decision.create) {
        store.create(decision.create.kind, batch.agentId, decision.create.payload);
      }
    }
    expect(store.query({ kind: "tension" })).toHaveLength(1);
  });

  it("makeGovernanceStateReader withholds write methods at runtime", () => {
    const store = new GovernanceStateStore();
    store.registerGraph(S3_TENSION);
    const reader = makeGovernanceStateReader(store);

    // Read methods are present and functional.
    expect(typeof reader.graphs).toBe("function");
    expect(typeof reader.query).toBe("function");
    expect(reader.size()).toBe(0);

    // Write methods are absent — a .mjs plugin casting back cannot
    // mutate the store through this handle.
    expect("create" in reader).toBe(false);
    expect("transition" in reader).toBe(false);
    expect("setGithubIssueUrl" in reader).toBe(false);
    expect("registerGraph" in reader).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Durable persistence
// ---------------------------------------------------------------------------

describe("GovernanceStateStore persistence", () => {
  let persistDir = "";

  afterEach(async () => {
    if (persistDir) await rm(persistDir, { recursive: true, force: true });
  });

  it("persists items to disk and restores them on load()", async () => {
    persistDir = await mkdtemp(join(tmpdir(), "gov-persist-"));
    const AGENT = makeAgentId("01-research");

    // Write phase
    const store1 = new GovernanceStateStore({ persistDir });
    store1.registerGraph(S3_TENSION);
    const item = store1.create("tension", AGENT, { topic: "pricing" });
    store1.transition(item.id, "deliberating", AGENT.value, "needs discussion");
    await store1.flush();

    // Verify file exists
    const contents = await readFile(join(persistDir, "items.jsonl"), "utf8");
    expect(contents.trim().length).toBeGreaterThan(0);

    // Read phase — new store, same persistDir
    const store2 = new GovernanceStateStore({ persistDir });
    store2.registerGraph(S3_TENSION);
    const loaded = await store2.load();
    expect(loaded).toBe(1);

    const restored = store2.get(item.id);
    expect(restored).toBeDefined();
    expect(restored?.currentState).toBe("deliberating");
    expect(restored?.history).toHaveLength(1);
    expect(restored?.history[0]?.reason).toBe("needs discussion");
  });

  it("load returns 0 when no file exists", async () => {
    persistDir = await mkdtemp(join(tmpdir(), "gov-persist-"));
    const store = new GovernanceStateStore({ persistDir });
    const loaded = await store.load();
    expect(loaded).toBe(0);
  });

  it("load skips malformed lines gracefully", async () => {
    persistDir = await mkdtemp(join(tmpdir(), "gov-persist-"));
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(
      join(persistDir, "items.jsonl"),
      '{"id":"good","kind":"tension","currentState":"open","payload":{},"createdBy":{"value":"x"},"createdAt":"2026-01-01T00:00:00.000Z","reviewAt":null,"history":[]}\nnot valid json\n',
      "utf8",
    );
    const store = new GovernanceStateStore({ persistDir });
    const loaded = await store.load();
    expect(loaded).toBe(1); // good line loaded, bad line skipped
  });
});
