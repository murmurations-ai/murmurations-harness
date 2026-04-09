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
  TimerScheduler,
  type Scheduler,
  type ScheduledWakeEvent,
  type WakeTrigger,
} from "../scheduler/index.js";

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
  };
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
  #heartbeatHandle: NodeJS.Timeout | undefined;
  #running = false;

  public constructor(config: DaemonConfig) {
    this.#executor = config.executor;
    this.#scheduler = config.scheduler ?? new TimerScheduler();
    this.#agents = config.agents;
    this.#logger = config.logger ?? defaultLogger();
    this.#heartbeatMs = config.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
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
    const context = buildSpawnContext(agent, event);
    this.#logger.info("daemon.wake.fire", {
      agentId: agent.agentId,
      wakeId: event.wakeId.value,
      wakeReason: event.wakeReason,
    });

    try {
      const handle = await this.#executor.spawn(context);
      const result = await this.#executor.waitForCompletion(handle);
      this.#logResult(result);
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
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const buildSpawnContext = (
  agent: RegisteredAgent,
  event: ScheduledWakeEvent,
): AgentSpawnContext => {
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

  const signals: SignalBundle = {
    wakeId: event.wakeId,
    assembledAt: new Date(),
    signals: [],
    warnings: [],
  };

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
 * Minimal JSON-lines logger to stdout. Replaced in Phase 1B once
 * Performance Agent #27 lands the cost accounting schema.
 */
const defaultLogger = (): DaemonLogger => {
  const write = (
    level: "info" | "warn" | "error",
    event: string,
    data: Record<string, unknown>,
  ): void => {
    const record = {
      ts: new Date().toISOString(),
      level,
      event,
      ...data,
    };
    process.stdout.write(`${JSON.stringify(record)}\n`);
  };
  return {
    info: (event, data) => write("info", event, data),
    warn: (event, data) => write("warn", event, data),
    error: (event, data) => write("error", event, data),
  };
};

// Re-export the trigger types + WakeId helper so downstream packages
// (notably the CLI) can construct registrations without reaching into
// execution module internals.
export { makeWakeId };
