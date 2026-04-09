/**
 * Subprocess executor — default {@link AgentExecutor} implementation.
 *
 * Forks a child process per wake. The child process runs an executable
 * the daemon resolved from the agent id (e.g. `node ./agent.js`) and
 * receives the agent spawn context as a JSON blob via the
 * `MURMURATION_SPAWN_CONTEXT` environment variable. It communicates its
 * wake summary and emitted governance events back via stdout as JSON.
 *
 * Phase 1A scope — this is the default executor but is deliberately
 * minimal: no resource limits, no capability gating, no LLM integration.
 * The Phase 2 one-agent proof lands the real one; this one is enough to
 * prove the wake loop structurally.
 *
 * Spec §4.1 (component table), §7 (wake loop).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

import { WakeCostBuilder } from "../cost/builder.js";
import type { WakeCostRecord } from "../cost/record.js";
import {
  HandleUnknownError,
  InternalExecutorError,
  KilledError,
  SpawnError,
  type AgentExecutor,
  type AgentResult,
  type AgentSpawnContext,
  type AgentSpawnHandle,
  type CostActuals,
  type EmittedGovernanceEvent,
  type ExecutorCapabilities,
} from "./index.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Resolver that maps an {@link AgentSpawnContext} to the concrete command
 * the subprocess executor should exec. The daemon configures this at
 * construction time; it is the one piece of agent-specific knowledge the
 * executor needs.
 */
export interface SubprocessCommand {
  readonly command: string;
  readonly args: readonly string[];
  /** Additional environment for the child on top of process.env. */
  readonly env?: Readonly<Record<string, string>>;
  /** Working directory for the child. Defaults to process.cwd(). */
  readonly cwd?: string;
}

/**
 * Function that resolves the executable + args for a given wake. Called
 * on every `spawn()`. Must not throw — return a `SubprocessCommand`
 * describing an executable the daemon owner has authorized to run.
 */
export type SubprocessCommandResolver = (context: AgentSpawnContext) => SubprocessCommand;

/** Constructor options for {@link SubprocessExecutor}. */
export interface SubprocessExecutorOptions {
  readonly resolveCommand: SubprocessCommandResolver;
  /**
   * Optional override for the instance id (used as the handle brand).
   * Defaults to `"subprocess"`. Override in tests to exercise
   * cross-instance handle rejection.
   */
  readonly instanceId?: string;
}

// ---------------------------------------------------------------------------
// Internal bookkeeping
// ---------------------------------------------------------------------------

type TerminalReason =
  | { readonly kind: "exit"; readonly code: number | null; readonly signal: NodeJS.Signals | null }
  | { readonly kind: "error"; readonly error: Error }
  | { readonly kind: "timeout" }
  | { readonly kind: "killed"; readonly reason: string };

interface WakeRecord {
  readonly context: AgentSpawnContext;
  readonly startedAt: Date;
  readonly child: ChildProcess;
  readonly stdoutChunks: string[];
  readonly stderrChunks: string[];
  timeoutHandle: NodeJS.Timeout | undefined;
  settled: boolean;
  /**
   * Resolved once the child has reached a terminal state. Downstream
   * `waitForCompletion` awaits this, then computes the AgentResult.
   */
  readonly terminal: Promise<TerminalReason>;
  resolveTerminal: (reason: TerminalReason) => void;
  /**
   * Cost accumulator for this wake. Closes carry-forward #5 (Performance
   * Agent #27). Populated via `builder.recordSubprocessUsage` in
   * `waitForCompletion` using the delta of `process.resourceUsage()`
   * captured at spawn versus exit.
   */
  readonly costBuilder: WakeCostBuilder;
  readonly rusageAtSpawn: NodeJS.ResourceUsage;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const EXECUTOR_ID_DEFAULT = "subprocess" as const;
const EXECUTOR_VERSION = "0.0.0-phase1a" as const;

/**
 * Default {@link AgentExecutor} that forks one child process per wake.
 */
export class SubprocessExecutor implements AgentExecutor {
  readonly #resolveCommand: SubprocessCommandResolver;
  readonly #instanceId: string;
  readonly #wakes = new Map<string, WakeRecord>();

  public constructor(options: SubprocessExecutorOptions) {
    this.#resolveCommand = options.resolveCommand;
    this.#instanceId = options.instanceId ?? EXECUTOR_ID_DEFAULT;
  }

  public capabilities(): ExecutorCapabilities {
    return {
      id: this.#instanceId,
      displayName: "Subprocess Executor",
      version: EXECUTOR_VERSION,
      supportsSubprocessIsolation: true,
      supportsInProcess: false,
      supportsResourceLimits: false,
      supportsKill: true,
      capturesStdio: true,
      supportsConcurrentWakes: true,
      maxConcurrentWakes: "unbounded",
      supportedModelTiers: ["fast", "balanced", "deep"],
    };
  }

  // The `async` keyword is intentional — `spawn` is declared async on the
  // interface to reserve the right to do async work (e.g. pre-flight capability
  // checks, authentication, resource reservation) in alternative executor
  // implementations. The subprocess variant does all its work synchronously,
  // but we honor the interface contract.
  // eslint-disable-next-line @typescript-eslint/require-await
  public async spawn(context: AgentSpawnContext): Promise<AgentSpawnHandle> {
    const resolved = (() => {
      try {
        return this.#resolveCommand(context);
      } catch (cause) {
        throw new SpawnError("command resolver threw", {
          wakeId: context.wakeId,
          cause,
        });
      }
    })();

    const startedAt = new Date();

    // Resolve promise captured before spawning so listeners can attach
    // synchronously in the same tick.
    let resolveTerminal!: (reason: TerminalReason) => void;
    const terminal = new Promise<TerminalReason>((resolve) => {
      resolveTerminal = resolve;
    });

    let child: ChildProcess;
    try {
      child = spawn(resolved.command, [...resolved.args], {
        cwd: resolved.cwd ?? process.cwd(),
        env: {
          ...process.env,
          ...(resolved.env ?? {}),
          MURMURATION_WAKE_ID: context.wakeId.value,
          MURMURATION_AGENT_ID: context.agentId.value,
          MURMURATION_SPAWN_CONTEXT: serializeContext(context),
          ...context.environment,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (cause) {
      throw new SpawnError(`failed to fork subprocess for agent ${context.agentId.value}`, {
        wakeId: context.wakeId,
        cause,
      });
    }

    const costBuilder = WakeCostBuilder.start({
      wakeId: context.wakeId,
      agentId: context.agentId,
      modelTier: context.budget.model.tier,
      circleIds: context.identity.frontmatter.circleMemberships.map((c) => c.value),
      ceiling: null,
    });
    const rusageAtSpawn = process.resourceUsage();

    const record: WakeRecord = {
      context,
      startedAt,
      child,
      stdoutChunks: [],
      stderrChunks: [],
      timeoutHandle: undefined,
      settled: false,
      terminal,
      resolveTerminal,
      costBuilder,
      rusageAtSpawn,
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      record.stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      record.stderrChunks.push(chunk);
    });

    child.once("error", (error) => {
      if (record.settled) return;
      record.settled = true;
      clearWakeTimeout(record);
      resolveTerminal({ kind: "error", error });
    });

    child.once("exit", (code, signal) => {
      if (record.settled) return;
      record.settled = true;
      clearWakeTimeout(record);
      resolveTerminal({ kind: "exit", code, signal });
    });

    // Enforce wall-clock budget.
    if (context.budget.maxWallClockMs > 0) {
      record.timeoutHandle = setTimeout(() => {
        if (record.settled) return;
        record.settled = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // process already exited
        }
        resolveTerminal({ kind: "timeout" });
      }, context.budget.maxWallClockMs);
    }

    const handleKey = randomUUID();
    this.#wakes.set(handleKey, record);

    const handle: AgentSpawnHandle = {
      kind: "agent-spawn-handle",
      wakeId: context.wakeId,
      agentId: context.agentId,
      startedAt,
      __executor: this.#instanceId,
      // Non-enumerable bookkeeping key so downstream can look up the record.
      // Exposed through a symbol-keyed accessor rather than the public type.
      ...({ [HANDLE_KEY]: handleKey } as Record<symbol, string>),
    };

    return handle;
  }

  public async waitForCompletion(handle: AgentSpawnHandle): Promise<AgentResult> {
    const record = this.#lookup(handle);
    const terminal = await record.terminal;
    this.#wakes.delete(getHandleKey(handle));

    const finishedAt = new Date();
    const stdout = record.stdoutChunks.join("");
    const stderr = record.stderrChunks.join("");
    const { wakeSummary, governanceEvents } = parseChildOutput(stdout);

    // Record the parent-process resource-usage delta captured around the
    // subprocess lifetime. This is an approximation of the child's own
    // cost (Node does not cheaply expose per-child rusage); precision
    // improves in Phase 2 per Performance #27's carry-forward.
    const rusageAtExit = process.resourceUsage();
    record.costBuilder.recordSubprocessUsage({
      userCpuMicros: Math.max(0, rusageAtExit.userCPUTime - record.rusageAtSpawn.userCPUTime),
      systemCpuMicros: Math.max(0, rusageAtExit.systemCPUTime - record.rusageAtSpawn.systemCPUTime),
      maxRssKb: Math.max(0, rusageAtExit.maxRSS),
    });
    const costRecord = record.costBuilder.finalize(finishedAt);
    const cost = actualsFromCostRecord(costRecord, record.startedAt, finishedAt);

    switch (terminal.kind) {
      case "exit": {
        if (terminal.code === 0) {
          return {
            wakeId: record.context.wakeId,
            agentId: record.context.agentId,
            outcome: { kind: "completed" },
            outputs: [],
            governanceEvents,
            cost,
            costRecord,
            wakeSummary: wakeSummary ?? stdout.trim(),
            startedAt: record.startedAt,
            finishedAt,
          };
        }
        const codeStr = terminal.code === null ? "null" : String(terminal.code);
        const signalSuffix = terminal.signal ? ` (signal ${terminal.signal})` : "";
        const stderrSuffix = stderr ? `\nstderr:\n${stderr}` : "";
        const failureMessage = `agent exited with code ${codeStr}${signalSuffix}${stderrSuffix}`;
        return {
          wakeId: record.context.wakeId,
          agentId: record.context.agentId,
          outcome: {
            kind: "failed",
            error: new InternalExecutorError(failureMessage, {
              wakeId: record.context.wakeId,
            }),
          },
          outputs: [],
          governanceEvents,
          cost,
          costRecord,
          wakeSummary: wakeSummary ?? stdout.trim(),
          startedAt: record.startedAt,
          finishedAt,
        };
      }
      case "error": {
        return {
          wakeId: record.context.wakeId,
          agentId: record.context.agentId,
          outcome: {
            kind: "failed",
            error: new SpawnError(terminal.error.message, {
              wakeId: record.context.wakeId,
              cause: terminal.error,
            }),
          },
          outputs: [],
          governanceEvents,
          cost,
          costRecord,
          wakeSummary: wakeSummary ?? "",
          startedAt: record.startedAt,
          finishedAt,
        };
      }
      case "timeout": {
        return {
          wakeId: record.context.wakeId,
          agentId: record.context.agentId,
          outcome: {
            kind: "timed-out",
            budget: record.context.budget,
          },
          outputs: [],
          governanceEvents,
          cost,
          costRecord,
          wakeSummary: wakeSummary ?? stdout.trim(),
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
          governanceEvents,
          cost,
          costRecord,
          wakeSummary: wakeSummary ?? stdout.trim(),
          startedAt: record.startedAt,
          finishedAt,
        };
      }
    }
  }

  // Same rationale as spawn: interface-level async contract held even
  // though the subprocess variant does not actually await anything.
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
    try {
      record.child.kill("SIGTERM");
    } catch {
      // already exited
    }
    record.resolveTerminal({ kind: "killed", reason });
    // Diagnostic reference so tooling can associate the killed outcome
    // with a human-facing reason.
    void new KilledError("wake killed", {
      wakeId: record.context.wakeId,
      reason,
    });
  }

  #lookup(handle: AgentSpawnHandle): WakeRecord {
    if (handle.__executor !== this.#instanceId) {
      throw new HandleUnknownError(
        `handle minted by executor "${handle.__executor}", not "${this.#instanceId}"`,
        { wakeId: handle.wakeId },
      );
    }
    const key = getHandleKey(handle);
    const record = this.#wakes.get(key);
    if (!record) {
      throw new HandleUnknownError(`no in-flight wake for ${handle.wakeId.value}`, {
        wakeId: handle.wakeId,
      });
    }
    return record;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HANDLE_KEY = Symbol("murmuration.subprocess.handleKey");

const getHandleKey = (handle: AgentSpawnHandle): string => {
  const key = (handle as unknown as Record<symbol, unknown>)[HANDLE_KEY];
  if (typeof key !== "string") {
    throw new HandleUnknownError("handle has no tracking key", {
      wakeId: handle.wakeId,
    });
  }
  return key;
};

const clearWakeTimeout = (record: WakeRecord): void => {
  if (record.timeoutHandle) {
    clearTimeout(record.timeoutHandle);
    record.timeoutHandle = undefined;
  }
};

/**
 * Derive the legacy {@link CostActuals} summary from a rich
 * {@link WakeCostRecord}. Both fields ride on every {@link AgentResult};
 * this keeps them in sync rather than computing them independently.
 */
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

/**
 * Parse child stdout for structured wake reporting. Phase 1A protocol:
 *
 *   - Lines beginning with `::wake-summary::` are concatenated as the
 *     agent's wake summary.
 *   - Lines beginning with `::governance::<kind>::` are parsed as
 *     governance events (JSON payload follows).
 *   - Everything else is treated as plain output and also included in
 *     the wake summary if no explicit summary lines appeared.
 *
 * This is a minimal protocol for the hello-world gate. Phase 2 replaces
 * it with a real structured output contract.
 */
const WAKE_SUMMARY_RE = /^::wake-summary:: ?(.*)$/;
const GOVERNANCE_RE = /^::governance::([a-z-]+):: ?(.*)$/;

const parseChildOutput = (
  stdout: string,
): { wakeSummary: string | undefined; governanceEvents: readonly EmittedGovernanceEvent[] } => {
  const lines = stdout.split(/\r?\n/);
  const summaryLines: string[] = [];
  const governanceEvents: EmittedGovernanceEvent[] = [];
  for (const line of lines) {
    const summaryMatch = WAKE_SUMMARY_RE.exec(line);
    if (summaryMatch) {
      summaryLines.push(summaryMatch[1] ?? "");
      continue;
    }
    const governanceMatch = GOVERNANCE_RE.exec(line);
    if (governanceMatch) {
      const kindRaw = governanceMatch[1];
      const payloadRaw = governanceMatch[2] ?? "";
      if (!isGovernanceKind(kindRaw)) continue;
      try {
        const payload: unknown = payloadRaw ? JSON.parse(payloadRaw) : null;
        governanceEvents.push({ kind: kindRaw, payload });
      } catch {
        // Malformed governance line — ignore for Phase 1A.
      }
    }
  }
  return {
    wakeSummary: summaryLines.length > 0 ? summaryLines.join("\n") : undefined,
    governanceEvents,
  };
};

const GOVERNANCE_KINDS = [
  "tension",
  "proposal-opened",
  "notify",
  "autonomous-action",
  "held",
] as const;

const isGovernanceKind = (value: string | undefined): value is EmittedGovernanceEvent["kind"] => {
  if (value === undefined) return false;
  return (GOVERNANCE_KINDS as readonly string[]).includes(value);
};

/**
 * Serialize spawn context for child process env. Keeps only data that's
 * safe to cross the subprocess boundary (no Date instances — ISO strings).
 */
const serializeContext = (context: AgentSpawnContext): string => {
  const safe = {
    wakeId: context.wakeId.value,
    agentId: context.agentId.value,
    wakeReason: context.wakeReason,
    budget: {
      maxInputTokens: context.budget.maxInputTokens,
      maxOutputTokens: context.budget.maxOutputTokens,
      maxWallClockMs: context.budget.maxWallClockMs,
      maxCostMicros: context.budget.maxCostMicros,
      model: context.budget.model,
    },
    identity: {
      agentId: context.identity.agentId.value,
      frontmatter: {
        agentId: context.identity.frontmatter.agentId.value,
        name: context.identity.frontmatter.name,
        modelTier: context.identity.frontmatter.modelTier,
        circleMemberships: context.identity.frontmatter.circleMemberships.map((c) => c.value),
      },
      layerKinds: context.identity.layers.map((l) => l.kind),
    },
    signals: {
      wakeId: context.signals.wakeId.value,
      count: context.signals.signals.length,
      warnings: context.signals.warnings,
    },
  };
  return JSON.stringify(safe);
};
