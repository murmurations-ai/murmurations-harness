/**
 * Spirit reporting surfaces tests — Workstream Q.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildAttentionQueue,
  buildReport,
  fetchMetrics,
  renderAttentionMarkdown,
  renderMetricsMarkdown,
} from "./reports.js";

interface SocketResponse {
  readonly id: string;
  readonly result?: unknown;
  readonly error?: string;
}

const noopSend = (_method: string, _params?: Record<string, unknown>): Promise<SocketResponse> =>
  Promise.resolve({ id: "0", error: "no daemon" });

const fakeSend = (
  responses: Record<string, unknown>,
): ((m: string, p?: Record<string, unknown>) => Promise<SocketResponse>) => {
  return (method: string) => {
    if (method in responses) return Promise.resolve({ id: "0", result: responses[method] });
    return Promise.resolve({ id: "0", error: "method not handled" });
  };
};

describe("fetchMetrics + renderMetricsMarkdown (Workstream Q)", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "spirit-reports-metrics-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns an empty-state snapshot when no runs exist", async () => {
    const m = await fetchMetrics(root, 30);
    expect(m.aggregate.totalWakes).toBe(0);
    expect(renderMetricsMarkdown(m)).toContain("No wake records yet");
  });

  it("renders aggregate + accountability rows when data exists", async () => {
    // Synthetic wake record
    mkdirSync(join(root, "runs", "agent-a"), { recursive: true });
    writeFileSync(
      join(root, "runs", "agent-a", "index.jsonl"),
      JSON.stringify({
        schemaVersion: 1,
        wakeId: "w1",
        agentId: "agent-a",
        outcome: "completed",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 1000,
        modelTier: "balanced",
        llm: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costMicros: 5000,
          costUsdFormatted: "0.0050",
          shadowCostMicros: null,
          shadowCostUsdFormatted: null,
        },
        github: { restCalls: 0, graphqlCalls: 0, cacheHits: 0, rateLimitRemaining: null },
        totals: { costMicros: 5000, apiCalls: 0 },
        digestPath: "x",
      }) + "\n",
      "utf8",
    );
    // Accountability observation
    mkdirSync(join(root, ".murmuration"), { recursive: true });
    writeFileSync(
      join(root, ".murmuration", "accountability-observations.jsonl"),
      JSON.stringify({
        accountabilityId: "weekly-digest",
        agentId: "agent-a",
        observedAt: new Date().toISOString(),
        met: true,
      }) + "\n",
      "utf8",
    );

    const m = await fetchMetrics(root, 30);
    const md = renderMetricsMarkdown(m);
    expect(md).toContain("Wakes:** 1");
    expect(md).toContain("weekly-digest");
  });
});

describe("buildAttentionQueue (Workstream Q)", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "spirit-reports-attn-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns an empty queue with no failures and no awaiting items", async () => {
    const items = await buildAttentionQueue({ rootDir: root, send: noopSend });
    expect(items).toEqual([]);
  });

  it("flags failing agents from agents.list", async () => {
    const send = fakeSend({
      "agents.list": [
        { agentId: "alpha", consecutiveFailures: 0 },
        { agentId: "beta", consecutiveFailures: 3 },
      ],
    });
    const items = await buildAttentionQueue({ rootDir: root, send });
    expect(items).toHaveLength(1);
    expect(items[0]?.subject).toBe("beta");
    expect(items[0]?.kind).toBe("failing-agent");
  });

  it("flags low-met-rate accountabilities", async () => {
    mkdirSync(join(root, ".murmuration"), { recursive: true });
    const obs = [
      { accountabilityId: "weekly", agentId: "x", observedAt: "2026-04-30T10:00:00Z", met: false },
      { accountabilityId: "weekly", agentId: "x", observedAt: "2026-05-01T10:00:00Z", met: false },
      { accountabilityId: "weekly", agentId: "x", observedAt: "2026-05-02T10:00:00Z", met: true },
    ]
      .map((o) => JSON.stringify(o))
      .join("\n");
    writeFileSync(
      join(root, ".murmuration", "accountability-observations.jsonl"),
      obs + "\n",
      "utf8",
    );

    const items = await buildAttentionQueue({
      rootDir: root,
      send: noopSend,
      sinceDays: 30,
      metRateThreshold: 0.6,
    });
    const hits = items.filter((i) => i.kind === "low-met-rate");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.subject).toBe("weekly");
  });

  it("extracts awaiting-source-close items from the latest facilitator digest", async () => {
    const facDir = join(root, "runs", "facilitator-agent", "2026-05-04");
    mkdirSync(facDir, { recursive: true });
    writeFileSync(
      join(facDir, "digest-2026-05-04T11-00-00Z-aaaa.md"),
      `# Log\n\n## Awaiting Source close\n\n- #42 — escalated, second verification failure\n- #43 — DIRECTIVE in terminal state\n\n## Notes\n`,
      "utf8",
    );
    const items = await buildAttentionQueue({ rootDir: root, send: noopSend });
    const awaiting = items.filter((i) => i.kind === "awaiting-close");
    expect(awaiting).toHaveLength(2);
    expect(awaiting.map((a) => a.subject).sort()).toEqual(["#42", "#43"]);
  });

  it("mixes all three categories when present and ranks awaiting-close last", async () => {
    mkdirSync(join(root, ".murmuration"), { recursive: true });
    writeFileSync(
      join(root, ".murmuration", "accountability-observations.jsonl"),
      [
        { accountabilityId: "x", agentId: "a", observedAt: "2026-05-01T10:00:00Z", met: false },
        { accountabilityId: "x", agentId: "a", observedAt: "2026-05-02T10:00:00Z", met: true },
        { accountabilityId: "x", agentId: "a", observedAt: "2026-05-03T10:00:00Z", met: false },
      ]
        .map((o) => JSON.stringify(o))
        .join("\n") + "\n",
      "utf8",
    );

    const facDir = join(root, "runs", "facilitator-agent", "2026-05-04");
    mkdirSync(facDir, { recursive: true });
    writeFileSync(
      join(facDir, "digest-2026-05-04T11-00-00Z-aaaa.md"),
      `## Awaiting Source close\n- #1 — note\n`,
      "utf8",
    );

    const items = await buildAttentionQueue({
      rootDir: root,
      send: fakeSend({ "agents.list": [{ agentId: "z", consecutiveFailures: 5 }] }),
    });
    const kinds = new Set(items.map((i) => i.kind));
    expect(kinds.has("failing-agent")).toBe(true);
    expect(kinds.has("low-met-rate")).toBe(true);
    expect(kinds.has("awaiting-close")).toBe(true);
    // Awaiting-close is the lowest-priority bucket, so it lands last.
    expect(items[items.length - 1]?.kind).toBe("awaiting-close");
  });
});

describe("renderAttentionMarkdown (Workstream Q)", () => {
  it("renders an empty queue with a friendly note", () => {
    const out = renderAttentionMarkdown([]);
    expect(out).toContain("nothing flagged");
  });

  it("formats each item with a kind tag", () => {
    const out = renderAttentionMarkdown([
      { kind: "failing-agent", subject: "x", note: "2 failures", score: 110 },
      { kind: "low-met-rate", subject: "weekly", note: "30%", score: 90 },
      { kind: "awaiting-close", subject: "#1", note: "note", score: 60 },
    ]);
    expect(out).toContain("⚠️ failing");
    expect(out).toContain("📉 met-rate");
    expect(out).toContain("🔒 awaiting close");
  });
});

describe("buildReport (Workstream Q)", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "spirit-reports-build-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("scope=all returns metrics + activity + attention sections", async () => {
    const out = await buildReport({ rootDir: root, send: noopSend, scope: "all" });
    expect(out).toContain("# Murmuration report");
    expect(out).toContain("## Metrics");
    expect(out).toContain("## Recent activity");
    expect(out).toContain("## Source attention queue");
  });

  it("scope=health returns only the metrics section", async () => {
    const out = await buildReport({ rootDir: root, send: noopSend, scope: "health" });
    expect(out).toContain("## Metrics");
    expect(out).not.toContain("## Recent activity");
    expect(out).not.toContain("attention queue");
  });

  it("scope=activity uses daemon events when available", async () => {
    const send = fakeSend({
      "events.history": [
        {
          date: "2026-05-04",
          groupId: "research",
          kind: "operational",
          status: "completed",
          minutesUrl: "https://example.com/minutes",
        },
      ],
    });
    const out = await buildReport({ rootDir: root, send, scope: "activity" });
    expect(out).toContain("research");
    expect(out).toContain("operational");
  });
});
