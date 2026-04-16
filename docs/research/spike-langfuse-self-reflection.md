# Architecture Spike: Langfuse-Powered Agent Self-Reflection

**Date:** 2026-04-16
**Author:** Engineering Circle
**Status:** Research spike — not yet an ADR

## Vision

A self-improving murmuration where agents observe their own performance data, identify patterns, and propose governance changes through the existing S3 consent process. Langfuse closes the feedback loop: agents don't just produce output — they learn from how they produce it.

```
Agent wake → LLM call → Langfuse trace
                              ↓
           Langfuse API → metrics signal → agent's next wake
                              ↓
           Agent reflects → files TENSION or PROPOSAL
                              ↓
           Circle governance meeting → consent → improved operations
```

## What agents would see

Today, an agent's self-reflection is limited to a single line: `EFFECTIVENESS: high/medium/low` + one observation sentence. With Langfuse data flowing back as signals, agents would see their own operational reality:

```
## Performance Metrics (last 7 days)

- Wakes: 7 | Artifacts: 6 | Idle: 1 (14%)
- Avg cost: $0.013/wake | Trend: +18% vs prior week
- Avg input tokens: 8,200 | Trend: +35% (possible prompt bloat)
- Avg latency: 23.5s | P95: 41s
- Tool calls: 0 (no MCP tools configured)
- Consecutive failures: 0
- Model: gemini-2.5-flash

## Anomalies

- Input token count has increased 35% this week without a corresponding
  increase in artifact quality. Possible causes: signal bundle growth,
  identity doc expansion, or prompt bloat.
- Wake on 2026-04-14 cost $0.031 (2.4x average) — unusually long output.
```

An agent seeing this might file: `TENSION: My input token count has grown 35% this week. I propose reviewing my system prompt for unnecessary content to reduce cost without losing effectiveness.`

## Architecture: Three integration layers

### Layer 1: Rich trace metadata (write path)

**What:** Tag every Langfuse trace with agent ID, wake ID, circle memberships, meeting type, and wake mode so we can query per-agent and per-circle.

**How:** Extend `ResolvedCallOptions` and `experimental_telemetry` in the Vercel adapter:

```typescript
// packages/llm/src/adapters/adapter.ts
export type ResolvedCallOptions = {
  readonly signal?: AbortSignal;
  readonly costHook?: CostHook;
  readonly telemetryContext?: {
    readonly agentId: string;
    readonly wakeId: string;
    readonly groupIds: readonly string[];
    readonly wakeMode: string; // "individual" | "meeting-member" | "meeting-facilitator"
  };
};

// packages/llm/src/adapters/vercel-adapter.ts
experimental_telemetry: {
  isEnabled: true,
  functionId: `${this.providerId}/${this.modelUsed}`,
  metadata: {
    agentId: options.telemetryContext?.agentId ?? "unknown",
    wakeId: options.telemetryContext?.wakeId ?? "unknown",
    groupIds: options.telemetryContext?.groupIds?.join(",") ?? "",
    wakeMode: options.telemetryContext?.wakeMode ?? "individual",
  },
},
```

**Effort:** Small — threading context from spawn → client → adapter.

### Layer 2: Langfuse metrics as a signal source (read path)

**What:** A new signal source (`langfuse-metrics`) that queries the Langfuse API at wake time and injects the agent's recent performance data into its signal bundle.

**How:** New module in `packages/signals/` or a standalone package:

```typescript
// packages/signals/src/langfuse-source.ts
import { LangfuseClient } from "@langfuse/client";

export interface LangfuseMetricsSignal {
  readonly kind: "custom";
  readonly sourceId: "langfuse-metrics";
  readonly data: {
    readonly period: string;              // "last 7 days"
    readonly wakeCount: number;
    readonly avgCostPerWake: number;       // USD
    readonly totalCost: number;
    readonly avgInputTokens: number;
    readonly avgOutputTokens: number;
    readonly avgLatencyMs: number;
    readonly p95LatencyMs: number;
    readonly costTrend: number;            // % change vs prior period
    readonly tokenTrend: number;           // % change vs prior period
    readonly errorRate: number;            // failed traces / total
    readonly anomalies: string[];          // human-readable anomaly descriptions
  };
}

export async function collectLangfuseMetrics(
  agentId: string,
  periodDays: number = 7,
): Promise<LangfuseMetricsSignal | null> {
  const client = new LangfuseClient({ ... });

  // Current period
  const current = await client.metrics({
    view: "traces",
    metrics: [
      { measure: "totalCost", aggregation: "sum" },
      { measure: "totalCost", aggregation: "avg" },
      { measure: "inputTokens", aggregation: "avg" },
      { measure: "outputTokens", aggregation: "avg" },
      { measure: "latency", aggregation: "avg" },
      { measure: "latency", aggregation: "p95" },
      { measure: "count", aggregation: "count" },
    ],
    filters: [
      { field: "metadata.agentId", value: agentId, operator: "eq" },
      { field: "startTime", value: daysAgo(periodDays), operator: "gte" },
    ],
  });

  // Prior period (for trend comparison)
  const prior = await client.metrics({
    // same metrics, shifted back by periodDays
  });

  // Compute trends and anomalies
  const costTrend = percentChange(prior.avgCost, current.avgCost);
  const tokenTrend = percentChange(prior.avgInputTokens, current.avgInputTokens);

  const anomalies = detectAnomalies(current, prior);

  return {
    kind: "custom",
    sourceId: "langfuse-metrics",
    data: { ... },
  };
}
```

**Anomaly detection** (simple heuristics, no ML needed):

- Cost per wake > 2x the 30-day average → "Cost spike"
- Input tokens trending up > 20% week-over-week → "Possible prompt bloat"
- Error rate > 10% → "Reliability concern"
- Latency P95 > 2x P50 → "Latency tail"
- Zero artifacts for 3+ consecutive wakes → "Idle agent"

**Effort:** Medium — new signal source + Langfuse client integration.

### Layer 3: Self-reflection skill (interpretation path)

**What:** A `SKILL.md` that teaches agents how to interpret their Langfuse metrics and formulate governance proposals.

```yaml
# skills/self-reflection/SKILL.md
---
name: self-reflection
description: >
  Interpret your own Langfuse performance metrics and propose governance
  changes when patterns indicate improvement opportunities. Use when you
  see a langfuse-metrics signal in your signal bundle.
---
```

The skill would instruct agents:

1. **Read the metrics signal** — look for `[langfuse-metrics]` in your signal bundle
2. **Identify patterns** — compare current vs prior period trends
3. **Classify the pattern**:
   - Cost increasing without quality improvement → propose model tier change or prompt review
   - Token count growing → propose identity doc review (prompt bloat)
   - Idle rate > 25% → propose wake schedule change
   - Error rate > 10% → propose debugging session
   - Latency degrading → propose model switch or tool optimization
4. **Formulate governance** — file a `TENSION:` or `PROPOSAL:` with specific numbers and a concrete recommendation

**Effort:** Small — just a SKILL.md file, no code.

## Circle-level reflection

Beyond individual agents, circles can use aggregated Langfuse data in retrospective meetings:

```
## Circle Performance (Engineering Circle, last 2 weeks)

| Agent | Wakes | Artifacts | Cost | Idle% | Trend |
|-------|-------|-----------|------|-------|-------|
| #22 Lead | 14 | 12 | $0.15 | 14% | stable |
| #23 Arch | 14 | 10 | $0.19 | 29% | ↑ cost |
| #24 TS | 14 | 13 | $0.14 | 7% | stable |
| #25 Sec | 14 | 11 | $0.16 | 21% | stable |
| #26 DevOps | 14 | 14 | $0.12 | 0% | stable |
| #27 Perf | 14 | 9 | $0.18 | 36% | ↑ idle |
| #28 QE | 14 | 13 | $0.15 | 7% | stable |
| TOTAL | 98 | 82 | $1.09 | 16% | |

## Circle-level anomalies
- #27 Performance has 36% idle rate — may need sharper wake prompt or more focused signals
- #23 Architecture cost trending up — reviewing longer contributions in meetings
```

This data feeds into `RetrospectiveMetrics` (already exists in `packages/core/src/groups/`) and gives the facilitator concrete data for the retrospective meeting.

## Implementation sequence

| Phase | What                                     | Effort | Depends on                  |
| ----- | ---------------------------------------- | ------ | --------------------------- |
| **1** | Rich trace metadata (Layer 1)            | Small  | Nothing                     |
| **2** | Self-reflection skill (Layer 3)          | Small  | Nothing                     |
| **3** | Langfuse metrics signal source (Layer 2) | Medium | Phase 1 (for tagged traces) |
| **4** | Circle retrospective integration         | Medium | Phase 3                     |
| **5** | Anomaly detection heuristics             | Small  | Phase 3                     |

Phases 1 and 2 can ship independently. Phase 3 is the core integration. Phases 4-5 build on it.

## What this enables

**Short term (Phases 1-3):**

- Agents see their own cost, token, and latency trends
- Agents propose governance changes based on data, not vibes
- Source has evidence-based decisions for model selection, schedule changes, prompt reviews

**Medium term (Phase 4-5):**

- Circles discuss performance in retrospectives with real numbers
- Facilitators propose agenda items based on anomaly detection
- "The murmuration spent $4.20 this week, up 15% from last week — #23 Architecture and #06 Analytics are the primary drivers"

**Long term:**

- Agents learn which prompt patterns produce the best artifact-to-cost ratio
- Circles evolve their own meeting cadence based on measured throughput
- The murmuration self-tunes: wake schedules, model tiers, token budgets, and tool configurations all adapt through governance rather than manual tuning

## Dependencies

- `@langfuse/client` npm package (for API queries)
- `LANGFUSE_SECRET_KEY` / `LANGFUSE_PUBLIC_KEY` must be set (same as current observability)
- Langfuse must have accumulated at least 7 days of traces for trends to be meaningful

## Risks

1. **API rate limits** — Langfuse API has rate limits. Querying 28 agents at wake time = 28 API calls. Mitigate: cache metrics per wake cycle, not per agent.
2. **Cold start** — New murmurations have no historical data. The signal source should gracefully return empty when insufficient data exists.
3. **Circular feedback** — An agent that sees "high cost" might produce shorter output, which tanks quality, which triggers "low effectiveness," which triggers more prompt changes. Mitigate: the skill should emphasize proposing changes through governance (human consent), not self-modifying.
4. **Privacy** — Langfuse data includes full prompts. The metrics signal should only include aggregated numbers, not prompt content.
