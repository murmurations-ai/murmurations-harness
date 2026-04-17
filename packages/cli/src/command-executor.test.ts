import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  AgentStateStore,
  DaemonEventBus,
  type DaemonEvent,
  type RegisteredAgent,
} from "@murmurations-ai/core";
import { DaemonCommandExecutor } from "./command-executor.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const makeTmpRoot = (): string => {
  const dir = join(tmpdir(), `murm-exec-test-${randomUUID().slice(0, 8)}`);
  mkdirSync(join(dir, ".murmuration", "agents"), { recursive: true });
  mkdirSync(join(dir, ".murmuration", "governance"), { recursive: true });
  mkdirSync(join(dir, ".murmuration", "runs", "01-research", "2026-04-13"), { recursive: true });
  // Write a digest file for agent detail test
  writeFileSync(
    join(dir, ".murmuration", "runs", "01-research", "2026-04-13", "digest-abc123.md"),
    "---\nagentId: 01-research\n---\nResearch digest: found 3 signals.",
    "utf8",
  );
  // Write governance items
  writeFileSync(
    join(dir, ".murmuration", "governance", "items.jsonl"),
    JSON.stringify({
      id: "item-001",
      kind: "tension",
      currentState: "open",
      payload: { topic: "Test tension" },
      createdBy: { kind: "agent-id", value: "01-research" },
      createdAt: "2026-04-13T00:00:00.000Z",
      reviewAt: null,
      history: [],
    }) + "\n",
    "utf8",
  );
  return dir;
};

const makeRegisteredAgent = (id: string, groups: string[] = []): RegisteredAgent => ({
  agentId: id,
  displayName: id,
  trigger: { kind: "delay-once", delayMs: 100 },
  groupMemberships: groups,
  modelTier: "fast" as const,
  maxWallClockMs: 5000,
  identityContent: {
    murmurationSoul: "test",
    agentSoul: "test",
    agentRole: "test",
    groupContexts: [],
  },
  githubWriteScopes: { issueComments: [], branchCommits: [], labels: [], issues: [] },
  signalScopes: {
    sources: ["github-issue"],
    githubScopes: [{ owner: "test", repo: "repo", filter: { state: "open" as const } }],
  },
  budget: { maxCostMicros: 100000, maxGithubApiCalls: 10, onBreach: "warn" as const },
  secrets: { required: [], optional: [] },
  tools: { mcp: [], cli: [] },
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DaemonCommandExecutor", () => {
  let rootDir: string;
  let agentStateStore: AgentStateStore;
  let eventBus: DaemonEventBus;
  let events: DaemonEvent[];
  const agents = [
    makeRegisteredAgent("01-research", ["intelligence"]),
    makeRegisteredAgent("02-content", ["content"]),
    makeRegisteredAgent("03-publishing", ["content"]),
  ];

  beforeEach(async () => {
    rootDir = makeTmpRoot();
    agentStateStore = new AgentStateStore({ persistDir: join(rootDir, ".murmuration", "agents") });
    for (const a of agents) {
      agentStateStore.register(a.agentId, a.maxWallClockMs);
    }
    await agentStateStore.flush();

    eventBus = new DaemonEventBus();
    events = [];
    eventBus.subscribe((e) => events.push(e));
  });

  afterEach(() => {
    if (existsSync(rootDir)) rmSync(rootDir, { recursive: true });
  });

  const makeExecutor = (): DaemonCommandExecutor =>
    new DaemonCommandExecutor({
      rootDir,
      agentStateStore,
      allRegistered: agents,
      governancePersistDir: join(rootDir, ".murmuration", "governance"),
      eventBus,
    });

  // -----------------------------------------------------------------------
  // buildStatus
  // -----------------------------------------------------------------------

  it("buildStatus returns correct agent count and groups", async () => {
    const executor = makeExecutor();
    const status = (await executor.buildStatus()) as {
      agentCount: number;
      agents: { agentId: string; groups: string[] }[];
      groups: { groupId: string; memberCount: number }[];
    };

    expect(status.agentCount).toBe(3);
    expect(status.agents).toHaveLength(3);
    expect(status.groups).toHaveLength(2); // intelligence + content

    const intelligence = status.groups.find((g) => g.groupId === "intelligence");
    expect(intelligence?.memberCount).toBe(1);

    const content = status.groups.find((g) => g.groupId === "content");
    expect(content?.memberCount).toBe(2);
  });

  it("buildStatus includes governance data", async () => {
    const executor = makeExecutor();
    const status = (await executor.buildStatus()) as {
      governance: { totalItems: number; pending: unknown[]; recentDecisions: unknown[] };
    };

    expect(status.governance.totalItems).toBe(1);
    expect(status.governance.pending).toHaveLength(1);
    expect(status.governance.recentDecisions).toHaveLength(0);
  });

  it("buildStatus includes in-flight meeting/wake arrays", async () => {
    const executor = makeExecutor();
    const status = (await executor.buildStatus()) as {
      inFlightMeetings: unknown[];
      inFlightWakes: unknown[];
      recentMeetings: unknown[];
    };

    expect(status.inFlightMeetings).toEqual([]);
    expect(status.inFlightWakes).toEqual([]);
    expect(status.recentMeetings).toEqual([]);
  });

  it("buildStatus includes version, schemaVersion, and pid", async () => {
    const executor = makeExecutor();
    const status = (await executor.buildStatus()) as {
      version: string;
      schemaVersion: number;
      pid: number;
    };

    expect(status.version).toBe("0.3.4");
    expect(status.schemaVersion).toBe(1);
    expect(status.pid).toBe(process.pid);
  });

  // -----------------------------------------------------------------------
  // agentDetail
  // -----------------------------------------------------------------------

  it("agentDetail returns agent state and digests", async () => {
    const executor = makeExecutor();
    const detail = (await executor.agentDetail("01-research")) as {
      agentId: string;
      state: string;
      totalWakes: number;
      recentDigests: { date: string; summary: string }[];
    };

    expect(detail.agentId).toBe("01-research");
    expect(detail.state).toBeDefined();
    expect(detail.recentDigests).toHaveLength(1);
    expect(detail.recentDigests[0]?.date).toBe("2026-04-13");
    expect(detail.recentDigests[0]?.summary).toContain("Research digest");
  });

  it("agentDetail handles unknown agent gracefully", async () => {
    const executor = makeExecutor();
    const detail = (await executor.agentDetail("nonexistent")) as {
      agentId: string;
      state: string;
      recentDigests: unknown[];
    };

    expect(detail.agentId).toBe("nonexistent");
    expect(detail.state).toBe("unknown");
    expect(detail.recentDigests).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // groupDetail
  // -----------------------------------------------------------------------

  it("groupDetail returns member list and stats", async () => {
    const executor = makeExecutor();
    const detail = (await executor.groupDetail("content")) as {
      groupId: string;
      memberCount: number;
      members: { agentId: string }[];
    };

    expect(detail.groupId).toBe("content");
    expect(detail.memberCount).toBe(2);
    expect(detail.members.map((m) => m.agentId)).toContain("02-content");
    expect(detail.members.map((m) => m.agentId)).toContain("03-publishing");
  });

  // -----------------------------------------------------------------------
  // execute — stop
  // -----------------------------------------------------------------------

  it("execute('stop') returns stopping: true", async () => {
    const executor = makeExecutor();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    try {
      const result = (await executor.execute("stop", {})) as { stopping: boolean };
      expect(result.stopping).toBe(true);
      expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGTERM");
    } finally {
      killSpy.mockRestore();
    }
  });

  // -----------------------------------------------------------------------
  // execute — unknown command
  // -----------------------------------------------------------------------

  it("execute throws on unknown command", async () => {
    const executor = makeExecutor();
    await expect(executor.execute("bogus", {})).rejects.toThrow("unknown command: bogus");
  });

  // -----------------------------------------------------------------------
  // governance status reader
  // -----------------------------------------------------------------------

  it("reads governance items from JSONL", async () => {
    const executor = makeExecutor();
    const status = (await executor.buildStatus()) as {
      governance: {
        pending: { id: string; kind: string; state: string; topic: string }[];
      };
    };

    expect(status.governance.pending).toHaveLength(1);
    const item = status.governance.pending[0];
    expect(item?.kind).toBe("tension");
    expect(item?.state).toBe("open");
    expect(item?.topic).toBe("Test tension");
  });

  it("handles empty governance store gracefully", async () => {
    // Delete the items file
    const itemsPath = join(rootDir, ".murmuration", "governance", "items.jsonl");
    rmSync(itemsPath);

    const executor = makeExecutor();
    const status = (await executor.buildStatus()) as {
      governance: { totalItems: number; pending: unknown[] };
    };

    expect(status.governance.totalItems).toBe(0);
    expect(status.governance.pending).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // RPC query methods
  // -----------------------------------------------------------------------

  it("execute('agents.list') returns agent array", async () => {
    const executor = makeExecutor();
    const agents = (await executor.execute("agents.list", {})) as {
      agentId: string;
      groups: string[];
    }[];

    expect(agents).toHaveLength(3);
    expect(agents[0]?.agentId).toBe("01-research");
    expect(agents[0]?.groups).toContain("intelligence");
  });

  it("execute('groups.list') returns group array", async () => {
    const executor = makeExecutor();
    const groups = (await executor.execute("groups.list", {})) as {
      groupId: string;
      memberCount: number;
    }[];

    expect(groups).toHaveLength(2);
    const content = groups.find((g) => g.groupId === "content");
    expect(content?.memberCount).toBe(2);
  });

  it("execute('cost.summary') returns totals and per-agent", async () => {
    const executor = makeExecutor();
    const cost = (await executor.execute("cost.summary", {})) as {
      totalWakes: number;
      totalArtifacts: number;
      agents: { agentId: string }[];
    };

    expect(cost.totalWakes).toBeGreaterThanOrEqual(0);
    expect(cost.agents).toHaveLength(3);
  });

  // -----------------------------------------------------------------------
  // Mutating flag enforcement (#84)
  // -----------------------------------------------------------------------

  it("execute rejects mutating methods when readOnly is true", async () => {
    const executor = makeExecutor();
    await expect(
      executor.execute("directive", { message: "test" }, { readOnly: true }),
    ).rejects.toThrow("mutating");
  });

  it("execute allows read-only methods when readOnly is true", async () => {
    const executor = makeExecutor();
    const agents = await executor.execute("agents.list", {}, { readOnly: true });
    expect(Array.isArray(agents)).toBe(true);
  });
});
