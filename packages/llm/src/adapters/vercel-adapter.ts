/**
 * VercelAdapter — single adapter wrapping Vercel AI SDK's generateText().
 * Replaces the four hand-rolled adapters (Gemini, Anthropic, OpenAI, Ollama).
 *
 * ADR-0020: Vercel AI SDK migration.
 *
 * Key responsibilities:
 * - Maps LLMRequest → generateText params
 * - Maps generateText result → LLMResponse
 * - Catches Vercel errors → Result<T, LLMClientError> (errors-as-values)
 * - Calls costHook.onLlmCall with token counts
 */

import { generateText, tool as vercelTool, stepCountIs, type LanguageModel } from "ai";

import type { LLMClientError } from "../errors.js";
import {
  LLMInternalError,
  LLMRateLimitError,
  LLMTransportError,
  LLMUnauthorizedError,
  LLMForbiddenError,
  LLMContentPolicyError,
  LLMContextLengthError,
  LLMParseError,
  LLMValidationError,
} from "../errors.js";
import type {
  LLMClientCapabilities,
  LLMRequest,
  LLMResponse,
  ProviderId,
  Result,
  StopReason,
} from "../types.js";
import type { LLMAdapter, ResolvedCallOptions } from "./adapter.js";

// ---------------------------------------------------------------------------
// Finish reason mapping
// ---------------------------------------------------------------------------

const mapFinishReason = (reason: string | undefined): StopReason => {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "content-filter":
      return "content_policy";
    case "tool-calls":
      return "tool_use";
    default:
      return "unknown";
  }
};

// ---------------------------------------------------------------------------
// Error mapping — Vercel throws, we catch and wrap
// ---------------------------------------------------------------------------

const mapError = (err: unknown, provider: ProviderId, model: string): LLMClientError => {
  // Re-throw abort errors (signal-based cancellation)
  if (err instanceof Error && err.name === "AbortError") {
    throw err;
  }

  const message = err instanceof Error ? err.message : String(err);
  const status = (err as { statusCode?: number }).statusCode;
  const opts = { requestUrl: `vercel-ai-sdk://${provider}/${model}`, cause: err };

  if (status === 401) {
    return new LLMUnauthorizedError(provider, message, opts);
  }
  if (status === 403) {
    return new LLMForbiddenError(provider, message, opts);
  }
  if (status === 429) {
    return new LLMRateLimitError(provider, message, {
      ...opts,
      status: 429,
      retryAfterSeconds: null,
      limitScope: "unknown",
    });
  }
  if (status !== undefined && status >= 500) {
    return new LLMTransportError(provider, message, { ...opts, attempts: 1 });
  }

  // Check for content policy
  if (message.includes("content") && (message.includes("filter") || message.includes("policy"))) {
    return new LLMContentPolicyError(provider, message, opts);
  }

  // Check for context length
  if (
    message.includes("context") ||
    message.includes("too long") ||
    message.includes("max tokens")
  ) {
    return new LLMContextLengthError(provider, message, opts);
  }

  // Check for validation
  if (status === 400 || status === 422) {
    return new LLMValidationError(provider, message, opts);
  }

  // Check for parse errors
  if (message.includes("parse") || message.includes("generated")) {
    return new LLMParseError(provider, message, opts);
  }

  return new LLMInternalError(provider, message, opts);
};

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

export class VercelAdapter implements LLMAdapter {
  readonly providerId: ProviderId;
  readonly modelUsed: string;
  readonly capabilities: LLMClientCapabilities = {
    supportsStreaming: true,
    supportsToolUse: true,
    supportsJsonMode: true,
    maxContextTokens: 200_000, // conservative default; provider-specific via Vercel
  };

  readonly #model: LanguageModel;

  public constructor(provider: ProviderId, model: string, vercelModel: LanguageModel) {
    this.providerId = provider;
    this.modelUsed = model;
    this.#model = vercelModel;
  }

  public async complete(
    request: LLMRequest,
    options: ResolvedCallOptions,
  ): Promise<Result<LLMResponse, LLMClientError>> {
    try {
      // Build messages for Vercel (exclude system messages — use system param)
      const messages = request.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

      const systemPrompt =
        request.systemPromptOverride ?? request.messages.find((m) => m.role === "system")?.content;

      // Convert tool definitions to Vercel v6 format
      const tools = request.tools
        ? Object.fromEntries(
            request.tools.map((t) => [
              t.name,
              vercelTool({
                description: t.description,
                inputSchema: t.parameters as import("zod").ZodType,
                execute: async (input) => t.execute(input as Record<string, unknown>),
              }),
            ]),
          )
        : undefined;

      const result = await generateText({
        model: this.#model,
        ...(systemPrompt ? { system: systemPrompt } : {}),
        messages,
        maxOutputTokens: request.maxOutputTokens,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.topP !== undefined ? { topP: request.topP } : {}),
        ...(request.stopSequences ? { stopSequences: [...request.stopSequences] } : {}),
        ...(options.signal ? { abortSignal: options.signal } : {}),
        ...(tools ? { tools } : {}),
        ...(request.maxSteps !== undefined && request.maxSteps > 1
          ? { stopWhen: stepCountIs(request.maxSteps) }
          : {}),
        // Per-step cost tracking for multi-step tool loops
        onStepFinish: (step) => {
          if (options.costHook) {
            options.costHook.onLlmCall({
              provider: this.providerId,
              model: this.modelUsed,
              inputTokens: step.usage.inputTokens ?? 0,
              outputTokens: step.usage.outputTokens ?? 0,
            });
          }
        },
      });

      const inputTokens = result.totalUsage.inputTokens ?? 0;
      const outputTokens = result.totalUsage.outputTokens ?? 0;

      // Note: cost hook is emitted per-step via onStepFinish above.
      // For single-step completions (no tools), onStepFinish fires exactly once.

      // Collect tool calls from all steps
      const toolCalls = result.steps
        .flatMap((s) => {
          const calls = s.toolCalls;
          const results = s.toolResults;
          return calls.map((tc, i) => ({
            name: tc.toolName,
            args: (tc as unknown as { input: Record<string, unknown> }).input,
            result:
              results[i] != null
                ? (results[i] as unknown as { output: unknown }).output
                : undefined,
          }));
        })
        .filter((tc) => tc.name);

      const response: LLMResponse = {
        content: result.text,
        stopReason: mapFinishReason(result.finishReason),
        inputTokens,
        outputTokens,
        modelUsed: this.modelUsed,
        providerUsed: this.providerId,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        ...(result.steps.length > 1 ? { steps: result.steps.length } : {}),
      };

      return { ok: true, value: response };
    } catch (err: unknown) {
      // AbortError is re-thrown by mapError
      const mapped = mapError(err, this.providerId, this.modelUsed);
      return { ok: false, error: mapped };
    }
  }
}
