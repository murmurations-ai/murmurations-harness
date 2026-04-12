import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AgentStateStore } from "./index.js";

describe("AgentStateStore", () => {
  it("registers agents in 'registered' state and transitions to idle", () => {
    const store = new AgentStateStore();
    store.register("01-research", 120000);
    store.transition("01-research", "idle");

    const agent = store.getAgent("01-research");
    expect(agent).toBeDefined();
    expect(agent?.currentState).toBe("idle");
    expect(agent?.totalWakes).toBe(0);
    expect(agent?.consecutiveFailures).toBe(0);
  });

  it("tracks the full wake lifecycle: idle → waking → running → completed → idle", () => {
    const store = new AgentStateStore();
    store.register("01-research", 120000);
    store.transition("01-research", "idle");

    store.transition("01-research", "waking", "wake-001");
    expect(store.getAgent("01-research")?.currentState).toBe("waking");
    expect(store.getAgent("01-research")?.currentWakeId).toBe("wake-001");

    store.transition("01-research", "running", "wake-001");
    expect(store.getAgent("01-research")?.currentState).toBe("running");

    store.recordWakeOutcome("wake-001", "success", { costMicros: 5000 });
    const agent = store.getAgent("01-research");
    expect(agent?.currentState).toBe("idle");
    expect(agent?.lastOutcome).toBe("success");
    expect(agent?.totalWakes).toBe(1);
    expect(agent?.consecutiveFailures).toBe(0);
    expect(agent?.currentWakeId).toBeNull();
  });

  it("tracks consecutive failures and resets on success", () => {
    const store = new AgentStateStore();
    store.register("test", 120000);
    store.transition("test", "idle");

    // Two failures
    store.transition("test", "waking", "w1");
    store.transition("test", "running", "w1");
    store.recordWakeOutcome("w1", "failure", { errorMessage: "boom" });
    expect(store.getAgent("test")?.consecutiveFailures).toBe(1);

    store.transition("test", "waking", "w2");
    store.transition("test", "running", "w2");
    store.recordWakeOutcome("w2", "timeout");
    expect(store.getAgent("test")?.consecutiveFailures).toBe(2);

    // Success resets
    store.transition("test", "waking", "w3");
    store.transition("test", "running", "w3");
    store.recordWakeOutcome("w3", "success");
    expect(store.getAgent("test")?.consecutiveFailures).toBe(0);
  });

  it("getStalledAgents detects agents stuck in running state", () => {
    let now = new Date("2026-04-11T12:00:00Z");
    const store = new AgentStateStore({ now: () => now });
    store.register("fast", 5000);
    store.register("slow", 120000);
    store.transition("fast", "idle");
    store.transition("slow", "idle");

    store.transition("fast", "waking", "w1");
    store.transition("fast", "running", "w1");
    store.transition("slow", "waking", "w2");
    store.transition("slow", "running", "w2");

    // Jump forward 10s — fast (5s ceiling) is stalled, slow (120s) is not
    now = new Date("2026-04-11T12:00:10Z");
    const stalled = store.getStalledAgents();
    expect(stalled).toHaveLength(1);
    expect(stalled[0]?.agentId).toBe("fast");
  });

  it("getRecentWakes returns wakes most-recent-first", () => {
    const store = new AgentStateStore();
    store.register("agent", 120000);
    store.transition("agent", "idle");

    for (let i = 1; i <= 3; i++) {
      store.transition("agent", "waking", `w${String(i)}`);
      store.transition("agent", "running", `w${String(i)}`);
      store.recordWakeOutcome(`w${String(i)}`, "success");
    }

    const wakes = store.getRecentWakes("agent");
    expect(wakes).toHaveLength(3);
    expect(wakes[0]?.wakeId).toBe("w3");
    expect(wakes[2]?.wakeId).toBe("w1");
  });

  it("getAllAgents returns all registered agents", () => {
    const store = new AgentStateStore();
    store.register("a", 1000);
    store.register("b", 2000);
    store.register("c", 3000);
    expect(store.getAllAgents()).toHaveLength(3);
  });
});

describe("AgentStateStore persistence", () => {
  let persistDir = "";

  afterEach(async () => {
    if (persistDir) await rm(persistDir, { recursive: true, force: true });
  });

  it("persists state and restores on load", async () => {
    persistDir = await mkdtemp(join(tmpdir(), "agent-state-"));

    // Write phase
    const store1 = new AgentStateStore({ persistDir });
    store1.register("01-research", 120000);
    store1.transition("01-research", "idle");
    store1.transition("01-research", "waking", "w1");
    store1.transition("01-research", "running", "w1");
    store1.recordWakeOutcome("w1", "success", { costMicros: 5000 });
    await store1.flush();

    // Read phase
    const store2 = new AgentStateStore({ persistDir });
    const loaded = await store2.load();
    expect(loaded).toBe(1);

    const agent = store2.getAgent("01-research");
    expect(agent?.currentState).toBe("idle");
    expect(agent?.totalWakes).toBe(1);
    expect(agent?.lastOutcome).toBe("success");

    const wakes = store2.getRecentWakes("01-research");
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.outcome).toBe("success");
    expect(wakes[0]?.costMicros).toBe(5000);
  });
});
