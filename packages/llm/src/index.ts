/**
 * @murmurations-ai/llm
 *
 * Four-provider LLM client for the Murmuration Harness. See
 * `docs/adr/0014-llm-client.md` for the full rationale.
 */

// Public factory + client interface
export { createLLMClient } from "./client.js";
export type { CallOptions, LLMClient, LLMClientConfig } from "./client.js";

// Domain types
export type {
  LLMClientCapabilities,
  LLMMessage,
  LLMRequest,
  LLMResponse,
  ModelTier,
  ProviderId,
  Result,
  StopReason,
} from "./types.js";

// Cost hook
export type { LLMCostHook } from "./cost-hook.js";

// Retry policy
export type { RetryPolicy } from "./retry.js";
export { DEFAULT_RETRY_POLICY } from "./retry.js";

// Model tier resolution
export { MODEL_TIER_TABLE, resolveModelForTier } from "./tiers.js";

// Error taxonomy
export {
  LLMClientError,
  LLMContentPolicyError,
  LLMContextLengthError,
  LLMForbiddenError,
  LLMInternalError,
  LLMParseError,
  LLMProviderOutageError,
  LLMRateLimitError,
  LLMTransportError,
  LLMUnauthorizedError,
  LLMValidationError,
} from "./errors.js";
export type { LLMClientErrorCode, RateLimitScope } from "./errors.js";
