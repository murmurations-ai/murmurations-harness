/**
 * Daemon — the long-running process that ties Scheduler + Executor
 * together. Phase 1A minimum: it instantiates a {@link Scheduler}, a
 * {@link AgentExecutor}, registers a list of agents, and fires wakes on
 * schedule.
 *
 * Clean shutdown: SIGINT/SIGTERM triggers `Daemon.stop()` which waits
 * for in-flight wakes to settle (best-effort) and clears scheduled
 * timers.
 *
 * Spec §4 architecture diagram, §15 Phase 1 gate.
 */

import { formatUSDMicros } from "../cost/usd.js";
import { RunArtifactWriter } from "./runs.js";
import {
  isCompleted,
  isFailed,
  isKilled,
  isTimedOut,
  makeAgentId,
  makeCircleId,
  makeWakeId,
  type AgentExecutor,
  type AgentResult,
  type AgentSpawnContext,
  type CircleId,
  type CostBudget,
  type IdentityChain,
  type ResolvedModel,
  type SignalBundle,
} from "../execution/index.js";
import type { LoadedAgentIdentity } from "../identity/index.js";
import {
  REDACT,
  scrubLogRecord,
  type SecretDeclaration,
  type SecretsProvider,
} from "../secrets/index.js";
import {
  TimerScheduler,
  type Scheduler,
  type ScheduledWakeEvent,
  type WakeTrigger,
} from "../scheduler/index.js";
import type { SignalAggregator } from "../signals/index.js";

// ---------------------------------------------------------------------------
// Agent registry (Phase 1A: hardcoded inline; Phase 1B: loaded from disk)
// ---------------------------------------------------------------------------

/**
 * A single registered agent the daemon is willing to wake. Holds
 * everything the daemon needs to build an {@link AgentSpawnContext}
 * for this agent without re-reading the repo on every wake.
 *
 * Two construction paths:
 *
 * 1. Manual construction — used by the hello-world Phase 1A path
 *    where content is inline placeholder strings (see
 *    `packages/cli/src/boot.ts`).
 * 2. {@link registeredAgentFromLoadedIdentity} — construct from an
 *    `IdentityLoader.load()` result plus a wake trigger. Use this in
 *    Phase 1B+ production paths where identity is read from disk.
 */
export interface RegisteredAgent {
  readonly agentId: string;
  readonly displayName: string;
  readonly trigger: WakeTrigger;
  readonly circleMemberships: readonly string[];
  readonly modelTier: "fast" | "balanced" | "deep";
  /**
   * The identity content layers to thread through to the executor.
   * Populated either inline (Phase 1A) or by
   * {@link registeredAgentFromLoadedIdentity} (Phase 1B+).
   */
  readonly identityContent: {
    readonly murmurationSoul: string;
    readonly agentSoul: string;
    readonly agentRole: string;
    readonly circleContexts: readonly {
      readonly circleId: string;
      readonly content: string;
    }[];
  };
  /**
   * Maximum wall-clock budget per wake (ms). Phase 1A default is 15s;
   * Phase 1B reads from frontmatter.
   */
  readonly maxWallClockMs: number;

  // -------------------------------------------------------------------
  // ADR-0016 extensions (Phase 2C)
  // -------------------------------------------------------------------

  /**
   * LLM pin from `role.md`. Undefined for non-LLM agents (hello-world
   * stays unchanged). The CLI boot path uses this to instantiate the
   * per-agent LLMClient.
   */
  readonly llm?: {
    readonly provider: "gemini" | "anthropic" | "openai" | "ollama";
    readonly model?: string;
  };

  /**
   * Per-agent signal scoping. If absent, daemon-level aggregator
   * defaults apply. See CF-signals-C and ADR-0016.
   */
  readonly signalScopes?: {
    readonly sources: readonly string[];
    readonly githubScopes?: readonly {
      readonly owner: string;
      readonly repo: string;
      readonly filter: {
        readonly state: "open" | "closed" | "all";
        readonly sinceDays?: number;
        readonly labels?: readonly string[];
      };
    }[];
  };

  /**
   * Least-privilege GitHub write surface. Empty arrays mean read-only.
   * Enforced at the github client layer by harness#16 (P5) —
   * declaration surfaces here.
   */
  readonly githubWriteScopes: {
    readonly issueComments: readonly string[];
    readonly branchCommits: readonly {
      readonly repo: string;
      readonly paths: readonly string[];
    }[];
    readonly labels: readonly string[];
  };

  /**
   * Absolute path (resolved) to the wake prompt file. Undefined for
   * hello-world. The agent runner reads this and hands it to the
   * LLMClient.
   */
  readonly promptPath?: string;

  /**
   * Budget ceiling input per ADR-0011. The daemon constructs a
   * `CostBudget` from these values plus the resolved model. Zero
   * values mean "fall back to daemon-level ceiling".
   */
  readonly budget: {
    readonly maxCostMicros: number;
    readonly maxGithubApiCalls: number;
    readonly onBreach: "warn" | "abort";
  };

  /**
   * Secret declarations to union into the daemon's SecretDeclaration
   * at boot per ADR-0010.
   */
  readonly secrets: {
    readonly required: readonly string[];
    readonly optional: readonly string[];
  };
}

/**
 * Construct a {@link RegisteredAgent} from a loaded identity chain.
 * The resulting registration can be passed directly to
 * {@link DaemonConfig.agents}.
 *
 * The wake trigger must be provided separately — it comes from
 * either the role frontmatter (parsed elsewhere) or a daemon-owned
 * registry. For Phase 1B this is called by the CLI boot path after
 * it reads the agent directory listing.
 */
export const registeredAgentFromLoadedIdentity = (
  loaded: LoadedAgentIdentity,
  trigger: WakeTrigger,
  options: { readonly rolePath?: string } = {},
): RegisteredAgent => {
  const { chain, frontmatter } = loaded;
  const circleContexts = chain.layers
    .filter(
      (l): l is Extract<(typeof chain.layers)[number], { kind: "circle-context" }> =>
        l.kind === "circle-context",
    )
    .map((l) => ({ circleId: l.circleId.value, content: l.content }));

  const murmurationSoul = chain.layers.find((l) => l.kind === "murmuration-soul")?.content ?? "";
  const agentSoul = chain.layers.find((l) => l.kind === "agent-soul")?.content ?? "";
  const agentRole = chain.layers.find((l) => l.kind === "agent-role")?.content ?? "";

  // ADR-0016: map snake_case YAML fields to camelCase runtime fields.
  const llm = frontmatter.llm
    ? {
        provider: frontmatter.llm.provider,
        ...(frontmatter.llm.model !== undefined ? { model: frontmatter.llm.model } : {}),
      }
    : undefined;

  const signalScopes =
    frontmatter.signals.github_scopes !== undefined
      ? {
          sources: frontmatter.signals.sources,
          githubScopes: frontmatter.signals.github_scopes.map((s) => ({
            owner: s.owner,
            repo: s.repo,
            filter: {
              state: s.filter.state,
              ...(s.filter.since_days !== undefined ? { sinceDays: s.filter.since_days } : {}),
              ...(s.filter.labels !== undefined ? { labels: s.filter.labels } : {}),
            },
          })),
        }
      : { sources: frontmatter.signals.sources };

  const githubWriteScopes = {
    issueComments: frontmatter.github.write_scopes.issue_comments,
    branchCommits: frontmatter.github.write_scopes.branch_commits.map((b) => ({
      repo: b.repo,
      paths: b.paths,
    })),
    labels: frontmatter.github.write_scopes.labels,
  };

  const promptPath =
    frontmatter.prompt.ref !== undefined && options.rolePath !== undefined
      ? resolveRolePath(options.rolePath, frontmatter.prompt.ref)
      : undefined;

  const budget = {
    maxCostMicros: frontmatter.budget.max_cost_micros,
    maxGithubApiCalls: frontmatter.budget.max_github_api_calls,
    onBreach: frontmatter.budget.on_breach,
  };

  const secrets = {
    required: frontmatter.secrets.required,
    optional: frontmatter.secrets.optional,
  };

  return {
    agentId: chain.agentId.value,
    displayName: frontmatter.name,
    trigger,
    circleMemberships: frontmatter.circle_memberships,
    modelTier: frontmatter.model_tier,
    identityContent: {
      murmurationSoul,
      agentSoul,
      agentRole,
      circleContexts,
    },
    maxWallClockMs: frontmatter.max_wall_clock_ms,
    ...(llm !== undefined ? { llm } : {}),
    signalScopes,
    githubWriteScopes,
    ...(promptPath !== undefined ? { promptPath } : {}),
    budget,
    secrets,
  };
};

/**
 * Resolve `prompt.ref` (relative to role.md) to an absolute path.
 * Kept inline to avoid a new helper file for a one-line operation.
 */
const resolveRolePath = (rolePath: string, ref: string): string => {
  // Use the dirname of the role.md file as the base.
  const dir = rolePath.substring(0, Math.max(rolePath.lastIndexOf("/"), 0));
  if (ref.startsWith("/")) return ref;
  if (ref.startsWith("./") || ref.startsWith("../")) {
    // Simple relative resolution without importing node:path — good enough
    // for the hello-world case and Research Agent #1.
    const cleaned = ref.replace(/^\.\//, "");
    return `${dir}/${cleaned}`;
  }
  return `${dir}/${ref}`;
};

// ---------------------------------------------------------------------------
// Daemon configuration
// ---------------------------------------------------------------------------

export interface DaemonConfig {
  readonly executor: AgentExecutor;
  readonly scheduler?: Scheduler;
  readonly agents: readonly RegisteredAgent[];
  /**
   * Optional logger. Defaults to JSON-lines on stdout. Overridable for
   * tests or alternate structured-log sinks.
   */
  readonly logger?: DaemonLogger;
  /**
   * Heartbeat interval in milliseconds. Defaults to 60s. The heartbeat
   * serves two purposes: (1) keeping the event loop alive between
   * scheduled wakes so the daemon doesn't exit spontaneously after the
   * last wake, and (2) emitting a liveness signal to the activity feed.
   * Tests can set this to a small value (e.g. 200ms) but must be
   * prepared for the extra log volume.
   */
  readonly heartbeatMs?: number;
  /**
   * Optional secrets block. If present, `start()` calls
   * `provider.load(declaration)` before scheduling any wakes. A missing
   * required secret causes boot to log `daemon.secrets.load.failed`
   * and refuse to start (the caller should exit with code 78 per the
   * sysexits.h convention for config errors).
   *
   * Ratified as part of Phase 1B step B1 (Security Agent #25).
   */
  readonly secrets?: {
    readonly provider: SecretsProvider;
    readonly declaration: SecretDeclaration;
  };
  /**
   * Optional signal aggregator. If absent, the daemon emits an empty
   * SignalBundle (Phase 1A behavior). If present, the daemon calls
   * `aggregator.aggregate(...)` before each wake's `executor.spawn()`
   * and threads the result into the spawn context.
   *
   * Added in Phase 1B step B4 (Architecture Agent #23).
   */
  readonly signalAggregator?: SignalAggregator;
  /**
   * Optional run artifact writer. If present, the daemon calls
   * `record(result, costRecord)` after every completed wake so the
   * wake summary + cost record land on disk under the configured
   * run root. See Phase 2D step 2D5 and `./runs.ts`.
   */
  readonly runArtifactWriter?: RunArtifactWriter;
}

export interface DaemonLogger {
  info(event: string, data: Record<string, unknown>): void;
  warn(event: string, data: Record<string, unknown>): void;
  error(event: string, data: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------

const DEFAULT_HEARTBEAT_MS = 60_000;

export class Daemon {
  readonly #executor: AgentExecutor;
  readonly #scheduler: Scheduler;
  readonly #agents: readonly RegisteredAgent[];
  readonly #logger: DaemonLogger;
  readonly #inFlight = new Set<Promise<void>>();
  readonly #heartbeatMs: number;
  readonly #secrets:
    | { readonly provider: SecretsProvider; readonly declaration: SecretDeclaration }
    | undefined;
  readonly #signalAggregator: SignalAggregator | undefined;
  readonly #runArtifactWriter: RunArtifactWriter | undefined;
  #heartbeatHandle: NodeJS.Timeout | undefined;
  #running = false;

  public constructor(config: DaemonConfig) {
    this.#executor = config.executor;
    this.#scheduler = config.scheduler ?? new TimerScheduler();
    this.#agents = config.agents;
    this.#logger = config.logger ?? defaultLogger();
    this.#heartbeatMs = config.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.#secrets = config.secrets;
    this.#signalAggregator = config.signalAggregator;
    this.#runArtifactWriter = config.runArtifactWriter;
  }

  /**
   * Load the configured secrets provider (if any), returning `true` on
   * success. On failure, logs `daemon.secrets.load.failed` and returns
   * `false` without starting the daemon. Callers should exit with code
   * 78 (sysexits.h EX_CONFIG) on `false`.
   *
   * Separate from {@link start} so the CLI can inspect the outcome
   * before committing to a daemon lifecycle.
   */
  public async loadSecrets(): Promise<boolean> {
    if (!this.#secrets) return true;
    const { provider, declaration } = this.#secrets;
    const result = await provider.load(declaration);
    if (!result.ok) {
      this.#logger.error("daemon.secrets.load.failed", {
        provider: provider.capabilities().id,
        code: result.error.code,
        message: result.error.message,
      });
      return false;
    }
    this.#logger.info("daemon.secrets.load.ok", {
      provider: provider.capabilities().id,
      loadedCount: result.loadedCount,
      loadedKeys: provider.loadedKeys().map((k) => k.value),
      missingOptional: result.missingOptional.map((k) => k.value),
    });
    return true;
  }

  public start(): void {
    if (this.#running) return;
    this.#running = true;

    this.#logger.info("daemon.boot", {
      agentCount: this.#agents.length,
      executor: this.#executor.capabilities().id,
    });

    this.#scheduler.onWake((event) => this.#handleWake(event));

    for (const agent of this.#agents) {
      this.#scheduler.schedule(makeAgentId(agent.agentId), agent.trigger);
      this.#logger.info("daemon.agent.registered", {
        agentId: agent.agentId,
        trigger: agent.trigger,
      });
    }

    this.#scheduler.start();

    // Heartbeat keeps the event loop alive between scheduled wakes so
    // the daemon does not exit spontaneously after the last wake fires.
    // This is load-bearing for clean-shutdown testing and for real
    // daemons that may have long idle periods between events.
    this.#heartbeatHandle = setInterval(() => {
      if (!this.#running) return;
      this.#logger.info("daemon.heartbeat", {
        inFlight: this.#inFlight.size,
      });
    }, this.#heartbeatMs);

    this.#logger.info("daemon.ready", {
      capabilities: this.#executor.capabilities(),
      heartbeatMs: this.#heartbeatMs,
    });
  }

  public async stop(): Promise<void> {
    if (!this.#running) return;
    this.#running = false;
    this.#logger.info("daemon.shutdown.begin", {
      inFlight: this.#inFlight.size,
    });
    if (this.#heartbeatHandle) {
      clearInterval(this.#heartbeatHandle);
      this.#heartbeatHandle = undefined;
    }
    await this.#scheduler.stop();
    await Promise.allSettled([...this.#inFlight]);
    this.#logger.info("daemon.shutdown.complete", {});
  }

  async #handleWake(event: ScheduledWakeEvent): Promise<void> {
    if (!this.#running) return;

    const agent = this.#agents.find((a) => a.agentId === event.agentId.value);
    if (!agent) {
      this.#logger.warn("daemon.wake.unknownAgent", {
        agentId: event.agentId.value,
        wakeId: event.wakeId.value,
      });
      return;
    }

    const p = this.#runWake(agent, event).finally(() => {
      this.#inFlight.delete(p);
    });
    this.#inFlight.add(p);
    await p;
  }

  async #runWake(agent: RegisteredAgent, event: ScheduledWakeEvent): Promise<void> {
    const context = await buildSpawnContext(agent, event, this.#signalAggregator, this.#logger);
    this.#logger.info("daemon.wake.fire", {
      agentId: agent.agentId,
      wakeId: event.wakeId.value,
      wakeReason: event.wakeReason,
      signalCount: context.signals.signals.length,
      signalWarnings: context.signals.warnings.length,
    });

    try {
      const handle = await this.#executor.spawn(context);
      const result = await this.#executor.waitForCompletion(handle);
      this.#logResult(result);
      if (this.#runArtifactWriter) {
        // Artifact writes are best-effort per 2D5 design — the writer
        // swallows its own errors and reports them via the logger.
        await this.#runArtifactWriter.record(result, result.costRecord, this.#logger);
      }
    } catch (error) {
      this.#logger.error("daemon.wake.error", {
        agentId: agent.agentId,
        wakeId: event.wakeId.value,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #logResult(result: AgentResult): void {
    const base = {
      agentId: result.agentId.value,
      wakeId: result.wakeId.value,
      durationMs: result.finishedAt.getTime() - result.startedAt.getTime(),
      outcome: result.outcome.kind,
      governanceEventCount: result.governanceEvents.length,
      wakeSummary: result.wakeSummary.slice(0, 200),
      cost: result.cost,
    };
    if (isCompleted(result)) {
      this.#logger.info("daemon.wake.completed", base);
    } else if (isFailed(result)) {
      this.#logger.error("daemon.wake.failed", {
        ...base,
        errorCode: result.outcome.error.code,
        errorMessage: result.outcome.error.message,
      });
    } else if (isTimedOut(result)) {
      this.#logger.warn("daemon.wake.timedOut", {
        ...base,
        budget: result.outcome.budget,
      });
    } else if (isKilled(result)) {
      this.#logger.warn("daemon.wake.killed", {
        ...base,
        reason: result.outcome.reason,
      });
    }
    // Cost instrumentation (carry-forward #5, Performance #27). Emitted
    // in addition to the outcome event so outcome and cost consumers
    // can evolve independently.
    const { costRecord } = result;
    if (costRecord !== undefined) {
      this.#logger.info("daemon.wake.cost", {
        schemaVersion: costRecord.schemaVersion,
        wakeId: costRecord.wakeId.value,
        agentId: costRecord.agentId.value,
        modelTier: costRecord.modelTier,
        startedAt: costRecord.startedAt.toISOString(),
        finishedAt: costRecord.finishedAt.toISOString(),
        wallClockMs: costRecord.wallClockMs,
        subprocess: costRecord.subprocess,
        llm: {
          ...costRecord.llm,
          costMicros: costRecord.llm.costMicros.value,
          costUsdFormatted: formatUSDMicros(costRecord.llm.costMicros),
        },
        github: {
          ...costRecord.github,
          rateLimitRemaining: costRecord.github.rateLimitRemaining ?? null,
        },
        totals: {
          costMicros: costRecord.totals.costMicros.value,
          costUsdFormatted: formatUSDMicros(costRecord.totals.costMicros),
          apiCalls: costRecord.totals.apiCalls,
        },
        budget: costRecord.budget,
        rollupHints: costRecord.rollupHints,
      });
      if (costRecord.budget && costRecord.budget.breaches.length > 0) {
        const level: "warn" | "error" = costRecord.budget.aborted ? "error" : "warn";
        this.#logger[level]("daemon.wake.budget.breach", {
          wakeId: costRecord.wakeId.value,
          agentId: costRecord.agentId.value,
          breaches: costRecord.budget.breaches,
          aborted: costRecord.budget.aborted,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const buildSpawnContext = async (
  agent: RegisteredAgent,
  event: ScheduledWakeEvent,
  aggregator: SignalAggregator | undefined,
  logger: DaemonLogger,
): Promise<AgentSpawnContext> => {
  const agentId = makeAgentId(agent.agentId);
  const circleIds: CircleId[] = agent.circleMemberships.map((c) => makeCircleId(c));

  // Phase 1A: a minimal resolved model placeholder. Phase 1B reads
  // murmuration/models.yaml to resolve tier → concrete model.
  const model: ResolvedModel = {
    tier: agent.modelTier,
    provider: "placeholder",
    model: "phase-1a-stub",
    maxTokens: 4096,
  };

  const budget: CostBudget = {
    maxInputTokens: 0,
    maxOutputTokens: 0,
    maxWallClockMs: agent.maxWallClockMs,
    model,
    maxCostMicros: 0,
  };

  const identity: IdentityChain = {
    agentId,
    frontmatter: {
      agentId,
      name: agent.displayName,
      modelTier: agent.modelTier,
      circleMemberships: circleIds,
    },
    layers: [
      {
        kind: "murmuration-soul",
        content: agent.identityContent.murmurationSoul,
        sourcePath: "<phase-1a-placeholder>",
      },
      {
        kind: "agent-soul",
        agentId,
        content: agent.identityContent.agentSoul,
        sourcePath: "<phase-1a-placeholder>",
      },
      {
        kind: "agent-role",
        agentId,
        content: agent.identityContent.agentRole,
        sourcePath: "<phase-1a-placeholder>",
      },
      ...agent.identityContent.circleContexts.map((ctx) => ({
        kind: "circle-context" as const,
        circleId: makeCircleId(ctx.circleId),
        content: ctx.content,
        sourcePath: "<phase-1a-placeholder>",
      })),
    ],
  };

  let signals: SignalBundle;
  if (aggregator) {
    const result = await aggregator.aggregate({
      wakeId: event.wakeId,
      agentId,
      agentDir: agent.agentId,
      frontmatter: {
        agentId,
        name: agent.displayName,
        modelTier: agent.modelTier,
        circleMemberships: circleIds,
      },
      circleMemberships: circleIds,
      wakeReason: event.wakeReason,
      now: new Date(),
    });
    if (result.ok) {
      signals = result.bundle;
    } else {
      logger.warn("daemon.wake.aggregator.error", {
        wakeId: event.wakeId.value,
        agentId: agent.agentId,
        code: result.error.code,
        message: result.error.message,
      });
      signals = {
        wakeId: event.wakeId,
        assembledAt: new Date(),
        signals: [],
        warnings: [`signal aggregator error: ${result.error.code}`],
      };
    }
  } else {
    signals = {
      wakeId: event.wakeId,
      assembledAt: new Date(),
      signals: [],
      warnings: [],
    };
  }

  return {
    wakeId: event.wakeId,
    agentId,
    identity,
    signals,
    wakeReason: event.wakeReason,
    budget,
    environment: {},
  };
};

/**
 * Minimal JSON-lines logger to stdout. As of Phase 1B step B1 (Security
 * Agent #25), the logger applies two redaction layers before
 * serialization:
 *
 *   1. Any field under the {@link REDACT} symbol is stripped entirely.
 *   2. Any string-valued field whose *name* matches the sensitive-name
 *      regex (token, secret, credential, apiKey, …) and whose value is
 *      at least 8 characters is replaced with `"[REDACTED:scrubbed-by-name]"`.
 *
 * The redaction pass is O(n) in the number of top-level fields and adds
 * negligible overhead to a JSON-lines logger that was already iterating
 * the record to serialize it.
 */
const defaultLogger = (): DaemonLogger => {
  const write = (
    level: "info" | "warn" | "error",
    event: string,
    data: Record<string, unknown>,
  ): void => {
    const scrubbed = scrubLogRecord(data);
    const record = {
      ts: new Date().toISOString(),
      level,
      event,
      ...scrubbed,
    };
    process.stdout.write(`${JSON.stringify(record)}\n`);
  };
  return {
    info: (event, data) => write("info", event, data),
    warn: (event, data) => write("warn", event, data),
    error: (event, data) => write("error", event, data),
  };
};

// Re-export the redaction symbol so tests and plugins in downstream
// packages can opt into the symbol-bucket form without reaching into
// `@murmuration/core/secrets`.
export { REDACT };

// Re-export the trigger types + WakeId helper so downstream packages
// (notably the CLI) can construct registrations without reaching into
// execution module internals.
export { makeWakeId };

// Re-export the run-artifact writer surface so the CLI boot path can
// construct one without reaching into internal module paths.
export { RunArtifactWriter } from "./runs.js";
export type { RunArtifactWriterConfig, RunArtifactIndexEntry, RunArtifactLogger } from "./runs.js";
