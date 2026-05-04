/**
 * Effectiveness metrics — Workstream F of v0.7.0 Agent Effectiveness.
 *
 * Pure functions over GitHub issue snapshots + wake cost records. No
 * I/O, no aggregation hooks, no UI — just the math the dashboard tab
 * and the `murmuration metrics --json` exporter consume.
 *
 * Targets surfaced (from `docs/specs/0001-agent-effectiveness.md` §8):
 *
 *   - issue-closure rate (non-DIRECTIVE, within Nd of filing)
 *   - median open-issue age
 *   - wake completion rate
 *   - cost per closed issue
 *   - per-accountability met-rate
 *
 * The dashboard tab and Spirit tools are consumers; integrating them
 * lives in `packages/dashboard-tui/` and `packages/cli/src/spirit/` as
 * follow-up commits. This module ships the pure math + types so the
 * synthetic-corpus acceptance fixture can validate the numbers.
 *
 * @see ADR-0042 §Part 2
 * @see docs/specs/0001-agent-effectiveness.md §8 (success metrics)
 */

import type { WakeCostRecord } from "../cost/record.js";

// ---------------------------------------------------------------------------
// Issue snapshot — minimal shape the metrics functions need.
// ---------------------------------------------------------------------------

/**
 * The minimum we need to know about an issue to compute closure +
 * age + cost-per-close metrics. A compatible subset of the
 * `IssueSnapshot` from governance/index.ts; kept separate so this
 * module doesn't depend on the governance plugin layer.
 */
export interface MetricsIssue {
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "closed";
  readonly createdAt: Date;
  readonly closedAt: Date | undefined;
}

// ---------------------------------------------------------------------------
// Closure rate
// ---------------------------------------------------------------------------

export interface ClosureRateStats {
  /** Total issues filed in the window. */
  readonly filed: number;
  /** Closed within `daysToClose` of filing. */
  readonly closedWithinWindow: number;
  /** Still open at `now`. */
  readonly stillOpen: number;
  /** `closedWithinWindow / filed`, or 0 when `filed === 0`. */
  readonly rate: number;
}

const extractIssueType = (title: string): string => {
  const match = /^\s*(\[[^\]]+\])/.exec(title);
  return match?.[1] ?? "[other]";
};

/**
 * Compute closure rate per issue-type prefix over a recent window.
 *
 * Window semantics: an issue counts as `filed` if it was created on
 * or after `since`. It counts as `closedWithinWindow` if it was
 * closed AND `closedAt - createdAt <= daysToClose * 1d`.
 *
 * Returns one stats object per issue type seen (`[TENSION]`,
 * `[PROPOSAL]`, `[*MEETING]` variants, `[DIRECTIVE]`, `[other]`,
 * etc.) plus an `all` aggregate.
 */
export const computeClosureRateByType = (input: {
  readonly issues: readonly MetricsIssue[];
  readonly since: Date;
  readonly now: Date;
  readonly daysToClose: number;
}): {
  readonly byType: Readonly<Record<string, ClosureRateStats>>;
  readonly all: ClosureRateStats;
} => {
  const closeWindowMs = input.daysToClose * 24 * 60 * 60 * 1000;
  const buckets = new Map<string, { filed: number; closed: number; open: number }>();
  const all = { filed: 0, closed: 0, open: 0 };

  for (const issue of input.issues) {
    if (issue.createdAt < input.since) continue;
    const type = extractIssueType(issue.title);
    const bucket = buckets.get(type) ?? { filed: 0, closed: 0, open: 0 };
    bucket.filed += 1;
    all.filed += 1;
    if (issue.state === "closed" && issue.closedAt !== undefined) {
      const elapsed = issue.closedAt.getTime() - issue.createdAt.getTime();
      if (elapsed <= closeWindowMs) {
        bucket.closed += 1;
        all.closed += 1;
      }
    }
    if (issue.state === "open") {
      bucket.open += 1;
      all.open += 1;
    }
    buckets.set(type, bucket);
  }

  const byType: Record<string, ClosureRateStats> = {};
  for (const [type, b] of buckets) {
    byType[type] = {
      filed: b.filed,
      closedWithinWindow: b.closed,
      stillOpen: b.open,
      rate: b.filed === 0 ? 0 : b.closed / b.filed,
    };
  }

  return {
    byType,
    all: {
      filed: all.filed,
      closedWithinWindow: all.closed,
      stillOpen: all.open,
      rate: all.filed === 0 ? 0 : all.closed / all.filed,
    },
  };
};

// ---------------------------------------------------------------------------
// Age distribution
// ---------------------------------------------------------------------------

export interface AgeDistribution {
  /** Number of currently-open issues considered. */
  readonly count: number;
  /** Median open-issue age in days. 0 when count === 0. */
  readonly medianAgeDays: number;
  /** Issues open for ≤7 days. */
  readonly under7d: number;
  /** Issues open for 7–14 days. */
  readonly between7and14d: number;
  /** Issues open >14 days. */
  readonly over14d: number;
}

/**
 * Open-issue age distribution. Closed issues are ignored. Median is
 * computed in days (floored to integer); buckets are 0–7d, 7–14d,
 * >14d. The median + the >14d bucket are the load-bearing numbers
 * for the spec target ("median open-issue age < 7d").
 */
export const computeAgeDistribution = (input: {
  readonly issues: readonly MetricsIssue[];
  readonly now: Date;
}): AgeDistribution => {
  const ages: number[] = [];
  let under7 = 0;
  let between = 0;
  let over14 = 0;

  for (const issue of input.issues) {
    if (issue.state !== "open") continue;
    const ageDays = (input.now.getTime() - issue.createdAt.getTime()) / (24 * 60 * 60 * 1000);
    ages.push(ageDays);
    if (ageDays <= 7) under7 += 1;
    else if (ageDays <= 14) between += 1;
    else over14 += 1;
  }

  ages.sort((a, b) => a - b);
  let median = 0;
  if (ages.length > 0) {
    const mid = Math.floor(ages.length / 2);
    if (ages.length % 2 === 0) {
      const lo = ages[mid - 1] ?? 0;
      const hi = ages[mid] ?? 0;
      median = (lo + hi) / 2;
    } else {
      median = ages[mid] ?? 0;
    }
  }

  return {
    count: ages.length,
    medianAgeDays: Math.round(median * 10) / 10,
    under7d: under7,
    between7and14d: between,
    over14d: over14,
  };
};

// ---------------------------------------------------------------------------
// Wake completion rate
// ---------------------------------------------------------------------------

export interface WakeCompletionStats {
  readonly totalWakes: number;
  /** Wakes where the budget gate did not fire AND wallClockMs > 0. */
  readonly completedWakes: number;
  /** `completedWakes / totalWakes`, or 0 when totalWakes === 0. */
  readonly rate: number;
}

/**
 * Wake completion rate over a set of cost records.
 *
 * "Completed" = budget gate did not abort the wake AND the wake
 * produced positive wall-clock (zero-time wakes are
 * placeholder/failed records). The complement is the combined
 * timeout + LLM-failure population.
 */
export const computeWakeCompletionRate = (
  records: readonly WakeCostRecord[],
): WakeCompletionStats => {
  const total = records.length;
  let completed = 0;
  for (const r of records) {
    const aborted = r.budget?.aborted === true;
    if (!aborted && r.wallClockMs > 0) completed += 1;
  }
  return {
    totalWakes: total,
    completedWakes: completed,
    rate: total === 0 ? 0 : completed / total,
  };
};

// ---------------------------------------------------------------------------
// Cost per closed issue
// ---------------------------------------------------------------------------

export interface CostPerClosedStats {
  readonly closedIssues: number;
  readonly totalCostMicros: number;
  /** USD micros per closed issue. 0 when closedIssues === 0. */
  readonly costMicrosPerClosure: number;
}

/**
 * Cost-per-closed-issue over a window. Sums `totals.costMicros`
 * across the wake records and divides by the number of issues
 * closed in the same window. Zero closures returns
 * `costMicrosPerClosure: 0` (rather than Infinity) so dashboards
 * don't need to special-case the empty state.
 */
export const computeCostPerClosed = (input: {
  readonly issues: readonly MetricsIssue[];
  readonly wakeRecords: readonly WakeCostRecord[];
  readonly since: Date;
  readonly now: Date;
}): CostPerClosedStats => {
  let closed = 0;
  for (const issue of input.issues) {
    if (
      issue.state === "closed" &&
      issue.closedAt !== undefined &&
      issue.closedAt >= input.since &&
      issue.closedAt <= input.now
    ) {
      closed += 1;
    }
  }

  let total = 0;
  for (const r of input.wakeRecords) {
    if (r.startedAt >= input.since && r.startedAt <= input.now) {
      total += r.totals.costMicros.value;
    }
  }

  return {
    closedIssues: closed,
    totalCostMicros: total,
    costMicrosPerClosure: closed === 0 ? 0 : Math.round(total / closed),
  };
};

// ---------------------------------------------------------------------------
// Per-accountability met-rate
// ---------------------------------------------------------------------------

/**
 * One observation: at one wake, accountability X was either met or
 * unmet. The aggregator emits these from the wake-end `done_when`
 * validator output (Workstream D).
 */
export interface AccountabilityObservation {
  readonly accountabilityId: string;
  readonly agentId: string;
  readonly observedAt: Date;
  readonly met: boolean;
}

export interface AccountabilityMetRate {
  readonly accountabilityId: string;
  readonly observations: number;
  readonly metCount: number;
  /** `metCount / observations`, or 0 when no observations. */
  readonly rate: number;
}

/**
 * Met-rate per accountability over a window. Observations outside
 * `[since, now]` are ignored.
 *
 * The observation stream is generated by the wake-end validator pass
 * — for each accountability declared in the agent's `role.md`, the
 * validator emits one observation per wake (met or unmet). This
 * function rolls them up so the dashboard can show "weekly-digest
 * accountability has 80% met-rate over the last 30 days."
 */
export const computeAccountabilityMetRates = (input: {
  readonly observations: readonly AccountabilityObservation[];
  readonly since: Date;
  readonly now: Date;
}): readonly AccountabilityMetRate[] => {
  const buckets = new Map<string, { observations: number; metCount: number }>();
  for (const obs of input.observations) {
    if (obs.observedAt < input.since || obs.observedAt > input.now) continue;
    const b = buckets.get(obs.accountabilityId) ?? { observations: 0, metCount: 0 };
    b.observations += 1;
    if (obs.met) b.metCount += 1;
    buckets.set(obs.accountabilityId, b);
  }

  const out: AccountabilityMetRate[] = [];
  for (const [accountabilityId, b] of buckets) {
    out.push({
      accountabilityId,
      observations: b.observations,
      metCount: b.metCount,
      rate: b.observations === 0 ? 0 : b.metCount / b.observations,
    });
  }
  // Stable order: by id ascending so dashboards render deterministically.
  out.sort((a, b) => a.accountabilityId.localeCompare(b.accountabilityId));
  return out;
};

// ---------------------------------------------------------------------------
// Aggregate snapshot
// ---------------------------------------------------------------------------

/**
 * One-call rollup of every effectiveness metric for a given window.
 * Backs `murmuration metrics --json` and the dashboard tab's "current
 * state" pane.
 */
export interface EffectivenessSnapshot {
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly closure: ReturnType<typeof computeClosureRateByType>;
  readonly age: AgeDistribution;
  readonly wakeCompletion: WakeCompletionStats;
  readonly costPerClosed: CostPerClosedStats;
  readonly accountabilityMetRates: readonly AccountabilityMetRate[];
}

export const computeEffectivenessSnapshot = (input: {
  readonly issues: readonly MetricsIssue[];
  readonly wakeRecords: readonly WakeCostRecord[];
  readonly observations: readonly AccountabilityObservation[];
  readonly since: Date;
  readonly now: Date;
  readonly daysToClose: number;
}): EffectivenessSnapshot => ({
  windowStart: input.since,
  windowEnd: input.now,
  closure: computeClosureRateByType({
    issues: input.issues,
    since: input.since,
    now: input.now,
    daysToClose: input.daysToClose,
  }),
  age: computeAgeDistribution({ issues: input.issues, now: input.now }),
  wakeCompletion: computeWakeCompletionRate(input.wakeRecords),
  costPerClosed: computeCostPerClosed({
    issues: input.issues,
    wakeRecords: input.wakeRecords,
    since: input.since,
    now: input.now,
  }),
  accountabilityMetRates: computeAccountabilityMetRates({
    observations: input.observations,
    since: input.since,
    now: input.now,
  }),
});
