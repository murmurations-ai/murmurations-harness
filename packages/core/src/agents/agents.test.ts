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

  it("spawn-failed outcome increments consecutiveFailures and records on wake (#329)", () => {
    const store = new AgentStateStore();
    store.register("agent-x", 120000);
    store.transition("agent-x", "idle");

    // Spawn fails before running state — agent stays in waking
    store.transition("agent-x", "waking", "w-sf");
    store.recordWakeOutcome("w-sf", "spawn-failed", {
      errorMessage: "ENOENT: binary not found",
    });

    expect(store.getAgent("agent-x")?.consecutiveFailures).toBe(1);
    expect(store.getAgent("agent-x")?.lastOutcome).toBe("spawn-failed");
    expect(store.getAgent("agent-x")?.currentState).toBe("idle");

    const wakes = store.getRecentWakes("agent-x");
    const wake = wakes.find((w) => w.wakeId === "w-sf");
    expect(wake?.outcome).toBe("spawn-failed");
    expect(wake?.state).toBe("spawn-failed");
    expect(wake?.errorMessage).toBe("ENOENT: binary not found");
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

  it("throws on transition with unknown agentId", () => {
    const store = new AgentStateStore();
    expect(() => store.transition("ghost", "idle")).toThrow(/unknown agentId "ghost"/);
  });

  it("tracks totalArtifacts and idleWakes", () => {
    const store = new AgentStateStore();
    store.register("agent", 120000);
    store.transition("agent", "idle");

    // Productive wake (3 artifacts)
    store.transition("agent", "waking", "w1");
    store.transition("agent", "running", "w1");
    store.recordWakeOutcome("w1", "success", { artifactCount: 3 });
    expect(store.getAgent("agent")?.totalArtifacts).toBe(3);
    expect(store.getAgent("agent")?.idleWakes).toBe(0);

    // Idle wake (0 artifacts)
    store.transition("agent", "waking", "w2");
    store.transition("agent", "running", "w2");
    store.recordWakeOutcome("w2", "success", { artifactCount: 0 });
    expect(store.getAgent("agent")?.totalArtifacts).toBe(3);
    expect(store.getAgent("agent")?.idleWakes).toBe(1);

    // Failed wake doesn't count as idle
    store.transition("agent", "waking", "w3");
    store.transition("agent", "running", "w3");
    store.recordWakeOutcome("w3", "failure");
    expect(store.getAgent("agent")?.idleWakes).toBe(1); // still 1
  });

  it("getAllAgents returns all registered agents", () => {
    const store = new AgentStateStore();
    store.register("a", 1000);
    store.register("b", 2000);
    store.register("c", 3000);
    expect(store.getAllAgents()).toHaveLength(3);
  });

  // -------------------------------------------------------------------
  // Idle-wake skip — harness#297
  // -------------------------------------------------------------------

  it("recordFiredContextHash stores the hash and resets idleSkipStreak", () => {
    const store = new AgentStateStore();
    store.register("agent", 1000);
    expect(store.getAgent("agent")?.lastFiredContextHash).toBeNull();
    expect(store.getAgent("agent")?.idleSkipStreak).toBe(0);

    // Simulate a few skips first.
    store.recordIdleSkip("agent");
    store.recordIdleSkip("agent");
    expect(store.getAgent("agent")?.idleSkipStreak).toBe(2);

    // A real fire records the hash and zeros the streak.
    store.recordFiredContextHash("agent", "abc123");
    expect(store.getAgent("agent")?.lastFiredContextHash).toBe("abc123");
    expect(store.getAgent("agent")?.idleSkipStreak).toBe(0);
  });

  it("recordIdleSkip increments idleSkipStreak monotonically", () => {
    const store = new AgentStateStore();
    store.register("agent", 1000);

    store.recordIdleSkip("agent");
    expect(store.getAgent("agent")?.idleSkipStreak).toBe(1);
    store.recordIdleSkip("agent");
    store.recordIdleSkip("agent");
    expect(store.getAgent("agent")?.idleSkipStreak).toBe(3);
  });

  it("idle-skip methods are no-ops for unknown agentId", () => {
    const store = new AgentStateStore();
    expect(() => store.recordFiredContextHash("ghost", "x")).not.toThrow();
    expect(() => store.recordIdleSkip("ghost")).not.toThrow();
    expect(store.getAgent("ghost")).toBeUndefined();
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

describe("AgentStateStore orphan reconciliation (harness#405)", () => {
  it("markOrphaned transitions a known agent to 'orphaned'", () => {
    const store = new AgentStateStore();
    store.register("test-agent", 10_000);
    store.transition("test-agent", "idle");
    expect(store.getAgent("test-agent")?.currentState).toBe("idle");

    store.markOrphaned("test-agent");
    expect(store.getAgent("test-agent")?.currentState).toBe("orphaned");
  });

  it("markOrphaned is idempotent (re-calling on orphaned is a no-op)", () => {
    const store = new AgentStateStore();
    store.register("test-agent", 10_000);
    store.markOrphaned("test-agent");
    const first = store.getAgent("test-agent");
    store.markOrphaned("test-agent");
    const second = store.getAgent("test-agent");
    expect(second).toEqual(first);
  });

  it("markOrphaned is a no-op on unknown agentId", () => {
    const store = new AgentStateStore();
    expect(() => store.markOrphaned("ghost")).not.toThrow();
    expect(store.getAgent("ghost")).toBeUndefined();
  });

  it("markOrphaned clears currentWakeId and currentWakeStartedAt", () => {
    const store = new AgentStateStore();
    store.register("test-agent", 10_000);
    store.transition("test-agent", "waking", "w-1");
    expect(store.getAgent("test-agent")?.currentWakeId).toBe("w-1");

    store.markOrphaned("test-agent");
    expect(store.getAgent("test-agent")?.currentWakeId).toBeNull();
    expect(store.getAgent("test-agent")?.currentWakeStartedAt).toBeNull();
  });

  it("register resurrects orphaned agents and resets failure counters", () => {
    const store = new AgentStateStore();
    store.register("test-agent", 10_000);
    // Simulate a history: 5 wakes, then 3 consecutive failures
    store.transition("test-agent", "waking", "w1");
    store.recordWakeOutcome("w1", "success");
    store.transition("test-agent", "waking", "w2");
    store.recordWakeOutcome("w2", "failure", { errorMessage: "boom" });
    store.transition("test-agent", "waking", "w3");
    store.recordWakeOutcome("w3", "failure", { errorMessage: "boom" });
    store.transition("test-agent", "waking", "w4");
    store.recordWakeOutcome("w4", "failure", { errorMessage: "boom" });

    const beforeOrphan = store.getAgent("test-agent");
    expect(beforeOrphan?.consecutiveFailures).toBe(3);
    expect(beforeOrphan?.totalWakes).toBe(4);

    // Operator removes role.md, daemon reconciles
    store.markOrphaned("test-agent");
    expect(store.getAgent("test-agent")?.currentState).toBe("orphaned");

    // Operator restores role.md (possibly a new, different agent at the
    // same slug). Next boot calls register() again.
    store.register("test-agent", 12_000);
    const after = store.getAgent("test-agent");
    expect(after?.currentState).toBe("registered");
    expect(after?.consecutiveFailures).toBe(0); // RESET — old failures don't apply to new role.md
    expect(after?.idleSkipStreak).toBe(0);
    expect(after?.currentWakeId).toBeNull();
    expect(after?.lastFiredContextHash).toBeNull();
    // Historical totals preserved so the audit trail isn't lost.
    expect(after?.totalWakes).toBe(4);
    expect(after?.maxWallClockMs).toBe(12_000); // updated to new
  });

  it("normal re-registration (non-orphaned) only updates maxWallClockMs (existing behaviour preserved)", () => {
    const store = new AgentStateStore();
    store.register("test-agent", 10_000);
    store.transition("test-agent", "waking", "w1");
    store.recordWakeOutcome("w1", "failure", { errorMessage: "boom" });
    expect(store.getAgent("test-agent")?.consecutiveFailures).toBe(1);

    // Daemon restart — agent is still live, register() called again
    store.register("test-agent", 15_000);
    const after = store.getAgent("test-agent");
    expect(after?.consecutiveFailures).toBe(1); // PRESERVED — not orphaned
    expect(after?.maxWallClockMs).toBe(15_000);
  });
});
