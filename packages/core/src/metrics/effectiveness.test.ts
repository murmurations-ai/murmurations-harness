import { describe, expect, it } from "vitest";

import {
  computeAccountabilityMetRates,
  computeAgeDistribution,
  computeClosureRateByType,
  computeCostPerClosed,
  computeEffectivenessSnapshot,
  computeWakeCompletionRate,
  type AccountabilityObservation,
  type MetricsIssue,
} from "./effectiveness.js";

import type { WakeCostRecord } from "../cost/record.js";
import { makeAgentId, makeWakeId } from "../execution/index.js";
import { makeUSDMicros } from "../cost/usd.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const day = (n: number, ref: Date): Date => new Date(ref.getTime() + n * 86_400_000);

const NOW = new Date("2026-05-04T18:00:00Z");
const SINCE = day(-30, NOW);

let issueCounter = 0;
const issue = (overrides: Partial<MetricsIssue> = {}): MetricsIssue => ({
  number: ++issueCounter,
  title: "[TENSION] generic",
  state: "open",
  createdAt: day(-5, NOW),
  closedAt: undefined,
  ...overrides,
});

let wakeCounter = 0;
const wake = (
  overrides: {
    readonly startedAt?: Date;
    readonly wallClockMs?: number;
    readonly costMicros?: number;
    readonly aborted?: boolean;
  } = {},
): WakeCostRecord => ({
  schemaVersion: 1,
  wakeId: makeWakeId(`wake-${String(++wakeCounter)}`),
  agentId: makeAgentId("test-agent"),
  modelTier: "balanced",
  startedAt: overrides.startedAt ?? day(-1, NOW),
  finishedAt: overrides.startedAt ?? day(-1, NOW),
  wallClockMs: overrides.wallClockMs ?? 1000,
  subprocess: undefined,
  llm: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    modelProvider: "anthropic",
    modelName: "claude-sonnet-4-6",
    costMicros: makeUSDMicros(overrides.costMicros ?? 0),
    shadowCostMicros: undefined,
  },
  github: {
    restCalls: 0,
    graphqlCalls: 0,
    cacheHits: 0,
    rateLimitRemaining: undefined,
  },
  totals: {
    costMicros: makeUSDMicros(overrides.costMicros ?? 0),
    apiCalls: 0,
  },
  budget:
    overrides.aborted === true
      ? {
          evaluated: true,
          ceiling: { maxCostMicros: makeUSDMicros(1), onBreach: "abort" },
          breaches: [],
          overrunEvents: 0,
          aborted: true,
        }
      : null,
  rollupHints: {
    dayUtc: "2026-05-04",
    isoWeekUtc: "2026-W19",
    groupIds: [],
  },
});

// ---------------------------------------------------------------------------
// computeClosureRateByType
// ---------------------------------------------------------------------------

describe("computeClosureRateByType", () => {
  it("counts filed, closed-within-window, still-open by type", () => {
    const issues: MetricsIssue[] = [
      // [PROPOSAL] filed -10d, closed -3d → 7d to close, within 14d window
      issue({
        title: "[PROPOSAL] x",
        createdAt: day(-10, NOW),
        closedAt: day(-3, NOW),
        state: "closed",
      }),
      // [PROPOSAL] filed -10d, closed -1d → 9d to close, within 14d window
      issue({
        title: "[PROPOSAL] y",
        createdAt: day(-10, NOW),
        closedAt: day(-1, NOW),
        state: "closed",
      }),
      // [PROPOSAL] filed -5d, still open
      issue({ title: "[PROPOSAL] z", createdAt: day(-5, NOW), state: "open" }),
      // [TENSION] filed -3d, still open
      issue({ title: "[TENSION] a", createdAt: day(-3, NOW), state: "open" }),
    ];

    const r = computeClosureRateByType({
      issues,
      since: SINCE,
      now: NOW,
      daysToClose: 14,
    });

    expect(r.byType["[PROPOSAL]"]).toEqual({
      filed: 3,
      closedWithinWindow: 2,
      stillOpen: 1,
      rate: 2 / 3,
    });
    expect(r.byType["[TENSION]"]).toEqual({
      filed: 1,
      closedWithinWindow: 0,
      stillOpen: 1,
      rate: 0,
    });
    expect(r.all.filed).toBe(4);
    expect(r.all.closedWithinWindow).toBe(2);
  });

  it("excludes issues filed before the window", () => {
    const r = computeClosureRateByType({
      issues: [issue({ createdAt: day(-60, NOW) })],
      since: SINCE,
      now: NOW,
      daysToClose: 14,
    });
    expect(r.all.filed).toBe(0);
  });

  it("a closure outside daysToClose doesn't count toward closedWithinWindow", () => {
    // Closed 20d after filing — beyond a 14d window.
    const issues: MetricsIssue[] = [
      issue({
        title: "[PROPOSAL] slow",
        createdAt: day(-25, NOW),
        closedAt: day(-3, NOW),
        state: "closed",
      }),
    ];
    const r = computeClosureRateByType({
      issues,
      since: SINCE,
      now: NOW,
      daysToClose: 14,
    });
    expect(r.byType["[PROPOSAL]"]?.closedWithinWindow).toBe(0);
    expect(r.byType["[PROPOSAL]"]?.filed).toBe(1);
    expect(r.byType["[PROPOSAL]"]?.rate).toBe(0);
  });

  it("returns rate 0 when filed === 0", () => {
    const r = computeClosureRateByType({
      issues: [],
      since: SINCE,
      now: NOW,
      daysToClose: 14,
    });
    expect(r.all.rate).toBe(0);
  });

  it("issues without bracketed prefix bucket as [other]", () => {
    const r = computeClosureRateByType({
      issues: [issue({ title: "no prefix here" })],
      since: SINCE,
      now: NOW,
      daysToClose: 14,
    });
    expect(r.byType["[other]"]?.filed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// computeAgeDistribution
// ---------------------------------------------------------------------------

describe("computeAgeDistribution", () => {
  it("ignores closed issues entirely", () => {
    const r = computeAgeDistribution({
      issues: [
        issue({ state: "closed", closedAt: day(-1, NOW) }),
        issue({ state: "open", createdAt: day(-3, NOW) }),
      ],
      now: NOW,
    });
    expect(r.count).toBe(1);
  });

  it("buckets ages: <=7d, 7–14d, >14d", () => {
    const issues: MetricsIssue[] = [
      issue({ createdAt: day(-2, NOW) }),
      issue({ createdAt: day(-5, NOW) }),
      issue({ createdAt: day(-10, NOW) }),
      issue({ createdAt: day(-13, NOW) }),
      issue({ createdAt: day(-20, NOW) }),
      issue({ createdAt: day(-30, NOW) }),
    ];
    const r = computeAgeDistribution({ issues, now: NOW });
    expect(r.under7d).toBe(2);
    expect(r.between7and14d).toBe(2);
    expect(r.over14d).toBe(2);
  });

  it("computes median age (odd count)", () => {
    const issues: MetricsIssue[] = [
      issue({ createdAt: day(-1, NOW) }),
      issue({ createdAt: day(-5, NOW) }),
      issue({ createdAt: day(-10, NOW) }),
    ];
    const r = computeAgeDistribution({ issues, now: NOW });
    expect(r.medianAgeDays).toBeCloseTo(5, 1);
  });

  it("computes median age (even count) as the average of the middle two", () => {
    const issues: MetricsIssue[] = [
      issue({ createdAt: day(-2, NOW) }),
      issue({ createdAt: day(-4, NOW) }),
      issue({ createdAt: day(-6, NOW) }),
      issue({ createdAt: day(-8, NOW) }),
    ];
    const r = computeAgeDistribution({ issues, now: NOW });
    expect(r.medianAgeDays).toBeCloseTo(5, 1);
  });

  it("returns zeros when there are no open issues", () => {
    const r = computeAgeDistribution({ issues: [], now: NOW });
    expect(r).toEqual({
      count: 0,
      medianAgeDays: 0,
      under7d: 0,
      between7and14d: 0,
      over14d: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// computeWakeCompletionRate
// ---------------------------------------------------------------------------

describe("computeWakeCompletionRate", () => {
  it("counts wakes with positive wall-clock + non-aborted budget as completed", () => {
    const records = [
      wake({ wallClockMs: 1000 }),
      wake({ wallClockMs: 2000 }),
      wake({ wallClockMs: 0 }), // placeholder; not completed
      wake({ wallClockMs: 1500, aborted: true }), // budget abort; not completed
    ];
    const r = computeWakeCompletionRate(records);
    expect(r.totalWakes).toBe(4);
    expect(r.completedWakes).toBe(2);
    expect(r.rate).toBe(0.5);
  });

  it("returns rate 0 when no wakes recorded", () => {
    expect(computeWakeCompletionRate([])).toEqual({
      totalWakes: 0,
      completedWakes: 0,
      rate: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// computeCostPerClosed
// ---------------------------------------------------------------------------

describe("computeCostPerClosed", () => {
  it("divides total cost by closed-issue count over the window", () => {
    const issues: MetricsIssue[] = [
      issue({ state: "closed", closedAt: day(-2, NOW) }),
      issue({ state: "closed", closedAt: day(-3, NOW) }),
      issue({ state: "open" }),
    ];
    const wakes = [
      wake({ startedAt: day(-1, NOW), costMicros: 200_000 }),
      wake({ startedAt: day(-2, NOW), costMicros: 300_000 }),
    ];
    const r = computeCostPerClosed({
      issues,
      wakeRecords: wakes,
      since: SINCE,
      now: NOW,
    });
    expect(r.closedIssues).toBe(2);
    expect(r.totalCostMicros).toBe(500_000);
    expect(r.costMicrosPerClosure).toBe(250_000);
  });

  it("excludes closures + wakes outside the window", () => {
    const issues: MetricsIssue[] = [
      issue({ state: "closed", closedAt: day(-90, NOW) }), // outside
      issue({ state: "closed", closedAt: day(-1, NOW) }),
    ];
    const wakes = [
      wake({ startedAt: day(-1, NOW), costMicros: 100_000 }),
      wake({ startedAt: day(-90, NOW), costMicros: 999_000 }), // outside
    ];
    const r = computeCostPerClosed({
      issues,
      wakeRecords: wakes,
      since: SINCE,
      now: NOW,
    });
    expect(r.closedIssues).toBe(1);
    expect(r.totalCostMicros).toBe(100_000);
    expect(r.costMicrosPerClosure).toBe(100_000);
  });

  it("returns 0 (not Infinity) when there are no closures", () => {
    const r = computeCostPerClosed({
      issues: [],
      wakeRecords: [wake({ costMicros: 100_000 })],
      since: SINCE,
      now: NOW,
    });
    expect(r.costMicrosPerClosure).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeAccountabilityMetRates
// ---------------------------------------------------------------------------

describe("computeAccountabilityMetRates", () => {
  const obs = (overrides: Partial<AccountabilityObservation> = {}): AccountabilityObservation => ({
    accountabilityId: "weekly-digest",
    agentId: "test-agent",
    observedAt: day(-1, NOW),
    met: true,
    ...overrides,
  });

  it("rolls up per-accountability met-rate", () => {
    const observations = [
      obs({ accountabilityId: "weekly-digest", met: true }),
      obs({ accountabilityId: "weekly-digest", met: true }),
      obs({ accountabilityId: "weekly-digest", met: false }),
      obs({ accountabilityId: "tension-resolution", met: true }),
      obs({ accountabilityId: "tension-resolution", met: false }),
    ];
    const r = computeAccountabilityMetRates({ observations, since: SINCE, now: NOW });
    const byId = Object.fromEntries(r.map((x) => [x.accountabilityId, x]));
    expect(byId["weekly-digest"]).toEqual({
      accountabilityId: "weekly-digest",
      observations: 3,
      metCount: 2,
      rate: 2 / 3,
    });
    expect(byId["tension-resolution"]?.rate).toBe(0.5);
  });

  it("returns sorted-by-id for deterministic dashboard rendering", () => {
    const observations = [
      obs({ accountabilityId: "z-thing" }),
      obs({ accountabilityId: "a-thing" }),
      obs({ accountabilityId: "m-thing" }),
    ];
    const r = computeAccountabilityMetRates({ observations, since: SINCE, now: NOW });
    expect(r.map((x) => x.accountabilityId)).toEqual(["a-thing", "m-thing", "z-thing"]);
  });

  it("excludes observations outside the window", () => {
    const observations = [obs({ observedAt: day(-90, NOW) }), obs({ observedAt: day(-1, NOW) })];
    const r = computeAccountabilityMetRates({ observations, since: SINCE, now: NOW });
    expect(r[0]?.observations).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// computeEffectivenessSnapshot — end-to-end rollup
// ---------------------------------------------------------------------------

describe("computeEffectivenessSnapshot", () => {
  it("returns every metric in one shot for the dashboard / json export", () => {
    const issues: MetricsIssue[] = [
      issue({
        title: "[PROPOSAL] x",
        createdAt: day(-10, NOW),
        closedAt: day(-1, NOW),
        state: "closed",
      }),
      issue({ title: "[TENSION] open", createdAt: day(-5, NOW), state: "open" }),
    ];
    const wakes = [wake({ startedAt: day(-1, NOW), wallClockMs: 5_000, costMicros: 50_000 })];
    const observations: AccountabilityObservation[] = [
      {
        accountabilityId: "weekly-digest",
        agentId: "test",
        observedAt: day(-1, NOW),
        met: true,
      },
    ];
    const snapshot = computeEffectivenessSnapshot({
      issues,
      wakeRecords: wakes,
      observations,
      since: SINCE,
      now: NOW,
      daysToClose: 14,
    });

    expect(snapshot.windowStart).toEqual(SINCE);
    expect(snapshot.windowEnd).toEqual(NOW);
    expect(snapshot.closure.all.filed).toBe(2);
    expect(snapshot.closure.all.closedWithinWindow).toBe(1);
    expect(snapshot.age.count).toBe(1);
    expect(snapshot.wakeCompletion.completedWakes).toBe(1);
    expect(snapshot.costPerClosed.closedIssues).toBe(1);
    expect(snapshot.accountabilityMetRates).toHaveLength(1);
    expect(snapshot.accountabilityMetRates[0]?.rate).toBe(1);
  });
});
