/**
 * Package-private `LLMAdapter` interface. `LLMClient` wraps a single
 * adapter; the adapter does the provider-specific request shaping,
 * response parsing, and error mapping.
 *
 * Intentionally NOT exported from the package — adopters cannot
 * implement their own adapters without forking. This may be promoted
 * to a public contract in Phase 3+ if real use cases appear.
 */

import type { LLMClientError } from "../errors.js";
import type { LLMCostHook } from "../cost-hook.js";
import type {
  LLMClientCapabilities,
  LLMRequest,
  LLMResponse,
  ProviderId,
  Result,
} from "../types.js";

export interface ResolvedCallOptions {
  readonly costHook?: LLMCostHook;
  readonly signal?: AbortSignal;
  readonly idempotencyKey?: string;
  /** Agent context for Langfuse telemetry enrichment (ADR-0022 §1). */
  readonly telemetryContext?: {
    readonly agentId: string;
    readonly wakeId: string;
    readonly groupIds: readonly string[];
    readonly wakeMode: string;
  };
}

export interface LLMAdapter {
  readonly providerId: ProviderId;
  readonly modelUsed: string;
  readonly capabilities: LLMClientCapabilities;
  complete(
    request: LLMRequest,
    options: ResolvedCallOptions,
  ): Promise<Result<LLMResponse, LLMClientError>>;
}
