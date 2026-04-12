/**
 * InProcessExecutor — runs the wake as a function call inside the
 * daemon process instead of forking a subprocess. The distinguishing
 * property is that per-wake clients (LLM, GitHub) can be handed
 * directly to the agent runner, with the cost hook bound to the
 * wake's own `WakeCostBuilder` so every LLM call + every GitHub
 * call flows into the same `WakeCostRecord` the daemon logs.
 *
 * This is the Phase 2D8 unblocker: `SubprocessExecutor` fires child
 * processes against `agent.mjs`, and child processes can't share
 * JS objects with the parent — the composed `LLMClient` and
 * per-agent `GithubClient` the CLI builds at boot never reach the
 * child. The in-process executor closes that gap.
 *
 * **Isolation trade-off.** In-process means a runtime error in the
 * agent throws inside the daemon, and a leaking handle accumulates
 * on the daemon's heap. That's acceptable for Phase 2 where every
 * runner is Source-authored (the Research Agent), not untrusted.
 * `SubprocessExecutor` remains the default for hello-world and for
 * any future untrusted runner.
 */

import { randomUUID } from "node:crypto";

import { WakeCostBuilder } from "../cost/builder.js";
import type { WakeCostRecord } from "../cost/record.js";

import {
  HandleUnknownError,
  InternalExecutorError,
  TimeoutError,
  type AgentExecutor,
  type AgentOutputArtifact,
  type AgentResult,
  type AgentSpawnContext,
  type AgentSpawnHandle,
  type CostActuals,
  type EmittedGovernanceEvent,
  type ExecutorCapabilities,
  type WakeAction,
} from "./index.js";

// ---------------------------------------------------------------------------
// Public seam: AgentRunner, context, result
// ---------------------------------------------------------------------------

/**
 * What an agent runner returns when it finishes a wake. Mirrors the
 * shape the subprocess runner produces via stdio — a human wake
 * summary and structured metadata — but without the stdio
 * serialization step. All three fields are read-only; the executor
 * folds them into the final {@link AgentResult}.
 */
export interface AgentRunnerResult {
  /** The agent-authored wake summary, same role as Spec §7.1 step 4. */
  readonly wakeSummary: string;
  /** Non-governance artifacts produced during the wake. Optional. */
  readonly outputs?: readonly AgentOutputArtifact[];
  /** Governance events the agent emitted during the wake. Optional. */
  readonly governanceEvents?: readonly EmittedGovernanceEvent[];
  /** Structured actions for the harness to execute after the wake. Optional. */
  readonly actions?: readonly WakeAction[];
}

/**
 * Everything the runner function receives: the spawn context the
 * daemon built, a {@link WakeCostBuilder} bound to this wake (so the
 * runner can record GitHub calls or subprocess usage manually if it
 * needs to), an {@link AbortSignal} wired to the executor's kill
 * path, and a caller-supplied `clients` bag that is narrowed at the
 * call site (the core package is deliberately agnostic about the
 * concrete `LLMClient` / `GithubClient` shapes).
 */
export interface AgentRunnerContext<Clients> {
  readonly spawn: AgentSpawnContext;
  readonly costBuilder: WakeCostBuilder;
  readonly signal: AbortSignal;
  readonly clients: Clients;
}

/**
 * An in-process agent runner. Returns {@link AgentRunnerResult} on
 * success; thrown errors become `outcome: "failed"` on the
 * {@link AgentResult}. Respecting the `signal` is the runner's own
 * responsibility — the executor only cancels the abort controller
 * and waits for the promise to resolve, it does not forcibly
 * terminate a runaway runner.
 */
export type AgentRunner<Clients = unknown> = (
  context: AgentRunnerContext<Clients>,
) => Promise<AgentRunnerResult>;

/**
 * Callback the executor invokes once per wake to materialize the
 * concrete client bag. Called AFTER the {@link WakeCostBuilder} is
 * constructed, so the caller can bind LLM and GitHub cost hooks to
 * THIS wake's builder via the ADR-0014 `makeDaemonHook` pattern.
 */
export type ResolveRunnerClients<Clients> = (args: {
  readonly agentId: string;
  readonly wakeId: string;
  readonly costBuilder: WakeCostBuilder;
}) => Clients;

/**
 * Callback the executor invokes to resolve which runner function to
 * call for a given agent. Separate from the clients resolver so the
 * two can be swapped independently (tests inject fake runners; prod
 * boot loads them via dynamic import).
 */
export type ResolveRunner<Clients = unknown> = (args: {
  readonly agentId: string;
}) => AgentRunner<Clients> | Promise<AgentRunner<Clients>>;

/** Construction options for {@link InProcessExecutor}. */
export interface InProcessExecutorOptions<Clients = unknown> {
  readonly resolveRunner: ResolveRunner<Clients>;
  readonly resolveClients: ResolveRunnerClients<Clients>;
  readonly instanceId?: string;
  /** Clock injection for tests — defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const EXECUTOR_ID_DEFAULT = "in-process" as const;
const EXECUTOR_VERSION = "0.1.0-phase2d" as const;
const HANDLE_KEY = Symbol("murmuration.in-process.handleKey");

type TerminalReason =
  | { readonly kind: "completed"; readonly result: AgentRunnerResult }
  | { readonly kind: "failed"; readonly error: unknown }
  | { readonly kind: "timed-out" }
  | { readonly kind: "killed"; readonly reason: string };

interface WakeRecord {
  readonly context: AgentSpawnContext;
  readonly startedAt: Date;
  readonly costBuilder: WakeCostBuilder;
  readonly abortController: AbortController;
  timeoutHandle: NodeJS.Timeout | undefined;
  settled: boolean;
  readonly terminal: Promise<TerminalReason>;
  resolveTerminal: (reason: TerminalReason) => void;
}

export class InProcessExecutor<Clients = unknown> implements AgentExecutor {
  readonly #resolveRunner: ResolveRunner<Clients>;
  readonly #resolveClients: ResolveRunnerClients<Clients>;
  readonly #instanceId: string;
  readonly #now: () => Date;
  readonly #wakes = new Map<string, WakeRecord>();

  public constructor(options: InProcessExecutorOptions<Clients>) {
    this.#resolveRunner = options.resolveRunner;
    this.#resolveClients = options.resolveClients;
    this.#instanceId = options.instanceId ?? EXECUTOR_ID_DEFAULT;
    this.#now = options.now ?? ((): Date => new Date());
  }

  public capabilities(): ExecutorCapabilities {
    return {
      id: this.#instanceId,
      displayName: "In-Process Executor",
      version: EXECUTOR_VERSION,
      supportsSubprocessIsolation: false,
      supportsInProcess: true,
      supportsResourceLimits: false,
      supportsKill: true,
      capturesStdio: false,
      supportsConcurrentWakes: true,
      maxConcurrentWakes: "unbounded",
      supportedModelTiers: ["fast", "balanced", "deep"],
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  public async spawn(context: AgentSpawnContext): Promise<AgentSpawnHandle> {
    const startedAt = this.#now();

    let resolveTerminal!: (reason: TerminalReason) => void;
    const terminal = new Promise<TerminalReason>((resolve) => {
      resolveTerminal = resolve;
    });

    const costBuilder = WakeCostBuilder.start({
      wakeId: context.wakeId,
      agentId: context.agentId,
      modelTier: context.budget.model.tier,
      groupIds: context.identity.frontmatter.groupMemberships.map((c) => c.value),
      ceiling: null,
    });

    const abortController = new AbortController();

    const record: WakeRecord = {
      context,
      startedAt,
      costBuilder,
      abortController,
      timeoutHandle: undefined,
      settled: false,
      terminal,
      resolveTerminal,
    };

    // Wall-clock budget — when it elapses we abort the runner and
    // resolve the terminal with `timed-out`. The runner is expected
    // to observe its own `signal`; if it doesn't, the wake resolves
    // whenever the runner eventually finishes, but the outcome is
    // still marked `timed-out` because the terminal was captured at
    // the deadline.
    if (context.budget.maxWallClockMs > 0) {
      record.timeoutHandle = setTimeout(() => {
        if (record.settled) return;
        record.settled = true;
        abortController.abort(
          new TimeoutError("wall-clock budget exceeded", {
            wakeId: context.wakeId,
            budget: context.budget,
          }),
        );
        resolveTerminal({ kind: "timed-out" });
      }, context.budget.maxWallClockMs);
    }

    const handleKey = randomUUID();
    this.#wakes.set(handleKey, record);

    // Kick off the runner. We intentionally do NOT await here — the
    // interface contract is start-and-return. `waitForCompletion`
    // observes the shared `terminal` promise.
    void this.#runInBackground(record);

    const handle: AgentSpawnHandle = {
      kind: "agent-spawn-handle",
      wakeId: context.wakeId,
      agentId: context.agentId,
      startedAt,
      __executor: this.#instanceId,
      ...({ [HANDLE_KEY]: handleKey } as Record<symbol, string>),
    };
    return handle;
  }

  async #runInBackground(record: WakeRecord): Promise<void> {
    try {
      const runner = await this.#resolveRunner({
        agentId: record.context.agentId.value,
      });
      const clients = this.#resolveClients({
        agentId: record.context.agentId.value,
        wakeId: record.context.wakeId.value,
        costBuilder: record.costBuilder,
      });
      const result = await runner({
        spawn: record.context,
        costBuilder: record.costBuilder,
        signal: record.abortController.signal,
        clients,
      });
      if (record.settled) return; // already timed out or killed
      record.settled = true;
      clearWakeTimeout(record);
      record.resolveTerminal({ kind: "completed", result });
    } catch (error) {
      if (record.settled) return;
      record.settled = true;
      clearWakeTimeout(record);
      record.resolveTerminal({ kind: "failed", error });
    }
  }

  public async waitForCompletion(handle: AgentSpawnHandle): Promise<AgentResult> {
    const record = this.#lookup(handle);
    const terminal = await record.terminal;
    this.#wakes.delete(getHandleKey(handle));

    const finishedAt = this.#now();
    const costRecord = record.costBuilder.finalize(finishedAt);
    const cost = actualsFromCostRecord(costRecord, record.startedAt, finishedAt);

    switch (terminal.kind) {
      case "completed": {
        return {
          wakeId: record.context.wakeId,
          agentId: record.context.agentId,
          outcome: { kind: "completed" },
          outputs: terminal.result.outputs ?? [],
          governanceEvents: terminal.result.governanceEvents ?? [],
          actions: terminal.result.actions ?? [],
          actionReceipts: [],
          cost,
          costRecord,
          wakeSummary: terminal.result.wakeSummary,
          startedAt: record.startedAt,
          finishedAt,
        };
      }
      case "failed": {
        const message =
          terminal.error instanceof Error ? terminal.error.message : String(terminal.error);
        return {
          wakeId: record.context.wakeId,
          agentId: record.context.agentId,
          outcome: {
            kind: "failed",
            error: new InternalExecutorError(`in-process runner threw: ${message}`, {
              wakeId: record.context.wakeId,
              cause: terminal.error,
            }),
          },
          outputs: [],
          governanceEvents: [],
          actions: [],
          actionReceipts: [],
          cost,
          costRecord,
          wakeSummary: "",
          startedAt: record.startedAt,
          finishedAt,
        };
      }
      case "timed-out": {
        return {
          wakeId: record.context.wakeId,
          agentId: record.context.agentId,
          outcome: { kind: "timed-out", budget: record.context.budget },
          outputs: [],
          governanceEvents: [],
          actions: [],
          actionReceipts: [],
          cost,
          costRecord,
          wakeSummary: "",
          startedAt: record.startedAt,
          finishedAt,
        };
      }
      case "killed": {
        return {
          wakeId: record.context.wakeId,
          agentId: record.context.agentId,
          outcome: { kind: "killed", reason: terminal.reason },
          outputs: [],
          governanceEvents: [],
          actions: [],
          actionReceipts: [],
          cost,
          costRecord,
          wakeSummary: "",
          startedAt: record.startedAt,
          finishedAt,
        };
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  public async kill(handle: AgentSpawnHandle, reason: string): Promise<void> {
    let record: WakeRecord;
    try {
      record = this.#lookup(handle);
    } catch (err) {
      if (err instanceof HandleUnknownError) return;
      throw err;
    }
    if (record.settled) return;
    record.settled = true;
    clearWakeTimeout(record);
    record.abortController.abort(new Error(`killed: ${reason}`));
    record.resolveTerminal({ kind: "killed", reason });
  }

  #lookup(handle: AgentSpawnHandle): WakeRecord {
    if (handle.__executor !== this.#instanceId) {
      throw new HandleUnknownError(
        `handle was minted by a different executor (expected ${this.#instanceId}, got ${handle.__executor})`,
        { wakeId: handle.wakeId },
      );
    }
    const key = getHandleKey(handle);
    const record = this.#wakes.get(key);
    if (!record) {
      throw new HandleUnknownError("unknown in-process handle", { wakeId: handle.wakeId });
    }
    return record;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const getHandleKey = (handle: AgentSpawnHandle): string => {
  const key = (handle as unknown as Record<symbol, unknown>)[HANDLE_KEY];
  if (typeof key !== "string") {
    throw new HandleUnknownError("handle has no tracking key", { wakeId: handle.wakeId });
  }
  return key;
};

const clearWakeTimeout = (record: WakeRecord): void => {
  if (record.timeoutHandle) {
    clearTimeout(record.timeoutHandle);
    record.timeoutHandle = undefined;
  }
};

const actualsFromCostRecord = (
  record: WakeCostRecord,
  startedAt: Date,
  finishedAt: Date,
): CostActuals => ({
  inputTokens: record.llm.inputTokens,
  outputTokens: record.llm.outputTokens,
  wallClockMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
  costMicros: record.totals.costMicros.value,
  budgetOverrunEvents: record.budget?.overrunEvents ?? 0,
});
