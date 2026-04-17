/**
 * Public types for the LLM client. The four adapters share this
 * domain model so the `LLMClient` interface is genuinely
 * provider-agnostic.
 */

import type { ModelTier } from "@murmurations-ai/core";

/**
 * Built-in provider identifiers. Extensions (ADR-0025) register
 * additional providers at daemon boot; those get arbitrary string ids.
 */
export const KNOWN_PROVIDERS = ["gemini", "anthropic", "openai", "ollama"] as const;

export type KnownProviderId = (typeof KNOWN_PROVIDERS)[number];

/**
 * Provider identifier. Kept as an open string to support
 * extension-registered providers (Mistral, Groq, Bedrock, Vertex, …).
 * Built-in ids stay auto-completable via the `KnownProviderId` union.
 * The `& {}` trick widens the type without collapsing the known-set
 * literal-ness for autocomplete.
 */
export type ProviderId = KnownProviderId | (string & {});

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

/**
 * A tool the LLM can call during a wake. Uses Zod schemas for input
 * validation, matching Vercel AI SDK's tool() pattern.
 */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  /** Zod schema for input validation. Passed to Vercel's tool(). */
  readonly parameters: unknown; // ZodType at runtime; unknown here to avoid zod import
  readonly execute: (input: Record<string, unknown>) => Promise<unknown>;
}

/** A tool call made by the LLM and its result. */
export interface ToolCallResult {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly result: unknown;
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
  /** Tools the LLM can call during this completion. */
  readonly tools?: readonly ToolDefinition[];
  /** Maximum number of LLM round-trips for tool calling loops. Default: 1 (no loop). */
  readonly maxSteps?: number;
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
  /** Tool calls made during the completion (empty if no tools were used). */
  readonly toolCalls?: readonly ToolCallResult[];
  /** Number of LLM round-trips (1 = no tool loop, >1 = multi-step). */
  readonly steps?: number;
}

/** Declarative description of what a given {@link LLMClient} instance can do. */
export interface LLMClientCapabilities {
  readonly provider?: ProviderId | undefined;
  readonly supportedTiers?: readonly ModelTier[] | undefined;
  readonly supportsStreaming: boolean;
  readonly supportsToolUse: boolean;
  readonly supportsVision?: boolean | undefined;
  readonly supportsJsonMode: boolean;
  readonly maxContextTokens: number;
}

/** Re-exported from @murmurations-ai/core for backwards compatibility. */
export type { Result } from "@murmurations-ai/core";

export type { ModelTier };
