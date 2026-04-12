/**
 * DispatchExecutor — routes AgentExecutor calls to per-agent inner
 * executors based on the agentId in the spawn context or handle.
 *
 * This is the multi-agent composition seam: some agents use
 * SubprocessExecutor (no LLM, subprocess isolation), others use
 * InProcessExecutor (LLM agents, per-wake client handoff). The
 * Daemon doesn't know or care — it sees a single AgentExecutor.
 * DispatchExecutor resolves the right inner executor per wake.
 *
 * Construction: the CLI boot path builds a `Map<string, AgentExecutor>`
 * keyed by agentId and passes it here. If only one executor type
 * is needed (e.g. all agents are subprocess-only), the caller can
 * skip DispatchExecutor entirely and pass the concrete executor
 * directly to the Daemon.
 */

import {
  HandleUnknownError,
  type AgentExecutor,
  type AgentResult,
  type AgentSpawnContext,
  type AgentSpawnHandle,
  type ExecutorCapabilities,
} from "./index.js";

export class DispatchExecutor implements AgentExecutor {
  readonly #executors: ReadonlyMap<string, AgentExecutor>;

  public constructor(executors: ReadonlyMap<string, AgentExecutor>) {
    this.#executors = executors;
  }

  public capabilities(): ExecutorCapabilities {
    // Synthetic merged capabilities — report the union of what's available.
    return {
      id: "dispatch",
      displayName: "Dispatch Executor",
      version: "0.1.0",
      supportsSubprocessIsolation: this.#any((c) => c.supportsSubprocessIsolation),
      supportsInProcess: this.#any((c) => c.supportsInProcess),
      supportsResourceLimits: this.#any((c) => c.supportsResourceLimits),
      supportsKill: this.#every((c) => c.supportsKill),
      capturesStdio: this.#any((c) => c.capturesStdio),
      supportsConcurrentWakes: this.#every((c) => c.supportsConcurrentWakes),
      maxConcurrentWakes: "unbounded",
      supportedModelTiers: ["fast", "balanced", "deep"],
    };
  }

  public async spawn(context: AgentSpawnContext): Promise<AgentSpawnHandle> {
    const executor = this.#resolve(context.agentId.value);
    return executor.spawn(context);
  }

  public async waitForCompletion(handle: AgentSpawnHandle): Promise<AgentResult> {
    // The handle carries __executor which identifies which inner
    // executor minted it. We find the matching one by checking each.
    // In practice the Map is small (< 30 agents) so linear scan is fine.
    for (const executor of this.#executors.values()) {
      if (executor.capabilities().id === handle.__executor) {
        return executor.waitForCompletion(handle);
      }
    }
    throw new HandleUnknownError(
      `dispatch: no executor matches handle.__executor "${handle.__executor}"`,
      { wakeId: handle.wakeId },
    );
  }

  public async kill(handle: AgentSpawnHandle, reason: string): Promise<void> {
    for (const executor of this.#executors.values()) {
      if (executor.capabilities().id === handle.__executor) {
        try {
          return await executor.kill(handle, reason);
        } catch (err) {
          if (err instanceof HandleUnknownError) throw err;
          throw new HandleUnknownError(
            `dispatch: kill failed for handle.__executor "${handle.__executor}": ${err instanceof Error ? err.message : String(err)}`,
            { wakeId: handle.wakeId },
          );
        }
      }
    }
    // Already finished or unknown — idempotent per the interface contract.
  }

  #resolve(agentId: string): AgentExecutor {
    const executor = this.#executors.get(agentId);
    if (!executor) {
      throw new Error(
        `dispatch: no executor registered for agent "${agentId}" (registered: ${[...this.#executors.keys()].join(", ")})`,
      );
    }
    return executor;
  }

  #any(predicate: (caps: ExecutorCapabilities) => boolean): boolean {
    for (const executor of this.#executors.values()) {
      if (predicate(executor.capabilities())) return true;
    }
    return false;
  }

  #every(predicate: (caps: ExecutorCapabilities) => boolean): boolean {
    for (const executor of this.#executors.values()) {
      if (!predicate(executor.capabilities())) return false;
    }
    return true;
  }
}
