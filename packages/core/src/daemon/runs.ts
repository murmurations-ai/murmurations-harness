/**
 * RunArtifactWriter — Phase 2D5 output capture.
 *
 * After every wake completes (successfully or not), the daemon calls
 * `record(result, costRecord?)` on its configured writer. The writer
 * persists two artifacts under the configured root:
 *
 *   1. `<YYYY-MM-DD>/digest-<YYYY-MM-DDTHH-MM-SSZ>-<wakeIdShort>.md` — the agent-authored
 *      `wakeSummary` string, prefixed with a YAML header containing
 *      the wake's provenance (agent, wake id, outcome, cost). Written
 *      per-wake so multiple wakes on the same date never clobber each
 *      other. The wakeIdShort is the first 8 characters of the UUID,
 *      which is enough for human skimming — the jsonl index holds the
 *      full id for machine consumers.
 *
 *   2. `index.jsonl` — append-only newline-delimited JSON log. One
 *      line per wake, keyed by `wakeId`, carrying provider + model +
 *      token counts + cost micros + github call counts + the digest
 *      path relative to the run root. This is the surface the 2D6
 *      diff tool will consume.
 *
 * Both files live under `<rootDir>/.murmuration/runs/<agentDir>/`
 * where `rootDir` is the identity root the daemon is booted against.
 * The writer is deliberately agent-scoped — dual-run fairness rests
 * on Research Agent #1's runs being isolated from any other agent's
 * runs in the same murmuration, and on the OpenClaw runner producing
 * a compatible index.jsonl at its own path.
 *
 * Failures inside `record` are caught and logged but never thrown.
 * An artifact-write failure must not prevent the daemon from
 * completing the wake cycle — the wake already happened and the cost
 * record already fired via `daemon.wake.cost`. Lost artifacts are
 * recoverable (re-run the wake); a daemon crash mid-wake is not.
 */

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { formatUSDMicros } from "../cost/usd.js";
import type { WakeCostRecord } from "../cost/record.js";
import type { AgentResult, WakeValidationResult } from "../execution/index.js";

/**
 * Audit record for subscription-CLI wakes.
 *
 * Recorded before the subprocess is spawned so the record reflects
 * what was **configured**, not what the subprocess reported. A
 * pre-spawn record is more trustworthy: the subprocess cannot modify
 * it, and it survives even if the subprocess crashes before producing
 * any output.
 */
export interface SubscriptionCliAuditContext {
  /** Which vendor CLI was used. */
  readonly cliName: "claude" | "gemini" | "codex";
  /**
   * Absolute path of the spawned binary, pre-resolved at daemon boot
   * by `resolveCliBinaryPath()`. Falls back to the bare CLI name
   * ("claude", "gemini", "codex") when PATH resolution was skipped
   * (e.g., non-launchd environments where PATH contains the bin dir).
   */
  readonly resolvedPath: string;
  /** Effective ADR-0036 permission mode. */
  readonly permissionMode: "restricted" | "operator-approved" | "trusted";
  /**
   * `--allowedTools` patterns passed to the CLI subprocess. Empty
   * array means no tool restriction was applied (fully open or fully
   * restricted by the CLI's own defaults — see ADR-0036).
   */
  readonly allowedTools: readonly string[];
  /** Always `true` — env allowlist is applied unconditionally. */
  readonly envAllowlistApplied: true;
}

/**
 * Per-wake signal-bundle observability metrics (harness#394 scope 2).
 *
 * Captured at wake fire time from the assembled SignalBundle so dashboards
 * can show which agents are reading the most context per wake.
 */
export interface SignalBundleMetrics {
  /** Count of `github-issue` signals in the bundle. The primary
   *  "signal-bundle load" metric — every open issue lands in every
   *  watching agent's bundle on every wake. */
  readonly issueCount: number;
}

/** Configuration for a {@link RunArtifactWriter}. */
export interface RunArtifactWriterConfig {
  /**
   * Directory under which per-agent run artifacts are rooted. The
   * writer will create `<rootDir>/<YYYY-MM-DD>/` on demand and
   * append to `<rootDir>/index.jsonl`.
   *
   * By convention the daemon passes
   * `<identityRoot>/.murmuration/runs/<agentDir>` for the agent that
   * just completed a wake. Multiple agents in the same murmuration
   * should have distinct writers at distinct roots.
   */
  readonly rootDir: string;
  /**
   * Clock injection point for tests — defaults to `() => new Date()`.
   * The writer uses this for date-folder selection and for the
   * timestamp embedded in the digest header, so fake-time tests can
   * pin the day deterministically.
   */
  readonly now?: () => Date;
  /**
   * Subscription-CLI audit context.
   * When set, every index.jsonl entry written by this writer will
   * include a `subscriptionCli` block. Absent for API-provider agents.
   */
  readonly subscriptionCli?: SubscriptionCliAuditContext;
}

/** Minimal contract so the daemon can log write failures without
 *  taking a hard dep on its own logger shape. */
export interface RunArtifactLogger {
  warn(event: string, data: Record<string, unknown>): void;
}

/**
 * Structured shape of one line in `index.jsonl`. Kept as an exported
 * interface so the 2D6 diff tool and any other consumers get the same
 * type without reading the daemon internals.
 */
export interface RunArtifactIndexEntry {
  readonly schemaVersion: 1;
  readonly wakeId: string;
  readonly agentId: string;
  readonly outcome: "completed" | "failed" | "timed-out" | "killed";
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly modelTier: string;
  readonly llm: {
    readonly provider: string;
    readonly model: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
    readonly costMicros: number;
    readonly costUsdFormatted: string;
    /**
     * Shadow API cost in USD micros for subscription-CLI wakes. `null`
     * when the wake used a direct API provider (its `costMicros` is the
     * real spend). Always set for `claude-cli`/`codex-cli`/`gemini-cli`.
     */
    readonly shadowCostMicros: number | null;
    readonly shadowCostUsdFormatted: string | null;
  };
  readonly github: {
    readonly restCalls: number;
    readonly graphqlCalls: number;
    readonly cacheHits: number;
    readonly rateLimitRemaining: number | null;
  };
  readonly totals: {
    readonly costMicros: number;
    readonly apiCalls: number;
  };
  /** Path to the digest file, relative to the run root. */
  readonly digestPath: string;
  /**
   * Whether the wake was considered productive by `validateWake`.
   * Optional — absent on entries written before Proposal 07 Phase 1.
   */
  readonly productive?: boolean;
  /**
   * Number of artifacts produced (successful action receipts + outputs +
   * governance events). Mirrors `WakeValidationResult.artifactCount`.
   * Near-Term #4 (Proposal 07 Phase 1).
   */
  readonly artifactCount?: number;
  /**
   * Machine-readable validation outcome for dashboard and eval queries.
   * `productive` — wake produced artifacts and addressed any directives.
   * `idle` — wake ran but produced no artifacts.
   * `unaddressed-directives` — one or more source-directives were not
   *   backed by structured evidence.
   * `obligation-unmet` — the role.md `contract.requiredOutputs` had at
   *   least one entry without matching successful evidence.
   * `unknown` — validation data unavailable (legacy entry or failed wake).
   */
  readonly validationStatus?:
    | "productive"
    | "idle"
    | "unaddressed-directives"
    | "obligation-unmet"
    | "unknown";
  /**
   * Count of source-directives that were in the signal bundle but not
   * addressed with a successful action receipt (Boundary 5).
   * `0` means all directives were addressed. Absent when none present.
   */
  readonly directivesUnaddressed?: number;
  /**
   * Contract obligation status. Absent when no contract was supplied
   * (e.g. roles without a `contract:` block).
   */
  readonly obligationStatus?: "satisfied" | "unmet" | "not-applicable";
  /**
   * Number of `requiredOutputs` from the contract that had no matching
   * successful evidence. Populated only when `obligationStatus === "unmet"`.
   */
  readonly unmetRequiredOutputsCount?: number;
  /**
   * Count of behavior warnings emitted by `validateBehavior`. Advisory
   * signal — does NOT affect `productive` or `successfulWakes`.
   * Dashboards surface this as a yellow badge for operator review.
   */
  readonly behaviorWarningCount?: number;
  /**
   * Subscription-CLI audit context. Present on all subscription-CLI
   * wakes; absent for API-provider wakes.
   */
  readonly subscriptionCli?: SubscriptionCliAuditContext;
  /**
   * Per-wake signal-bundle metrics (harness#394 scope 2). Optional so
   * legacy entries written before the metric was added stay readable.
   */
  readonly signalBundle?: SignalBundleMetrics;
}

export class RunArtifactWriter {
  readonly #rootDir: string;
  readonly #now: () => Date;
  readonly #subscriptionCli: SubscriptionCliAuditContext | undefined;

  public constructor(config: RunArtifactWriterConfig) {
    this.#rootDir = config.rootDir;
    this.#now = config.now ?? ((): Date => new Date());
    this.#subscriptionCli = config.subscriptionCli;
  }

  /**
   * Record one wake's artifacts. Catches all I/O errors internally
   * and reports them via the optional logger so the daemon's wake
   * loop is never blocked by a failed write.
   *
   * `validation` is optional so test fixtures and legacy callers
   * continue to work; production daemon wakes always pass it.
   */
  public async record(
    result: AgentResult,
    costRecord: WakeCostRecord | undefined,
    logger?: RunArtifactLogger,
    validation?: WakeValidationResult,
    bundleMetrics?: SignalBundleMetrics,
  ): Promise<void> {
    try {
      const now = this.#now();
      const dayUtc = now.toISOString().slice(0, 10); // YYYY-MM-DD
      const wakeIdShort = result.wakeId.value.slice(0, 8);
      // Full ISO-like timestamp in the filename so TAB completion
      // across all days is self-describing. Colons swapped for hyphens
      // (filesystem-safe on every OS; colons break Windows and show
      // as slashes in macOS Finder). Format:
      //   digest-YYYY-MM-DDTHH-MM-SSZ-<shortId>.md
      const isoStamp = now.toISOString().slice(0, 19).replace(/:/g, "-") + "Z";
      const digestFilename = `digest-${isoStamp}-${wakeIdShort}.md`;
      const digestRelativePath = `${dayUtc}/${digestFilename}`;
      const digestAbsolutePath = join(this.#rootDir, dayUtc, digestFilename);
      const indexAbsolutePath = join(this.#rootDir, "index.jsonl");

      await mkdir(join(this.#rootDir, dayUtc), { recursive: true });

      const digestBody = renderDigestBody(result, costRecord, now);
      await writeFile(digestAbsolutePath, digestBody, "utf8");

      const entry: RunArtifactIndexEntry = buildIndexEntry(
        result,
        costRecord,
        digestRelativePath,
        this.#subscriptionCli,
        validation,
        bundleMetrics,
      );
      // Newline-terminated so readers can stream line-by-line.
      await appendFile(indexAbsolutePath, `${JSON.stringify(entry)}\n`, "utf8");
    } catch (cause) {
      logger?.warn("daemon.runs.write.failed", {
        wakeId: result.wakeId.value,
        agentId: result.agentId.value,
        rootDir: this.#rootDir,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const outcomeKindOf = (result: AgentResult): RunArtifactIndexEntry["outcome"] => {
  switch (result.outcome.kind) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "timed-out":
      return "timed-out";
    case "killed":
      return "killed";
  }
};

/**
 * Compute the dashboard-facing validationStatus from a WakeValidationResult.
 * Precedence: obligation-unmet > unaddressed-directives > idle > productive.
 * Returns undefined when no validation result is supplied (legacy / test
 * callers) — the dashboard treats absent as "unknown".
 */
const computeValidationStatus = (
  validation: WakeValidationResult | undefined,
): RunArtifactIndexEntry["validationStatus"] => {
  if (validation === undefined) return undefined;
  if (validation.obligationStatus === "unmet") return "obligation-unmet";
  if (validation.directivesUnaddressed.length > 0) return "unaddressed-directives";
  if (!validation.productive) return "idle";
  return "productive";
};

const buildIndexEntry = (
  result: AgentResult,
  costRecord: WakeCostRecord | undefined,
  digestRelativePath: string,
  subscriptionCli?: SubscriptionCliAuditContext,
  validation?: WakeValidationResult,
  bundleMetrics?: SignalBundleMetrics,
): RunArtifactIndexEntry => {
  const outcome = outcomeKindOf(result);
  const durationMs = result.finishedAt.getTime() - result.startedAt.getTime();
  const llm = costRecord?.llm;
  const github = costRecord?.github;
  const validationStatus = computeValidationStatus(validation);
  return {
    schemaVersion: 1,
    wakeId: result.wakeId.value,
    agentId: result.agentId.value,
    outcome,
    startedAt: result.startedAt.toISOString(),
    finishedAt: result.finishedAt.toISOString(),
    durationMs,
    modelTier: costRecord?.modelTier ?? "unknown",
    llm: {
      provider: llm?.modelProvider ?? "unknown",
      model: llm?.modelName ?? "unknown",
      inputTokens: llm?.inputTokens ?? 0,
      outputTokens: llm?.outputTokens ?? 0,
      cacheReadTokens: llm?.cacheReadTokens ?? 0,
      cacheWriteTokens: llm?.cacheWriteTokens ?? 0,
      costMicros: llm?.costMicros.value ?? 0,
      costUsdFormatted: llm ? formatUSDMicros(llm.costMicros) : "0.0000",
      shadowCostMicros: llm?.shadowCostMicros ? llm.shadowCostMicros.value : null,
      shadowCostUsdFormatted: llm?.shadowCostMicros ? formatUSDMicros(llm.shadowCostMicros) : null,
    },
    github: {
      restCalls: github?.restCalls ?? 0,
      graphqlCalls: github?.graphqlCalls ?? 0,
      cacheHits: github?.cacheHits ?? 0,
      rateLimitRemaining: github?.rateLimitRemaining ?? null,
    },
    totals: {
      costMicros: costRecord?.totals.costMicros.value ?? 0,
      apiCalls: costRecord?.totals.apiCalls ?? 0,
    },
    digestPath: digestRelativePath,
    ...(subscriptionCli !== undefined ? { subscriptionCli } : {}),
    ...(bundleMetrics !== undefined ? { signalBundle: bundleMetrics } : {}),
    ...(validation !== undefined
      ? {
          productive: validation.productive,
          artifactCount: validation.artifactCount,
          ...(validationStatus !== undefined ? { validationStatus } : {}),
          directivesUnaddressed: validation.directivesUnaddressed.length,
          ...(validation.obligationStatus !== undefined
            ? { obligationStatus: validation.obligationStatus }
            : {}),
          ...(validation.unmetRequiredOutputs !== undefined
            ? { unmetRequiredOutputsCount: validation.unmetRequiredOutputs.length }
            : {}),
          ...(validation.behaviorWarnings !== undefined
            ? { behaviorWarningCount: validation.behaviorWarnings.length }
            : {}),
        }
      : {}),
  };
};

const renderDigestBody = (
  result: AgentResult,
  costRecord: WakeCostRecord | undefined,
  writtenAt: Date,
): string => {
  // YAML-style header followed by the agent's wake summary verbatim.
  // The header holds enough provenance for the diff tool to locate
  // this wake in the index without parsing the filename.
  const outcome = outcomeKindOf(result);
  const llm = costRecord?.llm;
  const provider = llm?.modelProvider ?? "unknown";
  const model = llm?.modelName ?? "unknown";
  const costDisplay = llm ? formatUSDMicros(llm.costMicros) : "0.0000";
  const shadowLine = llm?.shadowCostMicros
    ? `llm_shadow_cost_usd: ${formatUSDMicros(llm.shadowCostMicros)}  # would-be API cost; actual is $0 via subscription\n`
    : "";
  return `---
wake_id: ${result.wakeId.value}
agent_id: ${result.agentId.value}
outcome: ${outcome}
started_at: ${result.startedAt.toISOString()}
finished_at: ${result.finishedAt.toISOString()}
written_at: ${writtenAt.toISOString()}
llm_provider: ${provider}
llm_model: ${model}
llm_cost_usd: ${costDisplay}
${shadowLine}---

${result.wakeSummary}
`;
};

// ---------------------------------------------------------------------------
// Dispatch writer for multi-agent daemons
// ---------------------------------------------------------------------------

/**
 * Routes `record()` calls to per-agent {@link RunArtifactWriter}
 * instances based on the result's `agentId`. The Daemon still sees a
 * single writer; DispatchRunArtifactWriter resolves per-agent writers
 * internally. If no writer is registered for an agentId, the call is
 * silently dropped with a logger warning.
 */
export class DispatchRunArtifactWriter {
  readonly #writers: ReadonlyMap<string, RunArtifactWriter>;

  public constructor(writers: ReadonlyMap<string, RunArtifactWriter>) {
    this.#writers = writers;
  }

  public async record(
    result: AgentResult,
    costRecord: WakeCostRecord | undefined,
    logger?: RunArtifactLogger,
    validation?: WakeValidationResult,
    bundleMetrics?: SignalBundleMetrics,
  ): Promise<void> {
    const writer = this.#writers.get(result.agentId.value);
    if (!writer) {
      logger?.warn("daemon.runs.dispatch.unknown", {
        agentId: result.agentId.value,
        wakeId: result.wakeId.value,
        reason: "no run artifact writer registered for this agent",
      });
      return;
    }
    await writer.record(result, costRecord, logger, validation, bundleMetrics);
  }
}
