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

import { randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";
import cronParser from "cron-parser";
import { formatUSDMicros } from "../cost/usd.js";
import { RunArtifactWriter, DispatchRunArtifactWriter } from "./runs.js";
import { AgentStateStore } from "../agents/index.js";
// DirectiveStore removed — directives are now GitHub issues.
// The signal aggregator surfaces them via listIssues with the
// "source-directive" label. No daemon-side injection needed.
import {
  isCompleted,
  isFailed,
  isKilled,
  isTimedOut,
  makeAgentId,
  makeGroupId,
  makeWakeId,
  type AgentExecutor,
  type AgentResult,
  type AgentSpawnContext,
  type EmittedGovernanceEvent,
  type GroupId,
  type CostBudget,
  type IdentityChain,
  type ResolvedModel,
  type SignalBundle,
  validateWake,
  amendWakeSummaryWithValidation,
} from "../execution/index.js";
import type { LoadedAgentIdentity } from "../identity/index.js";
import {
  makeSecretKey,
  REDACT,
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
import {
  GovernanceStateStore,
  NoOpGovernancePlugin,
  makeGovernanceStateReader,
  type GovernancePlugin,
} from "../governance/index.js";

/** Circuit breaker: skip wakes after this many consecutive failures. */
const CIRCUIT_BREAKER_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Agent registry (Phase 1A: hardcoded inline; Phase 1B: loaded from disk)
// ---------------------------------------------------------------------------

/**
 * A single registered agent the daemon is willing to wake. Holds
 * everything the daemon needs to build an {@link AgentSpawnContext}
 * for this agent without re-reading the repo on every wake.
 *
 * In production, instances are built by
 * {@link registeredAgentFromLoadedIdentity} from an
 * `IdentityLoader.load()` result plus a wake trigger (see
 * `packages/cli/src/boot.ts`). Tests construct instances directly with
 * an inline `IdentityChain`.
 */
export interface RegisteredAgent {
  readonly agentId: string;
  readonly displayName: string;
  readonly trigger: WakeTrigger;
  readonly groupMemberships: readonly string[];
  readonly modelTier: "fast" | "balanced" | "deep";
  /**
   * The full ordered identity chain handed to the executor on spawn.
   * Built once by {@link registeredAgentFromLoadedIdentity} (or provided
   * directly by tests) and passed through verbatim — subsystems read typed
   * layers (`sourcePath`, `kind`, `groupId`) without re-parsing flat strings.
   */
  readonly identity: IdentityChain;
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
    readonly provider: "gemini" | "anthropic" | "openai" | "ollama" | "subscription-cli";
    readonly model?: string;
    /** ADR-0034: only used when provider is "subscription-cli". */
    readonly cli?: "claude" | "gemini" | "codex";
    /** ADR-0034: subprocess wall-clock timeout (subscription-cli only). */
    readonly timeoutMs?: number;
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
    readonly issues: readonly string[];
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

  /**
   * Tool declarations from role.md frontmatter (ADR-0020 Phase 3).
   * MCP servers are connected at wake time; CLI tools are informational.
   */
  readonly tools: {
    readonly mcp: readonly {
      readonly name: string;
      readonly command: string;
      readonly args: readonly string[];
      readonly env?: Readonly<Record<string, string>>;
      readonly cwd?: string;
    }[];
    readonly cli: readonly string[];
  };

  /**
   * OpenClaw-compatible plugins the agent declares as dependencies
   * (ADR-0023). Today this is declarative — plugins load daemon-wide
   * and all agents see every plugin-contributed tool. Future per-agent
   * gating will consult this field to filter what each agent sees.
   */
  readonly plugins: readonly {
    readonly provider: string;
  }[];
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
    issues: frontmatter.github.write_scopes.issues,
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

  const tools = {
    mcp: frontmatter.tools.mcp.map((s) => ({
      name: s.name,
      command: s.command,
      args: s.args,
      ...(s.env ? { env: s.env } : {}),
      ...(s.cwd ? { cwd: s.cwd } : {}),
    })),
    cli: frontmatter.tools.cli,
  };

  const plugins = frontmatter.plugins.map((p) => ({ provider: p.provider }));

  return {
    agentId: chain.agentId.value,
    displayName: frontmatter.name,
    trigger,
    groupMemberships: frontmatter.group_memberships,
    modelTier: frontmatter.model_tier,
    identity: chain,
    maxWallClockMs: frontmatter.max_wall_clock_ms,
    ...(llm !== undefined ? { llm } : {}),
    signalScopes,
    githubWriteScopes,
    ...(promptPath !== undefined ? { promptPath } : {}),
    budget,
    secrets,
    tools,
    plugins,
  };
};

/**
 * Resolve `prompt.ref` (relative to role.md) to an absolute path.
 * Kept inline to avoid a new helper file for a one-line operation.
 */
const resolveRolePath = (rolePath: string, ref: string): string => {
  const dir = dirname(rolePath);
  const resolved = resolve(dir, ref);
  // Prevent path traversal outside the agent directory.
  if (!resolved.startsWith(dir)) {
    throw new Error(`resolveRolePath: ref "${ref}" escapes agent directory "${dir}"`);
  }
  return resolved;
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
  readonly runArtifactWriter?: RunArtifactWriter | DispatchRunArtifactWriter;
  /**
   * Governance plugin. If absent, defaults to `NoOpGovernancePlugin`
   * which allows every action and discards every governance event.
   * See `governance/index.ts` for the full interface.
   */
  readonly governance?: GovernancePlugin;
  /**
   * Directory for durable governance state persistence. If set, the
   * GovernanceStateStore writes items.jsonl here and restores on
   * daemon restart. Typically `<rootDir>/.murmuration/governance/`.
   */
  readonly governancePersistDir?: string;
  /** Optional sync callbacks for GitHub-backed governance. */
  readonly governanceSync?: import("../governance/index.js").GovernanceSyncCallbacks;
  /**
   * Directive store for Source → agent communication. If present,
   * the daemon injects pending directives into agent signal bundles
   * before each wake. See `directives/index.ts`.
   */
  // directiveStore removed — directives are GitHub issues now.
  /**
   * Agent state store for formal wake lifecycle tracking. If present,
   * the daemon transitions agent state at each lifecycle point:
   * registered → idle → waking → running → completed/failed → idle.
   * The dashboard reads state directly from this store.
   */
  readonly agentStateStore?: AgentStateStore;
  /**
   * Post-wake action executor. If present, the daemon calls this after
   * every completed wake that has `result.actions.length > 0`. The
   * callback validates actions against write scopes and executes them
   * against GitHub (or whatever external system). Returns receipts.
   *
   * Wired by the CLI's boot path to the per-agent GitHub client.
   * The daemon doesn't know about GitHub — it just calls the hook.
   */
  readonly onWakeActions?: (
    agentId: string,
    actions: readonly import("../execution/index.js").WakeAction[],
  ) => Promise<readonly import("../execution/index.js").WakeActionReceipt[]>;
  /**
   * Group configurations for scheduled meetings. If present, the daemon
   * schedules governance checks on each group's governanceCron. When the
   * cron fires and the governance queue has pending items (or expired
   * reviews), the onGovernanceMeetingDue callback is invoked.
   */
  readonly groups?: readonly import("../groups/index.js").GroupConfig[];
  /**
   * Called when a scheduled governance meeting is due for a group.
   * The CLI wires this to the group-wake runner. The daemon provides
   * the group ID and the pending governance items.
   */
  readonly onGovernanceMeetingDue?: (
    groupId: string,
    pendingItems: readonly import("../governance/index.js").GovernanceItem[],
  ) => Promise<void>;
}

// DaemonLogger is now defined in logger.ts. Import for local use + re-export.
import { DaemonLoggerImpl, type DaemonLogger, type LogLevel } from "./logger.js";
export type { DaemonLogger, LogLevel };
export { DaemonLoggerImpl };

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
  readonly #runArtifactWriter: RunArtifactWriter | DispatchRunArtifactWriter | undefined;
  readonly #governance: GovernancePlugin;
  readonly #governanceStore: GovernanceStateStore;
  /**
   * In-memory governance inbox — events routed to `target: "agent"`
   * are queued here by agentId and injected into the target agent's
   * signal bundle on its next wake. Ephemeral (cleared on daemon
   * stop); durable queuing comes with the filesystem governance
   * store (#33).
   */
  readonly #governanceInbox = new Map<string, EmittedGovernanceEvent[]>();
  readonly #agentStateStore: AgentStateStore | undefined;
  readonly #onWakeActions: DaemonConfig["onWakeActions"];
  readonly #groups: readonly import("../groups/index.js").GroupConfig[];
  readonly #onGovernanceMeetingDue: DaemonConfig["onGovernanceMeetingDue"];
  readonly #governanceCronTimers: NodeJS.Timeout[] = [];
  readonly #governanceTimers = new Map<string, NodeJS.Timeout>();
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
    this.#governance = config.governance ?? new NoOpGovernancePlugin();
    this.#agentStateStore = config.agentStateStore;
    this.#onWakeActions = config.onWakeActions;
    this.#groups = config.groups ?? [];
    this.#onGovernanceMeetingDue = config.onGovernanceMeetingDue;
    this.#governanceStore = new GovernanceStateStore({
      ...(config.governancePersistDir ? { persistDir: config.governancePersistDir } : {}),
      ...(config.governanceSync ? { onSync: config.governanceSync } : {}),
    });
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

    // Register the plugin's state graphs, then restore any persisted
    // governance items from disk, then fire the plugin's onDaemonStart.
    for (const graph of this.#governance.stateGraphs()) {
      this.#governanceStore.registerGraph(graph);
    }
    void this.#governanceStore
      .load()
      .then((count) => {
        if (count > 0) {
          this.#logger.info("daemon.governance.restored", {
            plugin: this.#governance.name,
            itemsRestored: count,
          });
          this.#armGovernanceTimeouts();
        }
      })
      .catch(() => {
        /* load is best-effort */
      });
    if (this.#governance.onDaemonStart) {
      void this.#governance.onDaemonStart(this.#governanceStore).catch((err: unknown) => {
        this.#logger.error("daemon.governance.start.failed", {
          plugin: this.#governance.name,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    this.#logger.info("daemon.boot", {
      agentCount: this.#agents.length,
      executor: this.#executor.capabilities().id,
      governance: this.#governance.name,
    });

    this.#scheduler.onWake((event) => this.#handleWake(event));

    // Load persisted agent state, register agents, start scheduler.
    // Load is async but start() is synchronous — the registration +
    // scheduler start happens in the .then() callback so stats from
    // the previous run are restored before register() creates fresh records.
    const doRegisterAndStart = (): void => {
      for (const agent of this.#agents) {
        this.#agentStateStore?.register(agent.agentId, agent.maxWallClockMs);
        this.#agentStateStore?.transition(agent.agentId, "idle");
        this.#scheduler.schedule(makeAgentId(agent.agentId), agent.trigger);
        this.#logger.info("daemon.agent.registered", {
          agentId: agent.agentId,
          trigger: agent.trigger,
        });
      }
      this.#scheduleGovernanceCrons();
      this.#scheduler.start();

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
    };

    if (this.#agentStateStore) {
      void this.#agentStateStore
        .load()
        .then((count) => {
          if (count > 0) {
            this.#logger.info("daemon.agents.restored", { count });
          }
          doRegisterAndStart();
        })
        .catch(() => {
          doRegisterAndStart();
        });
    } else {
      doRegisterAndStart();
    }
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
    for (const timer of this.#governanceTimers.values()) {
      clearTimeout(timer);
    }
    this.#governanceTimers.clear();
    for (const timer of this.#governanceCronTimers) {
      clearInterval(timer);
    }
    this.#governanceCronTimers.length = 0;
    await this.#scheduler.stop();
    await Promise.allSettled([...this.#inFlight]);
    try {
      if (this.#governance.onDaemonStop) {
        await this.#governance.onDaemonStop();
      }
    } catch (err) {
      this.#logger.error("daemon.governance.stop.failed", {
        plugin: this.#governance.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
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

    // Circuit breaker: skip wakes for agents that have failed too many times in a row.
    if (this.#agentStateStore) {
      const record = this.#agentStateStore.getAgent(agent.agentId);
      if (record && record.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        this.#logger.warn("daemon.wake.circuitBreaker", {
          agentId: agent.agentId,
          consecutiveFailures: record.consecutiveFailures,
          threshold: CIRCUIT_BREAKER_THRESHOLD,
          wakeId: event.wakeId.value,
        });
        return;
      }
    }

    const p = this.#runWake(agent, event).finally(() => {
      this.#inFlight.delete(p);
    });
    this.#inFlight.add(p);
    await p;
  }

  async #runWake(agent: RegisteredAgent, event: ScheduledWakeEvent): Promise<void> {
    const baseContext = await buildSpawnContext(
      agent,
      event,
      this.#signalAggregator,
      this.#secrets?.provider,
      this.#logger,
    );

    // Inject any queued governance events from the inbox into the
    // signal bundle as `custom` signals with sourceId
    // "governance-inbox". This is the delivery side of the
    // `target: "agent"` routing — the sending side queues events
    // in #dispatchGovernanceRoute, the receiving side picks them up
    // here on the target agent's next wake.
    const inbox = this.#governanceInbox.get(agent.agentId);
    let context = baseContext;
    if (inbox && inbox.length > 0) {
      this.#governanceInbox.delete(agent.agentId);
      const governanceSignals = inbox.map((evt) => ({
        kind: "custom" as const,
        sourceId: "governance-inbox",
        data: evt,
        id: `gov-${randomUUID()}`,
        trust: "semi-trusted" as const,
        fetchedAt: new Date(),
      }));
      context = {
        ...baseContext,
        signals: {
          ...baseContext.signals,
          signals: [...baseContext.signals.signals, ...governanceSignals],
        },
      };
    }

    // Directives are now GitHub issues with the "source-directive" label.
    // The signal aggregator surfaces them via listIssues — no daemon-side
    // injection needed. Agents see directives as github-issue signals
    // with the "source-directive" label and respond in their wake output.

    this.#logger.info("daemon.wake.fire", {
      agentId: agent.agentId,
      wakeId: event.wakeId.value,
      wakeReason: event.wakeReason,
      signalCount: context.signals.signals.length,
      signalWarnings: context.signals.warnings.length,
    });

    try {
      this.#agentStateStore?.transition(agent.agentId, "waking", event.wakeId.value);
      const handle = await this.#executor.spawn(context);
      this.#agentStateStore?.transition(agent.agentId, "running", event.wakeId.value);
      const result = await this.#executor.waitForCompletion(handle);

      // Execute structured wake actions (Phase 2.4/2.5)
      let actionReceipts: readonly import("../execution/index.js").WakeActionReceipt[] = [];
      if (isCompleted(result) && result.actions.length > 0 && this.#onWakeActions) {
        try {
          actionReceipts = await this.#onWakeActions(agent.agentId, result.actions);
          const succeeded = actionReceipts.filter((r) => r.success).length;
          const failed = actionReceipts.filter((r) => !r.success).length;
          this.#logger.info("daemon.wake.actions", {
            agentId: agent.agentId,
            wakeId: event.wakeId.value,
            total: result.actions.length,
            succeeded,
            failed,
          });
        } catch (err) {
          this.#logger.error("daemon.wake.actions.error", {
            agentId: agent.agentId,
            wakeId: event.wakeId.value,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Post-wake validation — "Did Work" tracking
      const validation = isCompleted(result)
        ? validateWake(
            {
              actionItems: context.signals.actionItems,
              signals: context.signals.signals,
            },
            result,
            actionReceipts,
          )
        : {
            productive: false,
            artifactCount: 0,
            actionItemsAddressed: 0,
            actionItemsAssigned: 0,
            directivesUnaddressed: [],
            reason: "wake did not complete",
          };

      // Boundary 5 Phase 1: surface unaddressed directives.
      //
      // Posture is "operator-visible only" in v0.5.2:
      //   - The wake's `outcome` stays "completed" — circuit-breaker and
      //     idle-wake counters are computed from `outcome` and from
      //     `validation.artifactCount` (governance events count as
      //     artifacts), not from `validation.directivesUnaddressed`.
      //   - A dedicated `daemon.wake.directives.unaddressed` warn log
      //     fires so operators can detect the hallucination pattern.
      //   - The digest is amended at the `record()` call below.
      //
      // No automatic remediation (no failed-outcome, no circuit-breaker
      // increment) — that lands with Phase 2 (#239) when the validator
      // gains structured `directiveRefs` and is hard-to-bypass enough
      // to drive enforcement. v0.5.2 is detection without enforcement.
      if (isCompleted(result) && validation.directivesUnaddressed.length > 0) {
        this.#logger.warn("daemon.wake.directives.unaddressed", {
          agentId: agent.agentId,
          wakeId: event.wakeId.value,
          unaddressed: validation.directivesUnaddressed.map((d) => ({
            issueNumber: d.issueNumber,
            reason: d.reason,
          })),
        });
      }

      if (!validation.productive && isCompleted(result)) {
        this.#logger.info("daemon.wake.idle", {
          agentId: agent.agentId,
          wakeId: event.wakeId.value,
          reason: validation.reason,
          actionItemsAssigned: validation.actionItemsAssigned,
          actionItemsAddressed: validation.actionItemsAddressed,
          directivesUnaddressedCount: validation.directivesUnaddressed.length,
        });
      } else if (isCompleted(result)) {
        this.#logger.info("daemon.wake.validated", {
          agentId: agent.agentId,
          wakeId: event.wakeId.value,
          artifactCount: validation.artifactCount,
          actionItemsAddressed: validation.actionItemsAddressed,
          actionItemsAssigned: validation.actionItemsAssigned,
        });
      }

      // Record outcome in state store
      const outcome = isCompleted(result)
        ? ("success" as const)
        : isFailed(result)
          ? ("failure" as const)
          : isTimedOut(result)
            ? ("timeout" as const)
            : ("killed" as const);
      this.#agentStateStore?.recordWakeOutcome(event.wakeId.value, outcome, {
        costMicros: result.costRecord?.totals.costMicros.value,
        artifactCount: validation.artifactCount,
        ...(isFailed(result) ? { errorMessage: result.outcome.error.message } : {}),
      });

      this.#logResult(result);
      if (this.#runArtifactWriter) {
        // Boundary 5 Phase 1: when the validator found unaddressed directives,
        // amend the digest's wake summary so the discrepancy is visible to
        // operators reading the run record (not just daemon logs).
        const recordedResult: AgentResult =
          isCompleted(result) && validation.directivesUnaddressed.length > 0
            ? {
                ...result,
                wakeSummary: amendWakeSummaryWithValidation(result.wakeSummary, validation),
              }
            : result;
        await this.#runArtifactWriter.record(recordedResult, result.costRecord, this.#logger);
      }

      // Governance event routing — hand emitted events to the plugin,
      // then dispatch each routing decision.
      if (result.governanceEvents.length > 0) {
        try {
          const decisions = await this.#governance.onEventsEmitted(
            {
              wakeId: result.wakeId,
              agentId: result.agentId,
              events: result.governanceEvents,
            },
            makeGovernanceStateReader(this.#governanceStore),
          );
          for (const decision of decisions) {
            if (decision.create) {
              // Plugin requested an item creation. The daemon applies
              // it so plugins never touch the write surface — `createdBy`
              // is derived from the triggering batch, not the plugin.
              try {
                this.#governanceStore.create(
                  decision.create.kind,
                  result.agentId,
                  decision.create.payload,
                  decision.create.reviewAt !== undefined
                    ? { reviewAt: decision.create.reviewAt }
                    : {},
                );
              } catch (err) {
                this.#logger.warn("daemon.governance.create.failed", {
                  wakeId: result.wakeId.value,
                  agentId: result.agentId.value,
                  kind: decision.create.kind,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
            for (const route of decision.routes) {
              this.#dispatchGovernanceRoute(result, decision.event, route);
            }
          }
          // Re-arm timeouts in case the plugin created or advanced
          // governance items during onEventsEmitted.
          this.#armGovernanceTimeouts();
        } catch (err) {
          this.#logger.error("daemon.governance.route.failed", {
            wakeId: result.wakeId.value,
            agentId: result.agentId.value,
            plugin: this.#governance.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (error) {
      this.#agentStateStore?.recordWakeOutcome(event.wakeId.value, "failure", {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      this.#logger.error("daemon.wake.error", {
        agentId: agent.agentId,
        wakeId: event.wakeId.value,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Arm governance timeout timers for all non-terminal items. For each
   * item in the store whose current state has a transition with
   * `timeoutMs`, schedule a timer that auto-fires the transition when
   * the timeout elapses. Called at daemon start (for restored items)
   * and after every governance transition.
   */
  #armGovernanceTimeouts(): void {
    // Clear existing timers and re-arm from scratch. This is O(n)
    // in the number of governance items but n is small (< 100 even
    // for a busy murmuration) and runs infrequently (only on
    // governance events, not on every wake).
    for (const timer of this.#governanceTimers.values()) {
      clearTimeout(timer);
    }
    this.#governanceTimers.clear();

    for (const graph of this.#governanceStore.graphs()) {
      for (const rule of graph.transitions) {
        if (rule.timeoutMs === undefined) continue;
        // Find items in the `from` state for this timeout rule.
        const items = this.#governanceStore.query({ kind: graph.kind, state: rule.from });
        for (const item of items) {
          // Already have a timer? Skip.
          if (this.#governanceTimers.has(item.id)) continue;
          const timer = setTimeout(() => {
            if (!this.#running) return;
            try {
              const updated = this.#governanceStore.transition(item.id, rule.to, "timeout");
              this.#logger.info("daemon.governance.timeout", {
                itemId: item.id,
                kind: item.kind,
                from: rule.from,
                to: rule.to,
                timeoutMs: rule.timeoutMs,
              });
              this.#governance.onTransition?.(
                updated,
                updated.history[updated.history.length - 1]!,
              );
            } catch {
              // Transition may no longer be valid if the item was
              // advanced by another path — that's fine.
            }
            this.#governanceTimers.delete(item.id);
          }, rule.timeoutMs);
          this.#governanceTimers.set(item.id, timer);
        }
      }
    }
  }

  /**
   * Schedule governance meeting checks for groups with governanceCron.
   * Uses setInterval to check periodically (every 60s). When the check
   * fires, it queries the governance store for pending items per group
   * and also checks for expired review dates. If items are pending and
   * the callback is wired, it fires the meeting.
   */
  #scheduleGovernanceCrons(): void {
    if (this.#groups.length === 0 || !this.#onGovernanceMeetingDue) return;

    const groupsWithCron = this.#groups.filter((g) => g.governanceCron);
    if (groupsWithCron.length === 0) return;

    // Track last-fired time per group to avoid double-firing
    const lastFired = new Map<string, number>();

    const checkInterval = setInterval(() => {
      if (!this.#running) return;

      const now = Date.now();
      for (const group of groupsWithCron) {
        try {
          // Use cron-parser to check if the cron has fired since last check
          const interval = cronParser.parseExpression(group.governanceCron!);
          const prev = interval.prev().getTime();
          const last = lastFired.get(group.groupId) ?? 0;

          if (prev <= last) continue; // Already handled this cron tick
          lastFired.set(group.groupId, now);

          // Check governance queue for this group
          const allItems = this.#governanceStore.query();
          const terminalStates = new Set(
            this.#governanceStore.graphs().flatMap((g) => g.terminalStates),
          );
          const pending = allItems.filter((i) => !terminalStates.has(i.currentState));

          // Also check for expired review dates
          const reviewDue = this.#governanceStore.query({ reviewDue: true });

          const meetingItems = [
            ...pending,
            ...reviewDue.filter((r) => !pending.some((p) => p.id === r.id)),
          ];

          if (meetingItems.length === 0) continue;

          this.#logger.info("daemon.governance.meeting.due", {
            groupId: group.groupId,
            pendingCount: pending.length,
            reviewDueCount: reviewDue.length,
            totalItems: meetingItems.length,
          });

          // Fire the callback (non-blocking)
          void this.#onGovernanceMeetingDue!(group.groupId, meetingItems).catch((err: unknown) => {
            this.#logger.error("daemon.governance.meeting.error", {
              groupId: group.groupId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        } catch {
          // cron parse error or other issue — skip this tick
        }
      }
    }, 60_000); // Check every 60 seconds

    this.#governanceCronTimers.push(checkInterval);

    this.#logger.info("daemon.governance.crons.scheduled", {
      groups: groupsWithCron.map((g) => ({ groupId: g.groupId, cron: g.governanceCron })),
    });
  }

  /**
   * Dispatch a single governance routing decision to its target.
   *
   * - `agent` → queue the event in the target agent's governance
   *   inbox; the daemon injects it into the signal bundle on the
   *   agent's next wake.
   * - `source` → log at warn level so it surfaces in the activity
   *   feed. Future: file a GitHub issue or send a notification.
   * - `external` → log the channel + ref for downstream consumers
   *   (Slack, email, webhooks). Extension point — not yet wired.
   * - `discard` → no-op.
   */
  #dispatchGovernanceRoute(
    result: AgentResult,
    event: EmittedGovernanceEvent,
    route: import("../governance/index.js").GovernanceRouteTarget,
  ): void {
    switch (route.target) {
      case "agent": {
        const targetId = route.agentId.value;
        const inbox = this.#governanceInbox.get(targetId) ?? [];
        inbox.push(event);
        this.#governanceInbox.set(targetId, inbox);
        this.#logger.info("daemon.governance.dispatch.agent", {
          from: result.agentId.value,
          to: targetId,
          kind: event.kind,
        });
        break;
      }
      case "source": {
        this.#logger.warn("daemon.governance.dispatch.source", {
          from: result.agentId.value,
          kind: event.kind,
          payload: event.payload,
        });
        break;
      }
      case "external": {
        this.#logger.info("daemon.governance.dispatch.external", {
          from: result.agentId.value,
          kind: event.kind,
          channel: route.channel,
          ref: route.ref,
        });
        break;
      }
      case "discard":
        break;
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

const formatTrigger = (trigger: WakeTrigger): string => {
  switch (trigger.kind) {
    case "cron":
      return `cron: ${trigger.expression}${trigger.tz ? ` (${trigger.tz})` : ""}`;
    case "interval":
      return `interval: ${String(trigger.intervalMs)}ms`;
    case "delay-once":
      return `delay-once: ${String(trigger.delayMs)}ms`;
    default:
      return "unknown";
  }
};

const buildSpawnContext = async (
  agent: RegisteredAgent,
  event: ScheduledWakeEvent,
  aggregator: SignalAggregator | undefined,
  secretsProvider: SecretsProvider | undefined,
  logger: DaemonLogger,
): Promise<AgentSpawnContext> => {
  const agentId = makeAgentId(agent.agentId);
  const groupIds: GroupId[] = agent.groupMemberships.map((c) => makeGroupId(c));

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

  const identity = agent.identity;

  let signals: SignalBundle;
  if (aggregator) {
    const result = await aggregator.aggregate({
      wakeId: event.wakeId,
      agentId,
      agentDir: agent.agentId,
      frontmatter: identity.frontmatter,
      groupMemberships: groupIds,
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
        actionItems: [],
        warnings: [`signal aggregator error: ${result.error.code}`],
      };
    }
  } else {
    signals = {
      wakeId: event.wakeId,
      assembledAt: new Date(),
      signals: [],
      actionItems: [],
      warnings: [],
    };
  }

  return {
    wakeId: event.wakeId,
    agentId,
    identity,
    signals,
    wakeReason: event.wakeReason,
    wakeMode: "individual" as const,
    budget,
    currentSchedule: formatTrigger(agent.trigger),
    capabilities: {
      github: {
        canCommit: agent.githubWriteScopes.branchCommits.length > 0,
        commitPaths: agent.githubWriteScopes.branchCommits.flatMap((b) => b.paths),
        canCommentIssues: agent.githubWriteScopes.issueComments.length > 0,
        canCreateIssues: agent.githubWriteScopes.issues.length > 0,
        canLabelIssues: agent.githubWriteScopes.labels.length > 0,
      },
      cliTools: agent.tools.cli,
      mcpServers: agent.tools.mcp.map((s) => s.name),
      signalSources: agent.signalScopes?.sources ?? [],
    },
    mcpServerConfigs: agent.tools.mcp,
    environment: resolveAgentEnvironment(agent, secretsProvider),
  };
};

/**
 * Build the per-wake environment map from this agent's declared secrets.
 * Required keys that aren't loaded are skipped (boot already refused to
 * start if a required key was missing); optional keys are included only
 * when actually present. Names not in `agent.secrets.{required,optional}`
 * are never read, so the spawn context can't leak unrelated secrets.
 */
const resolveAgentEnvironment = (
  agent: RegisteredAgent,
  provider: SecretsProvider | undefined,
): Readonly<Record<string, string>> => {
  if (!provider) return {};
  const environment: Record<string, string> = {};
  const declared = [...agent.secrets.required, ...agent.secrets.optional];
  for (const name of declared) {
    const key = makeSecretKey(name);
    if (provider.has(key)) {
      environment[name] = provider.get(key).reveal();
    }
  }
  return environment;
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
const defaultLogger = (): DaemonLogger => new DaemonLoggerImpl();

// Re-export the redaction symbol so tests and plugins in downstream
// packages can opt into the symbol-bucket form without reaching into
// `@murmurations-ai/core/secrets`.
export { REDACT };

// Re-export the trigger types + WakeId helper so downstream packages
// (notably the CLI) can construct registrations without reaching into
// execution module internals.
export { makeWakeId };

// Re-export the run-artifact writer surface so the CLI boot path can
// construct one without reaching into internal module paths.
export { RunArtifactWriter, DispatchRunArtifactWriter } from "./runs.js";
export type { RunArtifactWriterConfig, RunArtifactIndexEntry, RunArtifactLogger } from "./runs.js";
