/**
 * Synthetic-corpus acceptance fixture — Workstream L.
 *
 * This test stands up a complete synthetic murmuration on disk and
 * exercises every v0.7.0 metrics surface against it:
 *
 *   1. `computeMetricsFromDisk` (used by `murmuration metrics` CLI + dashboard panel)
 *   2. Spirit tools (`get_facilitator_log`, `get_agreement`, `list_awaiting_source_close`, `close_issue`)
 *
 * Numbers are pinned: if the fixture changes, the assertions break.
 * That's the point — this is the harness's tag-blocking gate, so the
 * v0.7.0 release does not depend on any operator's repo state.
 *
 * @see docs/specs/0001-agent-effectiveness.md §5 Workstream F (acceptance criteria)
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { computeMetricsFromDisk } from "@murmurations-ai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildSpiritTools } from "./spirit/tools.js";

interface SocketResponse {
  readonly id: string;
  readonly result?: unknown;
  readonly error?: string;
}

const noopSend = (_method: string, _params?: Record<string, unknown>): Promise<SocketResponse> =>
  Promise.resolve({ id: "0", result: null });

let root = "";
const NOW = new Date("2026-05-04T12:00:00Z");
const SINCE = new Date("2026-04-04T12:00:00Z");

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), `synthetic-corpus-${randomUUID().slice(0, 8)}-`));
  buildFixture(root);
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("synthetic-corpus fixture — disk metrics surface", () => {
  it("computes the expected aggregate snapshot", async () => {
    const snap = await computeMetricsFromDisk({
      rootDir: root,
      since: SINCE,
      now: NOW,
      windowDays: 30,
    });

    // 3 agents × 4 wakes each = 12 wakes; 3 of every 4 completed = 9 completed.
    expect(snap.aggregate.totalWakes).toBe(12);
    expect(snap.aggregate.completedWakes).toBe(9);
    expect(snap.aggregate.completionRate).toBeCloseTo(0.75, 5);

    // Cost: each wake is 1000 micros; 12 wakes = 12_000 micros = $0.012.
    expect(snap.aggregate.totalCostMicros).toBe(12_000);
  });

  it("partitions per-agent stats correctly", async () => {
    const snap = await computeMetricsFromDisk({
      rootDir: root,
      since: SINCE,
      now: NOW,
      windowDays: 30,
    });

    expect(snap.perAgent).toHaveLength(3);
    for (const a of snap.perAgent) {
      expect(a.totalWakes).toBe(4);
      expect(a.completedWakes).toBe(3);
      expect(a.totalCostMicros).toBe(4_000);
      expect(a.completionRate).toBeCloseTo(0.75, 5);
    }
    // Stable order, alphabetical.
    expect(snap.perAgent.map((a) => a.agentId)).toEqual([
      "facilitator-agent",
      "research-agent",
      "writing-agent",
    ]);
  });

  it("rolls up accountability observations into met-rates", async () => {
    const snap = await computeMetricsFromDisk({
      rootDir: root,
      since: SINCE,
      now: NOW,
      windowDays: 30,
    });

    expect(snap.accountabilityMetRates).toHaveLength(2);
    const byId = new Map(snap.accountabilityMetRates.map((r) => [r.accountabilityId, r]));

    const weeklyDigest = byId.get("weekly-digest");
    expect(weeklyDigest).toBeDefined();
    expect(weeklyDigest?.observations).toBe(4);
    expect(weeklyDigest?.metCount).toBe(3);
    expect(weeklyDigest?.rate).toBeCloseTo(0.75, 5);

    const facilitatorLog = byId.get("facilitator-log");
    expect(facilitatorLog).toBeDefined();
    expect(facilitatorLog?.observations).toBe(4);
    expect(facilitatorLog?.metCount).toBe(4);
    expect(facilitatorLog?.rate).toBe(1);
  });
});

describe("synthetic-corpus fixture — Spirit tools (K3)", () => {
  const tools = (): ReturnType<typeof buildSpiritTools> =>
    buildSpiritTools({ rootDir: root, send: noopSend });

  it("get_facilitator_log returns the latest digest body", async () => {
    const tool = tools().find((t) => t.name === "get_facilitator_log");
    const out = (await tool!.execute({})) as string;
    expect(out).toContain("Facilitator Log");
    expect(out).toContain("Awaiting Source close");
    expect(out).toContain("#42");
  });

  it("get_agreement returns the consented proposal as JSON", async () => {
    const tool = tools().find((t) => t.name === "get_agreement");
    const out = (await tool!.execute({ id: "proposal-2026-05-04-priorities" })) as string;
    expect(out).toContain("proposal-2026-05-04-priorities");
    expect(out).toContain('"currentState": "consented"');
  });

  it("list_awaiting_source_close extracts the awaiting-source section", async () => {
    const tool = tools().find((t) => t.name === "list_awaiting_source_close");
    const out = (await tool!.execute({})) as string;
    expect(out).toContain("#42");
    expect(out).toContain("#43");
    // The section after Awaiting Source close must NOT leak into the result.
    expect(out).not.toContain("Notes for next wake");
  });

  it("close_issue returns a runnable gh command", async () => {
    const tool = tools().find((t) => t.name === "close_issue");
    const out = (await tool!.execute({
      number: 42,
      reason: "Decided in proposal-2026-05-04-priorities.",
      repo: "synthetic/corpus",
    })) as string;
    expect(out).toContain("gh issue close 42 --repo synthetic/corpus");
    expect(out).toContain("Decided in proposal-2026-05-04-priorities.");
  });
});

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

const buildFixture = (rootDir: string): void => {
  // 3 agents × 4 wakes each, 3 completed and 1 failed per agent.
  for (const agentId of ["facilitator-agent", "research-agent", "writing-agent"]) {
    const dir = join(rootDir, "runs", agentId);
    mkdirSync(dir, { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < 4; i++) {
      const startedAt = new Date("2026-04-30T10:00:00Z");
      startedAt.setUTCHours(startedAt.getUTCHours() + i);
      const outcome: "completed" | "failed" = i < 3 ? "completed" : "failed";
      lines.push(makeIndexLine(agentId, `${agentId}-${String(i)}`, outcome, startedAt, 1000));
    }
    writeFileSync(join(dir, "index.jsonl"), lines.join("\n") + "\n", "utf8");
  }

  // Accountability observations: weekly-digest (3/4 met), facilitator-log (4/4 met).
  const obsDir = join(rootDir, ".murmuration");
  mkdirSync(obsDir, { recursive: true });
  const obsLines: string[] = [];
  for (let i = 0; i < 4; i++) {
    const t = new Date("2026-04-30T10:00:00Z");
    t.setUTCHours(t.getUTCHours() + i);
    obsLines.push(
      JSON.stringify({
        accountabilityId: "weekly-digest",
        agentId: "writing-agent",
        observedAt: t.toISOString(),
        met: i !== 2, // miss one observation
      }),
    );
    obsLines.push(
      JSON.stringify({
        accountabilityId: "facilitator-log",
        agentId: "facilitator-agent",
        observedAt: t.toISOString(),
        met: true,
      }),
    );
  }
  writeFileSync(
    join(obsDir, "accountability-observations.jsonl"),
    obsLines.join("\n") + "\n",
    "utf8",
  );

  // Governance: one consented proposal.
  const govDir = join(rootDir, ".murmuration", "governance");
  mkdirSync(govDir, { recursive: true });
  const item = {
    id: "proposal-2026-05-04-priorities",
    kind: "proposal",
    currentState: "consented",
    createdBy: { kind: "agent-id", value: "facilitator-agent" },
    createdAt: "2026-05-04T09:00:00Z",
    reviewAt: null,
    history: [
      {
        from: "draft",
        to: "in-review",
        triggeredBy: "facilitator-agent",
        at: "2026-05-04T09:30:00Z",
      },
      { from: "in-review", to: "consented", triggeredBy: "system", at: "2026-05-04T11:00:00Z" },
    ],
  };
  writeFileSync(join(govDir, "items.jsonl"), JSON.stringify(item) + "\n", "utf8");

  // Facilitator digest with an Awaiting Source close section.
  const facDir = join(rootDir, "runs", "facilitator-agent", "2026-05-04");
  mkdirSync(facDir, { recursive: true });
  const digest = `---
wake_id: ${randomUUID()}
agent_id: facilitator-agent
outcome: completed
---

# Facilitator Log

## Closed today

- #100 closed by facilitator (DIRECTIVE in terminal state)

## Awaiting Source close

- #42 — escalated, second verification failure
- #43 — DIRECTIVE in terminal state

## Notes for next wake

- Continue surveillance of pricing thread
`;
  writeFileSync(join(facDir, "digest-2026-05-04T11-00-00Z-aaaa.md"), digest, "utf8");
};

const makeIndexLine = (
  agentId: string,
  wakeId: string,
  outcome: "completed" | "failed" | "timed-out" | "killed",
  startedAt: Date,
  costMicros: number,
): string =>
  JSON.stringify({
    schemaVersion: 1,
    wakeId,
    agentId,
    outcome,
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    durationMs: 1000,
    modelTier: "balanced",
    llm: {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costMicros,
      costUsdFormatted: "0.0010",
      shadowCostMicros: null,
      shadowCostUsdFormatted: null,
    },
    github: { restCalls: 0, graphqlCalls: 0, cacheHits: 0, rateLimitRemaining: null },
    totals: { costMicros, apiCalls: 0 },
    digestPath: `2026-04-30/digest-${wakeId}.md`,
  });
