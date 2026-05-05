/**
 * Spirit meta-agent acceptance fixture — Workstream S.
 *
 * Tag-blocking gate: stands up a complete synthetic murmuration on
 * disk and exercises every Spirit-meta-agent surface (N–R) against it.
 * Numbers + content are pinned. If any spec-0002 component drifts, this
 * test catches it.
 *
 * Coverage matrix:
 *   N — cross-attach context        (ConversationStore round-trip + sessionId)
 *   O — memory                      (remember + recall + index injection)
 *   P — describe_murmuration        (overview from synthetic harness.yaml)
 *   Q — reporting surfaces          (metrics + report + attention_queue)
 *   R — per-murmuration skills      (install + load_skill shadow)
 *
 * @see docs/specs/0002-spirit-meta-agent.md §5 Workstream S
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { ConversationStore } from "@murmurations-ai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SpiritMemory } from "./memory.js";
import { describeMurmuration } from "./overview.js";
import { buildAttentionQueue, buildReport, fetchMetrics } from "./reports.js";
import { SpiritSkillsOverlay } from "./skills.js";
import { buildSpiritSystemPrompt } from "./system-prompt.js";

interface SocketResponse {
  readonly id: string;
  readonly result?: unknown;
  readonly error?: string;
}

const noopSend = (_method: string, _params?: Record<string, unknown>): Promise<SocketResponse> =>
  Promise.resolve({ id: "0", error: "no daemon" });

let root = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), `spirit-meta-fixture-${randomUUID().slice(0, 8)}-`));
  buildFixture(root);
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// N — cross-attach conversation context
// ---------------------------------------------------------------------------

describe("Spirit meta-agent fixture — Workstream N (cross-attach context)", () => {
  it("survives detach + re-attach with sessionId preserved", async () => {
    const dir = join(root, ".murmuration", "spirit");

    // First attach: persist a turn.
    const a1 = new ConversationStore(dir);
    await a1.append({ role: "user", content: "what's the wake schedule?", ts: "t1" });
    await a1.append({
      role: "assistant",
      content: "Daily 07:00 + 18:00 UTC for the facilitator.",
      ts: "t2",
    });
    await a1.setSessionId("synthetic-cli-session");

    // Re-attach: fresh store at the same dir hydrates everything.
    const a2 = new ConversationStore(dir);
    expect(await a2.load()).toBe(true);
    expect(a2.messages.length).toBe(2);
    expect(a2.sessionId).toBe("synthetic-cli-session");
  });
});

// ---------------------------------------------------------------------------
// O — memory
// ---------------------------------------------------------------------------

describe("Spirit meta-agent fixture — Workstream O (memory)", () => {
  it("remember + recall round-trip", async () => {
    const mem = new SpiritMemory(root);
    await mem.remember({
      type: "user",
      name: "user_role",
      description: "Source operates in Pacific time",
      body: "Standup at 7am.",
    });
    const hits = await mem.recall("Pacific");
    expect(hits.map((h) => h.name)).toContain("user_role");
  });

  it("memory index appears in the system prompt", async () => {
    const prompt = await buildSpiritSystemPrompt(root);
    expect(prompt).toContain("## Saved memories");
    expect(prompt).toContain("user_role");
  });
});

// ---------------------------------------------------------------------------
// P — describe_murmuration
// ---------------------------------------------------------------------------

describe("Spirit meta-agent fixture — Workstream P (describe_murmuration)", () => {
  it("walks the synthetic murmuration and returns the expected shape", async () => {
    const { overview } = await describeMurmuration(root);
    expect(overview.governanceModel).toBe("sociocracy-3.0");
    expect(overview.llmProvider).toBe("subscription-cli");
    expect(overview.agents.map((a) => a.agentId).sort()).toEqual([
      "facilitator-agent",
      "research-agent",
      "writing-agent",
    ]);
    expect(overview.groups.map((g) => g.groupId).sort()).toEqual(["facilitation", "research"]);
  });

  it("renders a usable markdown summary", async () => {
    const { markdown } = await describeMurmuration(root);
    expect(markdown).toContain("# Murmuration overview");
    expect(markdown).toContain("**Governance:** sociocracy-3.0");
    expect(markdown).toContain("facilitator-agent");
  });
});

// ---------------------------------------------------------------------------
// Q — reporting surfaces
// ---------------------------------------------------------------------------

describe("Spirit meta-agent fixture — Workstream Q (reports)", () => {
  it("metrics returns the pinned aggregate from the synthetic runs", async () => {
    const m = await fetchMetrics(root, 30);
    expect(m.aggregate.totalWakes).toBe(12);
    expect(m.aggregate.completedWakes).toBe(9);
    expect(m.aggregate.completionRate).toBeCloseTo(0.75, 5);
  });

  it("attention_queue surfaces both low-met-rate and awaiting-close items", async () => {
    const items = await buildAttentionQueue({ rootDir: root, send: noopSend });
    const kinds = new Set(items.map((i) => i.kind));
    expect(kinds.has("low-met-rate")).toBe(true);
    expect(kinds.has("awaiting-close")).toBe(true);
    // Awaiting-close subjects come from the synthetic facilitator digest.
    const awaiting = items.filter((i) => i.kind === "awaiting-close").map((i) => i.subject);
    expect(awaiting).toContain("#42");
  });

  it("report(all) bundles every section", async () => {
    const out = await buildReport({ rootDir: root, send: noopSend, scope: "all" });
    expect(out).toContain("## Metrics");
    expect(out).toContain("## Recent activity");
    expect(out).toContain("## Source attention queue");
  });
});

// ---------------------------------------------------------------------------
// R — per-murmuration skill installation
// ---------------------------------------------------------------------------

describe("Spirit meta-agent fixture — Workstream R (skill overlay)", () => {
  it("install + read round-trip", async () => {
    const overlay = new SpiritSkillsOverlay(root);
    await overlay.install({
      name: "pricing-context",
      description: "Reference proposal-2026-05-04 for pricing questions",
      body: "Always cross-link the bundle decision.",
    });
    const body = await overlay.read("pricing-context");
    expect(body).toContain("bundle decision");

    const list = await overlay.list();
    expect(list).toContain("pricing-context");
  });

  it("system prompt advertises the operator-installed skills section", async () => {
    const prompt = await buildSpiritSystemPrompt(root);
    expect(prompt).toContain("## Operator-installed skills");
    expect(prompt).toContain("pricing-context");
  });
});

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

const buildFixture = (rootDir: string): void => {
  // murmuration/harness.yaml + soul.md
  const muDir = join(rootDir, "murmuration");
  mkdirSync(muDir, { recursive: true });
  writeFileSync(
    join(muDir, "harness.yaml"),
    `governance:
  model: sociocracy-3.0
  plugin: "@murmurations-ai/governance-s3"
llm:
  provider: subscription-cli
  model: claude-sonnet-4-6
`,
    "utf8",
  );
  writeFileSync(
    join(muDir, "soul.md"),
    "# Synthetic murmuration\n\nTest fixture for Spec 0002 acceptance gate.\n",
    "utf8",
  );

  // 3 agents × 4 wakes each (3 completed + 1 failed).
  for (const agentId of ["facilitator-agent", "research-agent", "writing-agent"]) {
    const agentDir = join(rootDir, "agents", agentId);
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "role.md"),
      `---
agent_id: ${agentId}
model_tier: balanced
wake_schedule:
  cron: "0 9 * * *"
group_memberships: [${agentId === "facilitator-agent" ? "facilitation" : "research"}]
---

# ${agentId}
`,
      "utf8",
    );

    const runsDir = join(rootDir, "runs", agentId);
    mkdirSync(runsDir, { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < 4; i++) {
      const startedAt = new Date("2026-04-30T10:00:00Z");
      startedAt.setUTCHours(startedAt.getUTCHours() + i);
      lines.push(
        JSON.stringify({
          schemaVersion: 1,
          wakeId: `${agentId}-${String(i)}`,
          agentId,
          outcome: i < 3 ? "completed" : "failed",
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
            costMicros: 1000,
            costUsdFormatted: "0.0010",
            shadowCostMicros: null,
            shadowCostUsdFormatted: null,
          },
          github: { restCalls: 0, graphqlCalls: 0, cacheHits: 0, rateLimitRemaining: null },
          totals: { costMicros: 1000, apiCalls: 0 },
          digestPath: "x",
        }),
      );
    }
    writeFileSync(join(runsDir, "index.jsonl"), lines.join("\n") + "\n", "utf8");
  }

  // Two governance groups with members.
  const groupsDir = join(rootDir, "governance", "groups");
  mkdirSync(groupsDir, { recursive: true });
  writeFileSync(
    join(groupsDir, "facilitation.md"),
    `# Facilitation
facilitator: facilitator-agent

## Members
- facilitator-agent
`,
    "utf8",
  );
  writeFileSync(
    join(groupsDir, "research.md"),
    `# Research Circle
facilitator: research-agent

## Members
- research-agent
- writing-agent
`,
    "utf8",
  );

  // Accountability observations: weekly 3/4 met (low), facilitator-log 4/4 met.
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
        // Make this LOW met-rate so attention-queue picks it up.
        met: i < 1,
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

  // Facilitator digest with awaiting-source-close section.
  const facDir = join(rootDir, "runs", "facilitator-agent", "2026-05-04");
  mkdirSync(facDir, { recursive: true });
  writeFileSync(
    join(facDir, "digest-2026-05-04T11-00-00Z-aaaa.md"),
    `# Facilitator Log

## Awaiting Source close

- #42 — escalated, second verification failure
- #43 — DIRECTIVE in terminal state

## Notes
`,
    "utf8",
  );
};
