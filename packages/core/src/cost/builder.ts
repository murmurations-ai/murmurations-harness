/**
 * Wake cost builder — the mutable accumulator the executor hands to
 * cost-emitting subsystems during a wake. Finalized at wake end to
 * produce an immutable {@link WakeCostRecord}.
 *
 * Lifecycle:
 *
 * ```ts
 * const builder = WakeCostBuilder.start({
 *   wakeId, agentId, modelTier, groupIds, ceiling,
 * });
 * builder.recordSubprocessUsage({ userCpuMicros, systemCpuMicros, maxRssKb });
 * builder.addGithubCall({ transport: "rest" });
 * builder.addLlmTokens({ inputTokens, outputTokens, costMicros, modelProvider, modelName });
 * const record = builder.finalize(new Date());
 * ```
 *
 * Thread-safety: single-wake, single-owner. Node's JS runtime is
 * single-threaded so no locking is required, but callers must not
 * share a builder across wakes.
 */

import type { AgentId, ModelTier, WakeId } from "../execution/index.js";
import { evaluateBudgetCeiling, type BudgetCeiling, type BudgetGateResult } from "./budget.js";
import { computeIsoWeekUtc, type WakeCostRecord } from "./record.js";
import { addUSDMicros, ZERO_USD_MICROS, type USDMicros } from "./usd.js";

/** Construction parameters for {@link WakeCostBuilder.start}. */
export interface WakeCostBuilderInit {
  readonly wakeId: WakeId;
  readonly agentId: AgentId;
  readonly modelTier: ModelTier;
  readonly groupIds: readonly string[];
  readonly ceiling?: BudgetCeiling | null;
  /** For tests — defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

/** Mid-wake snapshot returned by {@link WakeCostBuilder.snapshotTotals}. */
export interface WakeCostSnapshot {
  readonly wallClockMs: number;
  readonly costMicros: USDMicros;
  readonly apiCalls: number;
}

/** Mutable accumulator for one wake's cost record. */
export class WakeCostBuilder {
  readonly #wakeId: WakeId;
  readonly #agentId: AgentId;
  readonly #modelTier: ModelTier;
  readonly #groupIds: readonly string[];
  readonly #startedAt: Date;
  readonly #ceiling: BudgetCeiling | null;
  readonly #now: () => Date;

  #subprocessUserCpuMicros = 0;
  #subprocessSystemCpuMicros = 0;
  #subprocessMaxRssKb = 0;
  #subprocessRecorded = false;

  #llmInputTokens = 0;
  #llmOutputTokens = 0;
  #llmCacheReadTokens = 0;
  #llmCacheWriteTokens = 0;
  #llmCostMicros: USDMicros = ZERO_USD_MICROS;
  #llmShadowCostMicros: USDMicros | undefined = undefined;
  #llmProvider = "placeholder";
  #llmModel = "phase-1a-stub";

  #ghRest = 0;
  #ghGraphql = 0;
  #ghCacheHits = 0;
  #ghRateLimitRemaining: number | undefined = undefined;

  #finalized: WakeCostRecord | null = null;

  private constructor(init: WakeCostBuilderInit) {
    this.#wakeId = init.wakeId;
    this.#agentId = init.agentId;
    this.#modelTier = init.modelTier;
    this.#groupIds = init.groupIds;
    this.#ceiling = init.ceiling ?? null;
    this.#now = init.now ?? ((): Date => new Date());
    this.#startedAt = this.#now();
  }

  /** Start a new builder. Captures the start time immediately. */
  public static start(init: WakeCostBuilderInit): WakeCostBuilder {
    return new WakeCostBuilder(init);
  }

  /**
   * Record the subprocess resource-usage delta for this wake. Callers
   * compute the delta by capturing `process.resourceUsage()` at spawn
   * and again at exit. Only the highest observed `maxRssKb` is
   * retained across multiple calls.
   */
  public recordSubprocessUsage(delta: {
    readonly userCpuMicros: number;
    readonly systemCpuMicros: number;
    readonly maxRssKb: number;
  }): void {
    this.#assertNotFinalized();
    this.#subprocessUserCpuMicros += delta.userCpuMicros;
    this.#subprocessSystemCpuMicros += delta.systemCpuMicros;
    this.#subprocessMaxRssKb = Math.max(this.#subprocessMaxRssKb, delta.maxRssKb);
    this.#subprocessRecorded = true;
  }

  /** Record a GitHub API call. Phase 1B-d will wire this from `@murmurations-ai/github`. */
  public addGithubCall(call: {
    readonly transport: "rest" | "graphql";
    readonly cacheHit?: boolean;
    readonly rateLimitRemaining?: number;
  }): void {
    this.#assertNotFinalized();
    if (call.cacheHit === true) {
      this.#ghCacheHits += 1;
    } else if (call.transport === "rest") {
      this.#ghRest += 1;
    } else {
      this.#ghGraphql += 1;
    }
    if (call.rateLimitRemaining !== undefined) {
      this.#ghRateLimitRemaining = call.rateLimitRemaining;
    }
  }

  /** Record an LLM inference. Phase 2 will wire this from the LLM client. */
  public addLlmTokens(usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
    readonly modelProvider: string;
    readonly modelName: string;
    readonly costMicros: USDMicros;
    /**
     * Optional shadow API cost for subscription-CLI calls. When set, this
     * call's actual cost is $0 (subscription) and shadowCostMicros records
     * what it *would* have cost on the equivalent API path. Direct API
     * calls leave this undefined.
     */
    readonly shadowCostMicros?: USDMicros;
  }): void {
    this.#assertNotFinalized();
    this.#llmInputTokens += usage.inputTokens;
    this.#llmOutputTokens += usage.outputTokens;
    this.#llmCacheReadTokens += usage.cacheReadTokens ?? 0;
    this.#llmCacheWriteTokens += usage.cacheWriteTokens ?? 0;
    this.#llmCostMicros = addUSDMicros(this.#llmCostMicros, usage.costMicros);
    if (usage.shadowCostMicros !== undefined) {
      this.#llmShadowCostMicros = addUSDMicros(
        this.#llmShadowCostMicros ?? ZERO_USD_MICROS,
        usage.shadowCostMicros,
      );
    }
    this.#llmProvider = usage.modelProvider;
    this.#llmModel = usage.modelName;
  }

  /**
   * Non-destructive totals snapshot. Used mid-wake by subsystems that
   * want to evaluate the builder against a {@link BudgetCeiling}
   * without finalizing the record.
   */
  public snapshotTotals(): WakeCostSnapshot {
    return {
      wallClockMs: Math.max(0, this.#now().getTime() - this.#startedAt.getTime()),
      costMicros: this.#llmCostMicros,
      apiCalls: this.#ghRest + this.#ghGraphql,
    };
  }

  /**
   * Evaluate the current totals against the builder's ceiling, if any.
   * Returns `null` if no ceiling was configured.
   */
  public evaluateBudget(): BudgetGateResult | null {
    if (this.#ceiling === null) return null;
    return evaluateBudgetCeiling(this.#ceiling, this.snapshotTotals());
  }

  /**
   * Produce the immutable record. Idempotent on the returned value:
   * calling `finalize()` twice returns the same record (memoized).
   * After finalize, mutator methods throw.
   */
  public finalize(finishedAt?: Date): WakeCostRecord {
    if (this.#finalized !== null) return this.#finalized;
    const finished = finishedAt ?? this.#now();
    const wallClockMs = Math.max(0, finished.getTime() - this.#startedAt.getTime());
    const apiCalls = this.#ghRest + this.#ghGraphql;
    const budgetResult = this.#ceiling
      ? evaluateBudgetCeiling(this.#ceiling, {
          wallClockMs,
          costMicros: this.#llmCostMicros,
          apiCalls,
        })
      : null;

    const record: WakeCostRecord = {
      schemaVersion: 1,
      wakeId: this.#wakeId,
      agentId: this.#agentId,
      modelTier: this.#modelTier,
      startedAt: this.#startedAt,
      finishedAt: finished,
      wallClockMs,
      subprocess: this.#subprocessRecorded
        ? {
            userCpuMicros: this.#subprocessUserCpuMicros,
            systemCpuMicros: this.#subprocessSystemCpuMicros,
            maxRssKb: this.#subprocessMaxRssKb,
          }
        : undefined,
      llm: {
        inputTokens: this.#llmInputTokens,
        outputTokens: this.#llmOutputTokens,
        cacheReadTokens: this.#llmCacheReadTokens,
        cacheWriteTokens: this.#llmCacheWriteTokens,
        modelProvider: this.#llmProvider,
        modelName: this.#llmModel,
        costMicros: this.#llmCostMicros,
        shadowCostMicros: this.#llmShadowCostMicros,
      },
      github: {
        restCalls: this.#ghRest,
        graphqlCalls: this.#ghGraphql,
        cacheHits: this.#ghCacheHits,
        rateLimitRemaining: this.#ghRateLimitRemaining,
      },
      totals: {
        costMicros: this.#llmCostMicros,
        apiCalls,
      },
      budget: budgetResult,
      rollupHints: {
        dayUtc: this.#startedAt.toISOString().slice(0, 10),
        isoWeekUtc: computeIsoWeekUtc(this.#startedAt),
        groupIds: this.#groupIds,
      },
    };
    this.#finalized = record;
    return record;
  }

  #assertNotFinalized(): void {
    if (this.#finalized !== null) {
      throw new Error("WakeCostBuilder: cannot mutate after finalize()");
    }
  }
}
