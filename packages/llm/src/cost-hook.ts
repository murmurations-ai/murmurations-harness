/**
 * Per-call cost hook for the LLM client. Shape is deliberately a
 * subset of what `WakeCostBuilder.addLlmTokens` consumes — the hook
 * does NOT carry `costMicros`, leaving pricing resolution to the
 * daemon-side adapter (`makeDaemonHook`) that wires the LLMClient to
 * a per-wake `WakeCostBuilder` via the ADR-0015 pricing catalog.
 *
 * See ADR-0014 §S2 and ADR-0015 §S7.
 */

import type { ProviderId } from "./types.js";

export interface LLMCostHook {
  onLlmCall(call: {
    readonly provider: ProviderId;
    readonly model: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
  }): void;
}
