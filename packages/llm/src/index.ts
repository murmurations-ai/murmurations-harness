/**
 * @murmurations-ai/llm
 *
 * LLM client for the Murmuration Harness. See `docs/adr/0014-llm-client.md`
 * for the core design and `docs/adr/0025-pluggable-llm-providers.md` for
 * the extensible provider registry.
 */

// Public factory + client interface
export { createLLMClient } from "./client.js";
export type { CallOptions, LLMClient, LLMClientConfig } from "./client.js";

// Domain types
export type {
  KnownProviderId,
  LLMClientCapabilities,
  LLMMessage,
  LLMRequest,
  LLMResponse,
  ModelTier,
  ProviderId,
  Result,
  StopReason,
  ToolDefinition,
  ToolCallResult,
} from "./types.js";
export { KNOWN_PROVIDERS } from "./types.js";

// Cost hook
export type { LLMCostHook } from "./cost-hook.js";

// Retry policy
export type { RetryPolicy } from "./retry.js";
export { DEFAULT_RETRY_POLICY } from "./retry.js";

// Provider registry (ADR-0025)
export {
  InvalidProviderDefinitionError,
  ProviderRegistry,
  createDefaultRegistry,
  defaultRegistry,
  seedDefaultRegistry,
  validateProviderDefinition,
} from "./providers.js";
export type { ProviderCreateOptions, ProviderDefinition } from "./providers.js";

// Model tier resolution (back-compat shims over the default registry)
export { resolveModelForTier, lookupTierTable } from "./tiers.js";

// Provider env-key convention (back-compat shim; prefer ProviderRegistry.envKeyName)
export { providerEnvKeyName } from "./adapters/provider-registry.js";

// Observability (ADR-0020 Phase 4)
export { initLlmTelemetry, shutdownLlmTelemetry } from "./telemetry.js";

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
