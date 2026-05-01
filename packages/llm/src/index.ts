/**
 * @murmurations-ai/llm
 *
 * Provider-agnostic LLM client for the Murmuration Harness. See:
 * - `docs/adr/0014-llm-client.md` — core design
 * - `docs/adr/0020-vercel-ai-sdk.md` — single-adapter migration
 * - `docs/adr/0025-pluggable-llm-providers.md` — pluggable provider registry
 *
 * The package ships no vendor strings. Callers construct a
 * {@link ProviderRegistry}, register their providers (the CLI ships
 * four built-ins; extensions register more), and pass the registry
 * into {@link createLLMClient} along with an explicit provider id and
 * model.
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
  ToolDefinition,
  ToolCallResult,
} from "./types.js";

// Cost hook
export type { LLMCostHook } from "./cost-hook.js";

// Retry policy
export type { RetryPolicy } from "./retry.js";
export { DEFAULT_RETRY_POLICY } from "./retry.js";

// Provider registry (ADR-0025)
export {
  InvalidProviderDefinitionError,
  ProviderRegistry,
  validateProviderDefinition,
} from "./providers.js";
export type { ProviderCreateOptions, ProviderDefinition } from "./providers.js";

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
export { formatLLMError } from "./errors.js";

// Subscription-CLI provider family (ADR-0034)
export {
  ClaudeCliAdapter,
  CodexCliAdapter,
  GeminiCliAdapter,
  SubprocessAdapter,
  createSubscriptionCliClient,
} from "./providers/subprocess/index.js";
export type {
  AuthError,
  AuthStatus,
  ParseError,
  SpawnError,
  SubprocessAdapterConfig,
  SubprocessError,
  SubprocessLLMAdapter,
  SubscriptionCli,
  SubscriptionCliClientConfig,
  TimeoutError,
} from "./providers/subprocess/index.js";
