# ADR-0022 — Langfuse-powered agent self-reflection and continuous improvement

- **Status:** Proposed
- **Date:** 2026-04-16
- **Decision-maker(s):** Source (design), Engineering Circle (consent)
- **Related:** ADR-0020 (Vercel AI SDK / Langfuse observability), research spike at `docs/research/spike-langfuse-self-reflection.md`

## Context

The harness captures LLM observability data via Langfuse (ADR-0020 Phase 4), but this data currently flows in one direction: agents produce traces, Source reads dashboards. Agents have no visibility into their own performance — cost trends, token bloat, latency degradation, idle rates — and cannot propose improvements based on evidence.

Meanwhile, agents already have the machinery to propose governance changes (`GOVERNANCE_EVENT` in self-reflection) and the governance system has the machinery to process them (whatever plugin is configured). The missing piece is the data.

## Design principle: governance-agnostic

This ADR describes the data pipeline and interpretation layer. It does NOT prescribe how proposals are processed. The governance plugin — whatever model the murmuration uses — decides what happens after an agent files a `GOVERNANCE_EVENT`:

- **S3:** Consent round in the circle
- **Chain of Command:** Source reviews and directs
- **Meritocratic:** Expert-weighted evaluation
- **Consensus:** Unanimous agreement required
- **Parliamentary:** Majority vote

The harness provides the data. The governance plugin provides the process.

## Decision

### §1 — Enrich Langfuse traces with agent context

Tag every trace with `agentId`, `wakeId`, `groupIds`, and `wakeMode` so metrics can be queried per-agent, per-circle, and per-meeting.

Extend `ResolvedCallOptions` in the adapter layer:

```typescript
export type ResolvedCallOptions = {
  readonly signal?: AbortSignal;
  readonly costHook?: CostHook;
  readonly telemetryContext?: {
    readonly agentId: string;
    readonly wakeId: string;
    readonly groupIds: readonly string[];
    readonly wakeMode: string;
  };
};
```

Thread context from `AgentSpawnContext` → LLM client → Vercel adapter → `experimental_telemetry.metadata`.

### §2 — Add `langfuse-metrics` signal source

A new signal source that queries the Langfuse API at wake time and injects the agent's recent performance data into its signal bundle as a `custom` signal with `sourceId: "langfuse-metrics"`.

Metrics included:

| Metric            | What it measures                    |
| ----------------- | ----------------------------------- |
| `wakeCount`       | Number of wakes in the period       |
| `avgCostPerWake`  | Average USD cost per wake           |
| `totalCost`       | Total USD cost for the period       |
| `avgInputTokens`  | Average input tokens per wake       |
| `avgOutputTokens` | Average output tokens per wake      |
| `avgLatencyMs`    | Average wall-clock latency          |
| `p95LatencyMs`    | 95th percentile latency             |
| `costTrend`       | % change vs prior period            |
| `tokenTrend`      | % change vs prior period            |
| `errorRate`       | Failed traces / total traces        |
| `anomalies`       | Human-readable anomaly descriptions |

The signal is opt-in: only collected when `LANGFUSE_SECRET_KEY` and `LANGFUSE_PUBLIC_KEY` are set and the agent's role.md declares `langfuse-metrics` in its signal sources.

### §3 — Anomaly detection heuristics

Simple, deterministic rules (no ML):

- Cost per wake > 2x the 30-day average → "Cost spike"
- Input tokens trending up > 20% week-over-week → "Possible prompt bloat"
- Error rate > 10% → "Reliability concern"
- Latency P95 > 2x P50 → "Latency tail"
- Zero artifacts for 3+ consecutive wakes → "Idle agent"

Anomalies are included in the signal as human-readable strings. The agent interprets them using the self-reflection skill (§4).

### §4 — Self-reflection skill (SKILL.md)

A portable AgentSkills.io skill that teaches agents how to interpret their Langfuse metrics and formulate governance proposals:

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

The skill instructs agents to:

1. Read the `langfuse-metrics` signal from their signal bundle
2. Identify patterns (cost trends, token bloat, idle rate, latency)
3. Classify severity (informational vs actionable)
4. Formulate a `GOVERNANCE_EVENT` with specific numbers and a concrete recommendation
5. Let the governance system handle the proposal — the agent does not self-modify

### §5 — Circle-level retrospective integration

Extend `RetrospectiveMetrics` with Langfuse-sourced data:

```typescript
export interface RetrospectiveMetrics {
  readonly agentMetrics: readonly AgentMetricsSnapshot[];
  readonly period: string;
  readonly alignment?: AlignmentAssessment;
  // New: Langfuse-sourced performance data per agent
  readonly langfuseMetrics?: readonly AgentLangfuseMetrics[];
  // New: Circle-level aggregates
  readonly circleTotals?: {
    readonly totalCost: number;
    readonly avgCostPerWake: number;
    readonly costTrend: number;
    readonly anomalies: readonly string[];
  };
}
```

The facilitator sees per-agent and circle-level data when generating the retrospective agenda. This gives retrospective meetings concrete numbers instead of subjective assessments.

## Implementation sequence

| Phase | What                                     | Effort | Depends on |
| ----- | ---------------------------------------- | ------ | ---------- |
| **1** | Rich trace metadata (§1)                 | Small  | Nothing    |
| **2** | Self-reflection skill (§4)               | Small  | Nothing    |
| **3** | Langfuse metrics signal source (§2 + §3) | Medium | Phase 1    |
| **4** | Circle retrospective integration (§5)    | Medium | Phase 3    |

Phases 1 and 2 can ship independently. Phase 3 is the core integration. Phase 4 builds on it.

## Consequences

### Positive

- Agents gain evidence-based self-awareness — cost, tokens, latency, trends
- Governance proposals are backed by data, not subjective assessment
- Source makes decisions (model selection, schedule changes, prompt reviews) based on evidence
- Circles discuss performance in retrospectives with real numbers
- The murmuration self-tunes through its governance system over time
- Works with any governance model — the pipeline is model-agnostic

### Negative

- Adds Langfuse API calls at wake time (one per agent per wake)
- Requires Langfuse to be running for self-reflection to work (graceful degradation when absent)
- Anomaly heuristics are simple — may produce false positives initially
- Cold start: new murmurations need ~7 days of data before trends are meaningful

### Neutral

- Langfuse remains optional — everything works without it, just without self-reflection data
- The governance plugin determines what happens with proposals — the harness is agnostic
- Existing self-reflection (`EFFECTIVENESS: high/medium/low`) continues to work alongside Langfuse metrics

## Alternatives considered

- **Use only the harness's built-in WakeCostRecord** — Rejected: cost records are per-wake snapshots, not trend data. No latency, no token breakdown by model, no anomaly detection.
- **Build custom metrics storage** — Rejected: Langfuse already stores everything we need. Building our own would duplicate effort and miss the dashboard, API, and community ecosystem.
- **Let agents self-modify based on metrics** — Rejected: bypasses governance. The safety guarantee is that all changes go through the governance system, where a human or structured process evaluates them.
