/**
 * Wake cost record — the canonical per-wake cost schema emitted by the
 * daemon on every wake completion. Ratified as part of Phase 1B step B5
 * (carry-forward #5, Performance / Observability Agent #27).
 *
 * The record is additive to the existing `AgentResult.cost: CostActuals`
 * field (which stays for continuity) — new consumers read
 * `AgentResult.costRecord`; legacy consumers that only need summary
 * numbers keep working.
 *
 * ## Forward-compat stubs
 *
 * LLM and GitHub fields exist as zero stubs in Phase 1 because neither
 * integration has landed yet:
 *
 *   - `llm.*` populates in Phase 2 (one-agent proof)
 *   - `github.*` populates in Phase 1B-d (B2, the `@murmuration/github`
 *     package)
 *
 * Shape is frozen at `schemaVersion: 1` now so downstream readers
 * (dashboards, rollups, budget gates) can be built against it without
 * churn. Any breaking change to field names bumps the version.
 */

import { z } from "zod";

import type { AgentId, ModelTier, WakeId } from "../execution/index.js";
import type { BudgetGateResult } from "./budget.js";
import type { USDMicros } from "./usd.js";

/**
 * One immutable cost record per wake. Built up via
 * {@link import("./builder.js").WakeCostBuilder} and attached to
 * {@link import("../execution/index.js").AgentResult.costRecord}.
 */
export interface WakeCostRecord {
  readonly schemaVersion: 1;

  // Identity
  readonly wakeId: WakeId;
  readonly agentId: AgentId;
  readonly modelTier: ModelTier;

  // Timing
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly wallClockMs: number;

  /**
   * Subprocess resource-usage accounting. Optional because in-process
   * executors (future) cannot cheaply isolate their own deltas. The
   * {@link import("../execution/subprocess.js").SubprocessExecutor}
   * populates this for every wake.
   */
  readonly subprocess:
    | {
        readonly userCpuMicros: number;
        readonly systemCpuMicros: number;
        readonly maxRssKb: number;
      }
    | undefined;

  /** LLM accounting. Stubbed zero until Phase 2. */
  readonly llm: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
    readonly modelProvider: string;
    readonly modelName: string;
    readonly costMicros: USDMicros;
  };

  /** GitHub API accounting. Stubbed zero until Phase 1B-d (B2). */
  readonly github: {
    readonly restCalls: number;
    readonly graphqlCalls: number;
    readonly cacheHits: number;
    readonly rateLimitRemaining: number | undefined;
  };

  /** Pre-computed totals, handy for log output and rollup. */
  readonly totals: {
    readonly costMicros: USDMicros;
    readonly apiCalls: number;
  };

  /** Budget evaluation, or `null` if no ceiling was configured. */
  readonly budget: BudgetGateResult | null;

  /**
   * Hints to the (future) rollup aggregator. Phase 1 always fills these
   * in locally; Phase 2+ adds a reader that groups by them.
   */
  readonly rollupHints: {
    readonly dayUtc: string;
    readonly isoWeekUtc: string;
    readonly circleIds: readonly string[];
  };
}

// ---------------------------------------------------------------------------
// Zod schema — used only when a cost record is reconstructed from an
// untrusted source (e.g. parsed from subprocess stdout in Phase 2+).
// In Phase 1 executors build records in-process via the builder and the
// TypeScript type is sufficient, so this schema is ship-now scaffolding.
// ---------------------------------------------------------------------------

const brandedValue = (kind: string, valueSchema: z.ZodType): z.ZodType =>
  z.object({ kind: z.literal(kind), value: valueSchema });

export const wakeCostRecordSchema = z.object({
  schemaVersion: z.literal(1),
  wakeId: brandedValue("wake-id", z.string().min(1)),
  agentId: brandedValue("agent-id", z.string().min(1)),
  modelTier: z.enum(["fast", "balanced", "deep"]),
  startedAt: z.coerce.date(),
  finishedAt: z.coerce.date(),
  wallClockMs: z.number().int().nonnegative(),
  subprocess: z
    .object({
      userCpuMicros: z.number().int().nonnegative(),
      systemCpuMicros: z.number().int().nonnegative(),
      maxRssKb: z.number().int().nonnegative(),
    })
    .optional(),
  llm: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
    modelProvider: z.string(),
    modelName: z.string(),
    costMicros: brandedValue("usd-micros", z.number().int().nonnegative()),
  }),
  github: z.object({
    restCalls: z.number().int().nonnegative(),
    graphqlCalls: z.number().int().nonnegative(),
    cacheHits: z.number().int().nonnegative(),
    rateLimitRemaining: z.number().int().nonnegative().optional(),
  }),
  totals: z.object({
    costMicros: brandedValue("usd-micros", z.number().int().nonnegative()),
    apiCalls: z.number().int().nonnegative(),
  }),
  // BudgetGateResult is deliberately loose at the schema layer — the
  // builder is the authority. Readers that need to reason about budget
  // detail should use the TypeScript type.
  budget: z.unknown().nullable(),
  rollupHints: z.object({
    dayUtc: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    isoWeekUtc: z.string().regex(/^\d{4}-W\d{2}$/),
    circleIds: z.array(z.string()).readonly(),
  }),
});

/**
 * Compute an ISO week string (`YYYY-Www`) from a Date, in UTC. Used by
 * {@link import("./builder.js").WakeCostBuilder} to populate
 * {@link WakeCostRecord.rollupHints.isoWeekUtc}.
 *
 * Follows ISO 8601: weeks start on Monday; week 1 is the week
 * containing the first Thursday of the year.
 */
export const computeIsoWeekUtc = (date: Date): string => {
  // Work in UTC.
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Day number: 1..7 where Monday=1, Sunday=7.
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${String(d.getUTCFullYear())}-W${String(weekNo).padStart(2, "0")}`;
};
