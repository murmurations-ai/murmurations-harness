/**
 * Public types for the LLM client. The four adapters share this
 * domain model so the `LLMClient` interface is genuinely
 * provider-agnostic.
 */

import type { ModelTier } from "@murmurations-ai/core";

/** Discriminant for the four providers. */
export type ProviderId = "gemini" | "anthropic" | "openai" | "ollama";

/** Terminal state of a completion. Normalized across providers. */
export type StopReason =
  | "stop"
  | "length"
  | "content_policy"
  | "tool_use" // reserved; never returned in Phase 2
  | "unknown";

/** One turn in a conversation. */
export interface LLMMessage {
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
}

/** Input to {@link LLMClient.complete}. */
export interface LLMRequest {
  /** Concrete model id; resolved via tier table if omitted in the client config. */
  readonly model: string;
  readonly messages: readonly LLMMessage[];
  readonly maxOutputTokens: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly stopSequences?: readonly string[];
  /** Optional override for the system prompt; some providers split system from messages. */
  readonly systemPromptOverride?: string;
}

/** Output of a successful completion. */
export interface LLMResponse {
  readonly content: string;
  readonly stopReason: StopReason;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Anthropic prompt-cache support reserved. */
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  /** Provider may rewrite the model id (version pin); this is what actually ran. */
  readonly modelUsed: string;
  readonly providerUsed: ProviderId;
}

/** Declarative description of what a given {@link LLMClient} instance can do. */
export interface LLMClientCapabilities {
  readonly provider: ProviderId;
  readonly supportedTiers: readonly ModelTier[];
  readonly supportsStreaming: false; // Phase 2: always false
  readonly supportsToolUse: false; // Phase 2: always false
  readonly supportsVision: false; // Phase 2: always false
  readonly supportsJsonMode: false; // Phase 2: always false
  readonly maxContextTokens: number;
}

/** Re-exported from @murmurations-ai/core for backwards compatibility. */
export type { Result } from "@murmurations-ai/core";

export type { ModelTier };
