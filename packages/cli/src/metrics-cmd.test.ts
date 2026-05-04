import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { computeMetricsFromDisk } from "./metrics-cmd.js";

describe("computeMetricsFromDisk", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "metrics-cmd-"));
  });

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("returns an empty snapshot with notes when no artifacts exist", async () => {
    const now = new Date("2026-05-04T10:00:00Z");
    const since = new Date("2026-04-04T10:00:00Z");
    const snapshot = await computeMetricsFromDisk({ rootDir: dir, since, now, windowDays: 30 });

    expect(snapshot.aggregate.totalWakes).toBe(0);
    expect(snapshot.aggregate.completionRate).toBe(0);
    expect(snapshot.perAgent).toEqual([]);
    expect(snapshot.accountabilityMetRates).toEqual([]);
    expect(snapshot.notes.length).toBeGreaterThan(0);
    expect(snapshot.notes.some((n) => n.includes("No wake records"))).toBe(true);
  });

  it("aggregates wake records across agents and computes completion rate", async () => {
    // Two agents, each with two wakes, one completed + one failed each.
    await mkdir(join(dir, "runs", "agent-a"), { recursive: true });
    await mkdir(join(dir, "runs", "agent-b"), { recursive: true });
    const aLines = [
      indexLine({
        wakeId: "w1",
        agentId: "agent-a",
        outcome: "completed",
        startedAt: "2026-04-30T10:00:00Z",
        costMicros: 100,
      }),
      indexLine({
        wakeId: "w2",
        agentId: "agent-a",
        outcome: "failed",
        startedAt: "2026-04-30T11:00:00Z",
        costMicros: 50,
      }),
    ];
    const bLines = [
      indexLine({
        wakeId: "w3",
        agentId: "agent-b",
        outcome: "completed",
        startedAt: "2026-05-01T10:00:00Z",
        costMicros: 200,
      }),
      indexLine({
        wakeId: "w4",
        agentId: "agent-b",
        outcome: "timed-out",
        startedAt: "2026-05-01T11:00:00Z",
        costMicros: 0,
      }),
    ];
    await writeFile(join(dir, "runs", "agent-a", "index.jsonl"), aLines.join("\n") + "\n", "utf8");
    await writeFile(join(dir, "runs", "agent-b", "index.jsonl"), bLines.join("\n") + "\n", "utf8");

    const now = new Date("2026-05-04T10:00:00Z");
    const since = new Date("2026-04-04T10:00:00Z");
    const snapshot = await computeMetricsFromDisk({ rootDir: dir, since, now, windowDays: 30 });

    expect(snapshot.aggregate.totalWakes).toBe(4);
    expect(snapshot.aggregate.completedWakes).toBe(2);
    expect(snapshot.aggregate.completionRate).toBe(0.5);
    expect(snapshot.aggregate.totalCostMicros).toBe(350);

    expect(snapshot.perAgent).toHaveLength(2);
    const a = snapshot.perAgent.find((p) => p.agentId === "agent-a");
    const b = snapshot.perAgent.find((p) => p.agentId === "agent-b");
    expect(a?.totalWakes).toBe(2);
    expect(a?.completedWakes).toBe(1);
    expect(a?.totalCostMicros).toBe(150);
    expect(b?.totalWakes).toBe(2);
    expect(b?.completedWakes).toBe(1);
    expect(b?.totalCostMicros).toBe(200);
  });

  it("filters wakes outside the window", async () => {
    await mkdir(join(dir, "runs", "agent-a"), { recursive: true });
    const lines = [
      indexLine({
        wakeId: "old",
        agentId: "agent-a",
        outcome: "completed",
        startedAt: "2026-01-01T10:00:00Z",
        costMicros: 999,
      }),
      indexLine({
        wakeId: "fresh",
        agentId: "agent-a",
        outcome: "completed",
        startedAt: "2026-04-30T10:00:00Z",
        costMicros: 10,
      }),
    ];
    await writeFile(join(dir, "runs", "agent-a", "index.jsonl"), lines.join("\n") + "\n", "utf8");

    const now = new Date("2026-05-04T10:00:00Z");
    const since = new Date("2026-04-04T10:00:00Z");
    const snapshot = await computeMetricsFromDisk({ rootDir: dir, since, now, windowDays: 30 });

    expect(snapshot.aggregate.totalWakes).toBe(1);
    expect(snapshot.aggregate.totalCostMicros).toBe(10);
  });

  it("rolls up accountability observations from .murmuration/", async () => {
    const obsDir = join(dir, ".murmuration");
    await mkdir(obsDir, { recursive: true });
    const obsPath = join(obsDir, "accountability-observations.jsonl");
    const obsLines = [
      JSON.stringify({
        accountabilityId: "weekly-digest",
        agentId: "agent-a",
        observedAt: "2026-04-30T10:00:00Z",
        met: true,
      }),
      JSON.stringify({
        accountabilityId: "weekly-digest",
        agentId: "agent-a",
        observedAt: "2026-05-01T10:00:00Z",
        met: false,
      }),
      JSON.stringify({
        accountabilityId: "weekly-digest",
        agentId: "agent-a",
        observedAt: "2026-05-02T10:00:00Z",
        met: true,
      }),
    ];
    await writeFile(obsPath, obsLines.join("\n") + "\n", "utf8");

    const now = new Date("2026-05-04T10:00:00Z");
    const since = new Date("2026-04-04T10:00:00Z");
    const snapshot = await computeMetricsFromDisk({ rootDir: dir, since, now, windowDays: 30 });

    expect(snapshot.accountabilityMetRates).toHaveLength(1);
    const rate = snapshot.accountabilityMetRates[0];
    expect(rate?.accountabilityId).toBe("weekly-digest");
    expect(rate?.observations).toBe(3);
    expect(rate?.metCount).toBe(2);
    expect(rate?.rate).toBeCloseTo(2 / 3, 5);
  });

  it("tolerates malformed jsonl lines and missing files", async () => {
    await mkdir(join(dir, "runs", "agent-a"), { recursive: true });
    const goodLine = indexLine({
      wakeId: "ok",
      agentId: "agent-a",
      outcome: "completed",
      startedAt: "2026-04-30T10:00:00Z",
      costMicros: 5,
    });
    const content = ["not json", "{}", goodLine, ""].join("\n") + "\n";
    await writeFile(join(dir, "runs", "agent-a", "index.jsonl"), content, "utf8");

    // Empty agent dir without index.jsonl — should be skipped.
    await mkdir(join(dir, "runs", "agent-b"), { recursive: true });

    const now = new Date("2026-05-04T10:00:00Z");
    const since = new Date("2026-04-04T10:00:00Z");
    const snapshot = await computeMetricsFromDisk({ rootDir: dir, since, now, windowDays: 30 });

    expect(snapshot.aggregate.totalWakes).toBe(1);
    expect(snapshot.perAgent).toHaveLength(1);
    expect(snapshot.perAgent[0]?.agentId).toBe("agent-a");
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FakeIndex {
  readonly wakeId: string;
  readonly agentId: string;
  readonly outcome: "completed" | "failed" | "timed-out" | "killed";
  readonly startedAt: string;
  readonly costMicros: number;
}

const indexLine = (f: FakeIndex): string =>
  JSON.stringify({
    schemaVersion: 1,
    wakeId: f.wakeId,
    agentId: f.agentId,
    outcome: f.outcome,
    startedAt: f.startedAt,
    finishedAt: f.startedAt,
    durationMs: 1000,
    modelTier: "balanced",
    llm: {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costMicros: f.costMicros,
      costUsdFormatted: "0.0000",
      shadowCostMicros: null,
      shadowCostUsdFormatted: null,
    },
    github: { restCalls: 0, graphqlCalls: 0, cacheHits: 0, rateLimitRemaining: null },
    totals: { costMicros: f.costMicros, apiCalls: 0 },
    digestPath: "x",
  });
