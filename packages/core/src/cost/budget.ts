/**
 * Budget ceilings and gate evaluation — the enforcement half of Phase 1B
 * step B5 (cost instrumentation plumbing, carry-forward #5).
 *
 * Phase 1 enforcement is limited: only wall-clock ceilings fire
 * mid-wake (via the existing executor timeout path). Cost and API-call
 * ceilings are evaluated post-hoc at `finalize()` time and surfaced as
 * {@link BudgetGateResult.breaches}; mid-wake enforcement for those
 * dimensions lands in Phase 2 when the LLM and GitHub clients exist.
 */

import { type USDMicros } from "./usd.js";

/**
 * Per-wake budget ceiling. Any field left undefined means "no ceiling
 * on this dimension." At least one ceiling field must be set or the
 * object is semantically a no-op.
 */
export interface BudgetCeiling {
  readonly maxWallClockMs?: number;
  readonly maxCostMicros?: USDMicros;
  readonly maxGithubApiCalls?: number;
  /**
   * What to do on breach. `"abort"` asks the executor to kill the wake
   * as soon as a mid-wake breach is observed. `"warn"` logs and
   * continues. Default for Phase 1 callers: `"warn"`.
   */
  readonly onBreach: "abort" | "warn";
}

/** A single dimension that breached the ceiling. */
export type BudgetBreach =
  | {
      readonly dimension: "wall-clock";
      readonly limitMs: number;
      readonly actualMs: number;
    }
  | {
      readonly dimension: "cost";
      readonly limitMicros: USDMicros;
      readonly actualMicros: USDMicros;
    }
  | {
      readonly dimension: "github-api-calls";
      readonly limit: number;
      readonly actual: number;
    };

/** Outcome of evaluating a {@link BudgetCeiling} against a usage snapshot. */
export interface BudgetGateResult {
  readonly evaluated: true;
  readonly ceiling: BudgetCeiling;
  readonly breaches: readonly BudgetBreach[];
  readonly overrunEvents: number;
  readonly aborted: boolean;
}

/** Immutable usage snapshot passed to {@link evaluateBudgetCeiling}. */
export interface BudgetUsageSnapshot {
  readonly wallClockMs: number;
  readonly costMicros: USDMicros;
  readonly apiCalls: number;
}

/**
 * Evaluate a budget ceiling against a usage snapshot. Pure function;
 * callable mid-wake (for `aborted` enforcement) or at finalize (for
 * post-hoc reporting).
 */
export const evaluateBudgetCeiling = (
  ceiling: BudgetCeiling,
  current: BudgetUsageSnapshot,
): BudgetGateResult => {
  const breaches: BudgetBreach[] = [];
  if (ceiling.maxWallClockMs !== undefined && current.wallClockMs > ceiling.maxWallClockMs) {
    breaches.push({
      dimension: "wall-clock",
      limitMs: ceiling.maxWallClockMs,
      actualMs: current.wallClockMs,
    });
  }
  if (
    ceiling.maxCostMicros !== undefined &&
    current.costMicros.value > ceiling.maxCostMicros.value
  ) {
    breaches.push({
      dimension: "cost",
      limitMicros: ceiling.maxCostMicros,
      actualMicros: current.costMicros,
    });
  }
  if (ceiling.maxGithubApiCalls !== undefined && current.apiCalls > ceiling.maxGithubApiCalls) {
    breaches.push({
      dimension: "github-api-calls",
      limit: ceiling.maxGithubApiCalls,
      actual: current.apiCalls,
    });
  }
  return {
    evaluated: true,
    ceiling,
    breaches,
    overrunEvents: breaches.length,
    aborted: breaches.length > 0 && ceiling.onBreach === "abort",
  };
};
