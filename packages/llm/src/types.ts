/**
 * Public types for the LLM client. The four adapters share this
 * domain model so the `LLMClient` interface is genuinely
 * provider-agnostic.
 */

import type { ModelTier } from "@murmurations-ai/core";

/**
 * Provider identifier. Any non-empty string registered on a
 * {@link ProviderRegistry} is valid. The harness ships no vendor
 * strings in this package — built-in provider identities live in
 * the CLI's `builtin-providers/` directory (ADR-0025 Phase 3).
 */
export type ProviderId = string;

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
  /**
   * Concrete model id, optional. The Vercel adapter uses the model
   * bound to the LLMClient at construction (`createLLMClient({ model })`)
   * and ignores this field. Callers pass it for observability /
   * downstream logging when known; it is not authoritative routing.
   * harness#252: previously the runner synthesized a Gemini-specific
   * value here, which was both misleading and a latent regression
   * (any future adapter that respected the field would silently swap
   * every agent to a Gemini model name).
   */
  readonly model?: string;
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
  /**
   * v0.7.0 (harness#293): subscription-CLI session resume. When set,
   * the adapter passes the CLI's native resume flag (claude --resume,
   * codex --continue / --session, gemini equivalent) so the vendor
   * keeps its conversation cache warm. Direct API providers (Vercel
   * adapter) ignore this field — their request is fully self-contained.
   *
   * First-turn callers omit this; subsequent turns pass the
   * `sessionId` returned on the previous {@link LLMResponse}.
   */
  readonly sessionId?: string;
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
  /**
   * v0.7.0 (harness#293): the vendor's session/conversation id captured
   * from the response. Subscription-CLI adapters surface this so callers
   * (Spirit REPL, daemon's PersistentContextExecutor) can pass it back
   * on the next request to enable native session resume. Undefined for
   * direct API providers and for first turns where the CLI didn't
   * surface an id.
   */
  readonly sessionId?: string;
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
