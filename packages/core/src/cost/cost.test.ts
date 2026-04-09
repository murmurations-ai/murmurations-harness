import { describe, expect, it } from "vitest";

import { makeAgentId, makeWakeId } from "../execution/index.js";
import {
  addUSDMicros,
  evaluateBudgetCeiling,
  formatUSDMicros,
  makeUSDMicros,
  WakeCostBuilder,
  wakeCostRecordSchema,
  ZERO_USD_MICROS,
  computeIsoWeekUtc,
} from "./index.js";

// ---------------------------------------------------------------------------
// USDMicros
// ---------------------------------------------------------------------------

describe("USDMicros", () => {
  it("rejects non-integer and negative values", () => {
    expect(() => makeUSDMicros(1.5)).toThrow(RangeError);
    expect(() => makeUSDMicros(-1)).toThrow(RangeError);
  });

  it("accepts zero and positive integers", () => {
    expect(makeUSDMicros(0).value).toBe(0);
    expect(makeUSDMicros(1_234_567).value).toBe(1_234_567);
  });

  it("addUSDMicros sums correctly", () => {
    const sum = addUSDMicros(makeUSDMicros(1000), makeUSDMicros(2500));
    expect(sum.value).toBe(3500);
  });

  it("formatUSDMicros renders 4-digit precision", () => {
    expect(formatUSDMicros(makeUSDMicros(12_345))).toBe("0.0123");
    expect(formatUSDMicros(makeUSDMicros(1_000_000))).toBe("1.0000");
    expect(formatUSDMicros(ZERO_USD_MICROS)).toBe("0.0000");
  });
});

// ---------------------------------------------------------------------------
// evaluateBudgetCeiling
// ---------------------------------------------------------------------------

describe("evaluateBudgetCeiling", () => {
  it("returns no breaches when all dimensions are under the ceiling", () => {
    const result = evaluateBudgetCeiling(
      {
        maxWallClockMs: 10_000,
        maxCostMicros: makeUSDMicros(50_000),
        maxGithubApiCalls: 100,
        onBreach: "warn",
      },
      { wallClockMs: 500, costMicros: makeUSDMicros(0), apiCalls: 0 },
    );
    expect(result.breaches).toEqual([]);
    expect(result.overrunEvents).toBe(0);
    expect(result.aborted).toBe(false);
  });

  it("reports a wall-clock breach", () => {
    const result = evaluateBudgetCeiling(
      { maxWallClockMs: 1000, onBreach: "warn" },
      { wallClockMs: 1500, costMicros: ZERO_USD_MICROS, apiCalls: 0 },
    );
    expect(result.breaches).toHaveLength(1);
    expect(result.breaches[0]).toEqual({
      dimension: "wall-clock",
      limitMs: 1000,
      actualMs: 1500,
    });
    expect(result.aborted).toBe(false);
  });

  it("marks aborted when onBreach is 'abort'", () => {
    const result = evaluateBudgetCeiling(
      { maxWallClockMs: 1000, onBreach: "abort" },
      { wallClockMs: 1500, costMicros: ZERO_USD_MICROS, apiCalls: 0 },
    );
    expect(result.aborted).toBe(true);
  });

  it("reports multiple simultaneous breaches", () => {
    const result = evaluateBudgetCeiling(
      {
        maxWallClockMs: 100,
        maxCostMicros: makeUSDMicros(100),
        maxGithubApiCalls: 1,
        onBreach: "warn",
      },
      { wallClockMs: 500, costMicros: makeUSDMicros(10_000), apiCalls: 42 },
    );
    expect(result.breaches).toHaveLength(3);
    expect(result.overrunEvents).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// WakeCostBuilder
// ---------------------------------------------------------------------------

describe("WakeCostBuilder", () => {
  const mkBuilder = (
    opts: {
      now?: () => Date;
      ceiling?: Parameters<typeof WakeCostBuilder.start>[0]["ceiling"];
    } = {},
  ): WakeCostBuilder => {
    const init: Parameters<typeof WakeCostBuilder.start>[0] = {
      wakeId: makeWakeId("wake-test"),
      agentId: makeAgentId("07-wren"),
      modelTier: "balanced",
      circleIds: ["engineering"],
      ...(opts.now !== undefined ? { now: opts.now } : {}),
      ...(opts.ceiling !== undefined ? { ceiling: opts.ceiling } : {}),
    };
    return WakeCostBuilder.start(init);
  };

  it("produces a zero-cost record on immediate finalize", () => {
    let ticks = 0;
    const now = (): Date => new Date(1_700_000_000_000 + ticks++ * 10);
    const builder = mkBuilder({ now });
    const record = builder.finalize();
    expect(record.schemaVersion).toBe(1);
    expect(record.wakeId.value).toBe("wake-test");
    expect(record.agentId.value).toBe("07-wren");
    expect(record.modelTier).toBe("balanced");
    expect(record.totals.costMicros.value).toBe(0);
    expect(record.totals.apiCalls).toBe(0);
    expect(record.llm.inputTokens).toBe(0);
    expect(record.llm.outputTokens).toBe(0);
    expect(record.llm.modelProvider).toBe("placeholder");
    expect(record.llm.modelName).toBe("phase-1a-stub");
    expect(record.github.restCalls).toBe(0);
    expect(record.github.graphqlCalls).toBe(0);
    expect(record.budget).toBeNull();
    expect(record.rollupHints.circleIds).toEqual(["engineering"]);
    expect(record.rollupHints.dayUtc).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(record.rollupHints.isoWeekUtc).toMatch(/^\d{4}-W\d{2}$/);
  });

  it("addLlmTokens sums across multiple calls and preserves last model", () => {
    const builder = mkBuilder();
    builder.addLlmTokens({
      inputTokens: 100,
      outputTokens: 50,
      modelProvider: "anthropic",
      modelName: "sonnet-4-5",
      costMicros: makeUSDMicros(1000),
    });
    builder.addLlmTokens({
      inputTokens: 200,
      outputTokens: 75,
      modelProvider: "anthropic",
      modelName: "opus-4-6",
      costMicros: makeUSDMicros(5000),
    });
    const record = builder.finalize();
    expect(record.llm.inputTokens).toBe(300);
    expect(record.llm.outputTokens).toBe(125);
    expect(record.llm.modelName).toBe("opus-4-6");
    expect(record.totals.costMicros.value).toBe(6000);
  });

  it("addGithubCall counts rest, graphql, and cache hits separately", () => {
    const builder = mkBuilder();
    builder.addGithubCall({ transport: "rest" });
    builder.addGithubCall({ transport: "rest" });
    builder.addGithubCall({ transport: "graphql" });
    builder.addGithubCall({ transport: "rest", cacheHit: true });
    const record = builder.finalize();
    expect(record.github.restCalls).toBe(2);
    expect(record.github.graphqlCalls).toBe(1);
    expect(record.github.cacheHits).toBe(1);
    expect(record.totals.apiCalls).toBe(3);
  });

  it("addGithubCall retains the last observed rateLimitRemaining", () => {
    const builder = mkBuilder();
    builder.addGithubCall({ transport: "rest", rateLimitRemaining: 4200 });
    builder.addGithubCall({ transport: "rest" });
    const record = builder.finalize();
    expect(record.github.rateLimitRemaining).toBe(4200);
  });

  it("recordSubprocessUsage takes maxRssKb as a high-water mark", () => {
    const builder = mkBuilder();
    builder.recordSubprocessUsage({
      userCpuMicros: 10_000,
      systemCpuMicros: 2_000,
      maxRssKb: 81_920,
    });
    builder.recordSubprocessUsage({
      userCpuMicros: 5_000,
      systemCpuMicros: 1_000,
      maxRssKb: 40_000,
    });
    const record = builder.finalize();
    expect(record.subprocess?.userCpuMicros).toBe(15_000);
    expect(record.subprocess?.systemCpuMicros).toBe(3_000);
    expect(record.subprocess?.maxRssKb).toBe(81_920);
  });

  it("subprocess field is undefined when never recorded", () => {
    const record = mkBuilder().finalize();
    expect(record.subprocess).toBeUndefined();
  });

  it("mutator methods throw after finalize", () => {
    const builder = mkBuilder();
    builder.finalize();
    expect(() => builder.addGithubCall({ transport: "rest" })).toThrow();
    expect(() =>
      builder.addLlmTokens({
        inputTokens: 1,
        outputTokens: 1,
        modelProvider: "a",
        modelName: "b",
        costMicros: ZERO_USD_MICROS,
      }),
    ).toThrow();
    expect(() =>
      builder.recordSubprocessUsage({
        userCpuMicros: 1,
        systemCpuMicros: 1,
        maxRssKb: 1,
      }),
    ).toThrow();
  });

  it("finalize is memoized — second call returns the same record", () => {
    const builder = mkBuilder();
    const r1 = builder.finalize();
    const r2 = builder.finalize();
    expect(r2).toBe(r1);
  });

  it("snapshotTotals does not mutate and can be called repeatedly", () => {
    const builder = mkBuilder();
    builder.addGithubCall({ transport: "rest" });
    const s1 = builder.snapshotTotals();
    const s2 = builder.snapshotTotals();
    expect(s1.apiCalls).toBe(1);
    expect(s2.apiCalls).toBe(1);
    // Still not finalized.
    builder.addGithubCall({ transport: "rest" });
    expect(builder.snapshotTotals().apiCalls).toBe(2);
  });

  it("evaluateBudget returns null when no ceiling configured", () => {
    expect(mkBuilder().evaluateBudget()).toBeNull();
  });

  it("evaluateBudget reports breaches when ceiling is exceeded", () => {
    const builder = mkBuilder({
      ceiling: {
        maxGithubApiCalls: 0,
        onBreach: "warn",
      },
    });
    builder.addGithubCall({ transport: "rest" });
    const result = builder.evaluateBudget();
    expect(result?.breaches).toHaveLength(1);
  });

  it("finalize attaches budget result when ceiling was set", () => {
    const builder = mkBuilder({
      ceiling: {
        maxCostMicros: makeUSDMicros(500),
        onBreach: "warn",
      },
    });
    builder.addLlmTokens({
      inputTokens: 10,
      outputTokens: 5,
      modelProvider: "p",
      modelName: "m",
      costMicros: makeUSDMicros(1000),
    });
    const record = builder.finalize();
    expect(record.budget).not.toBeNull();
    expect(record.budget?.breaches).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

describe("wakeCostRecordSchema", () => {
  const validRecord = {
    schemaVersion: 1,
    wakeId: { kind: "wake-id", value: "abc" },
    agentId: { kind: "agent-id", value: "07-wren" },
    modelTier: "balanced",
    startedAt: "2026-04-09T00:00:00.000Z",
    finishedAt: "2026-04-09T00:00:01.000Z",
    wallClockMs: 1000,
    llm: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      modelProvider: "placeholder",
      modelName: "phase-1a-stub",
      costMicros: { kind: "usd-micros", value: 0 },
    },
    github: {
      restCalls: 0,
      graphqlCalls: 0,
      cacheHits: 0,
    },
    totals: {
      costMicros: { kind: "usd-micros", value: 0 },
      apiCalls: 0,
    },
    budget: null,
    rollupHints: {
      dayUtc: "2026-04-09",
      isoWeekUtc: "2026-W15",
      circleIds: ["engineering"],
    },
  };

  it("accepts a minimal zero-cost record", () => {
    expect(wakeCostRecordSchema.safeParse(validRecord).success).toBe(true);
  });

  it("rejects schemaVersion !== 1", () => {
    const bad = { ...validRecord, schemaVersion: 2 };
    expect(wakeCostRecordSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects negative wallClockMs", () => {
    const bad = { ...validRecord, wallClockMs: -1 };
    expect(wakeCostRecordSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects malformed dayUtc", () => {
    const bad = {
      ...validRecord,
      rollupHints: { ...validRecord.rollupHints, dayUtc: "April 9 2026" },
    };
    expect(wakeCostRecordSchema.safeParse(bad).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeIsoWeekUtc
// ---------------------------------------------------------------------------

describe("computeIsoWeekUtc", () => {
  it("returns a YYYY-Www string", () => {
    expect(computeIsoWeekUtc(new Date("2026-04-09T00:00:00Z"))).toMatch(/^\d{4}-W\d{2}$/);
  });

  it("handles year-start edge cases (Jan 1 may belong to previous year)", () => {
    // 2026-01-01 is a Thursday in year 2026 — ISO week 1 of 2026.
    expect(computeIsoWeekUtc(new Date("2026-01-01T12:00:00Z"))).toBe("2026-W01");
  });
});
