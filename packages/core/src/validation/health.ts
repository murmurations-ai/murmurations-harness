/**
 * Wake health metrics — Proposal 07 Phase 0 (types only, no wiring).
 *
 * `WakeHealthMetrics` is derived from `AgentResult` + `WakeValidationResult`
 * at the end of each wake (Phase 5). It feeds into:
 *   - `AgentStateStore` for rolling health tracking across wakes
 *   - `RunLedgerEntry` for per-wake observability
 *   - `SignalBundle.health` so agents see their own health trend
 *   - Langfuse trace metadata for external dashboards
 *
 * `LangfuseMetricsSignal` carries the read-back from Langfuse into
 * the agent's signal bundle (Phase 5 `LangfuseMetricsSource`).
 */

import type { AgentId } from "../execution/index.js";

/** Rolling health summary for one wake. Derived by the harness from
 *  `AgentResult` + `WakeValidationResult` after every wake completes. */
export interface WakeHealthMetrics {
  /** Total tool invocations this wake (all outcomes). */
  readonly toolCalls: number;
  /** Tool invocations with `mutability === "mutating"`. */
  readonly mutatingToolCalls: number;
  /** Tool invocations that ended in `failure` or `timeout`. */
  readonly toolFailures: number;
  /** `toolFailures / toolCalls`; 0 when `toolCalls === 0`. */
  readonly toolErrorDensity: number;
  /** Number of action items assigned to this agent at wake-start. */
  readonly actionItemsAssigned: number;
  /** Number of assigned action items addressed with a successful receipt. */
  readonly actionItemsAddressed: number;
  /** Verification steps required by the execution contract. */
  readonly verificationStepsRequired: number;
  /** Verification steps that passed. */
  readonly verificationStepsPassed: number;
  /** `true` when the wake produced zero artifacts (no actions, no outputs,
   *  no governance events). Feeds into the idle-wake streak counter. */
  readonly idleWake: boolean;
  /** Agent's self-reported effectiveness from the EFFECTIVENESS: line in
   *  the wake digest. Optional — absent when the wake failed before the
   *  reflection block was written. */
  readonly selfReportedEffectiveness?: "high" | "medium" | "low";
  /** Cost per artifact (actions + outputs) in USD micros. Absent when
   *  `artifactCount === 0` (avoids division-by-zero sentinel values). */
  readonly costPerArtifactMicros?: number;
  /** `true` when the LLM trace shows the agent referenced its MEMORY.md
   *  segment during the wake. Phase 5/6: tracks the 13.1% memory-recall
   *  failure mode from the "Beyond Task Completion" evaluation study. */
  readonly memorySegmentReferenced?: boolean;
}

/** Metrics read back from Langfuse and injected into the agent's
 *  `SignalBundle` as a self-reflection signal (Phase 5). */
export interface LangfuseMetricsSignal {
  readonly agentId: AgentId;
  /** Number of days covered by the rolling window. */
  readonly windowDays: number;
  /** Named metrics from the Langfuse query (e.g. `avg_cost_micros`,
   *  `productive_rate`, `idle_rate`). Keyed by metric name. */
  readonly metrics: Readonly<Record<string, number>>;
}
