/**
 * Shared retry policy for the LLM adapters. Per-provider defaults
 * differ (Ollama has `maxAttempts: 1` — fail fast on local daemon
 * errors; paid providers get 3-attempt exponential backoff).
 *
 * See ADR-0014 §Retry / rate-limit policy, per provider.
 */

import type { ProviderId } from "./types.js";

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly retryableStatuses: readonly number[];
  readonly honourRetryAfter: boolean;
}

export const DEFAULT_RETRY_POLICY: Record<ProviderId, RetryPolicy> = {
  gemini: {
    maxAttempts: 3,
    baseDelayMs: 500,
    maxDelayMs: 8_000,
    retryableStatuses: [429, 500, 503],
    honourRetryAfter: true,
  },
  anthropic: {
    maxAttempts: 3,
    baseDelayMs: 500,
    maxDelayMs: 8_000,
    retryableStatuses: [429, 500, 529],
    honourRetryAfter: true,
  },
  openai: {
    maxAttempts: 3,
    baseDelayMs: 500,
    maxDelayMs: 8_000,
    retryableStatuses: [429, 500, 503],
    honourRetryAfter: true,
  },
  ollama: {
    maxAttempts: 1,
    baseDelayMs: 0,
    maxDelayMs: 0,
    retryableStatuses: [],
    honourRetryAfter: false,
  },
};

/** Compute a jittered delay for attempt N (1-indexed). */
export const computeDelayMs = (attempt: number, policy: RetryPolicy): number => {
  const base = policy.baseDelayMs * 2 ** (attempt - 1);
  return Math.min(policy.maxDelayMs, base);
};

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
