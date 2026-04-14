/**
 * Anthropic adapter — Messages API v2023-06-01
 * `POST {baseUrl}/v1/messages`
 *
 * Auth: `x-api-key: <token>` + `anthropic-version: 2023-06-01`.
 * reveal() called exactly once, in `#buildHeaders`.
 */

import type { SecretValue } from "@murmurations-ai/core";
import { z } from "zod";

import type { LLMCostHook } from "../cost-hook.js";
import {
  LLMContextLengthError,
  LLMForbiddenError,
  LLMInternalError,
  LLMParseError,
  LLMProviderOutageError,
  LLMRateLimitError,
  LLMTransportError,
  LLMUnauthorizedError,
  LLMValidationError,
  scrubCause,
  type LLMClientError,
} from "../errors.js";
import { computeDelayMs, DEFAULT_RETRY_POLICY, sleep, type RetryPolicy } from "../retry.js";
import type {
  LLMClientCapabilities,
  LLMRequest,
  LLMResponse,
  Result,
  StopReason,
} from "../types.js";
import type { LLMAdapter, ResolvedCallOptions } from "./adapter.js";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_USER_AGENT = "murmuration-harness/0.1";
const ANTHROPIC_API_VERSION = "2023-06-01";

export interface AnthropicAdapterConfig {
  readonly token: SecretValue;
  readonly model: string;
  readonly baseUrl?: string;
  readonly userAgent?: string;
  readonly fetch?: typeof fetch;
  readonly retryPolicy?: RetryPolicy;
}

const anthropicResponseSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  stop_reason: z.string().optional(),
  content: z
    .array(
      z.object({
        type: z.string().optional(),
        text: z.string().optional(),
      }),
    )
    .optional(),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative().optional(),
      output_tokens: z.number().int().nonnegative().optional(),
      cache_read_input_tokens: z.number().int().nonnegative().optional(),
      cache_creation_input_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

const normalizeAnthropicStopReason = (r: string | undefined): StopReason => {
  switch (r) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_use";
    default:
      return r === undefined ? "unknown" : "unknown";
  }
};

export const createAnthropicAdapter = (config: AnthropicAdapterConfig): LLMAdapter =>
  new AnthropicAdapterImpl(config);

class AnthropicAdapterImpl implements LLMAdapter {
  public readonly providerId = "anthropic" as const;
  public readonly modelUsed: string;
  public readonly capabilities: LLMClientCapabilities;
  readonly #token: SecretValue;
  readonly #baseUrl: string;
  readonly #userAgent: string;
  readonly #fetch: typeof fetch;
  readonly #retryPolicy: RetryPolicy;

  public constructor(config: AnthropicAdapterConfig) {
    this.#token = config.token;
    this.modelUsed = config.model;
    this.#baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.#userAgent = config.userAgent ?? DEFAULT_USER_AGENT;
    this.#fetch = config.fetch ?? globalThis.fetch;
    this.#retryPolicy = config.retryPolicy ?? DEFAULT_RETRY_POLICY.anthropic;
    this.capabilities = {
      provider: "anthropic",
      supportedTiers: ["fast", "balanced", "deep"],
      supportsStreaming: false,
      supportsToolUse: false,
      supportsVision: false,
      supportsJsonMode: false,
      maxContextTokens: 200_000,
    };
  }

  public async complete(
    request: LLMRequest,
    options: ResolvedCallOptions,
  ): Promise<Result<LLMResponse, LLMClientError>> {
    const url = `${this.#baseUrl}/v1/messages`;
    const systemText =
      request.systemPromptOverride ?? request.messages.find((m) => m.role === "system")?.content;
    const messages = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));

    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.maxOutputTokens,
      messages,
      ...(systemText !== undefined ? { system: systemText } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.topP !== undefined ? { top_p: request.topP } : {}),
      ...(request.stopSequences ? { stop_sequences: request.stopSequences } : {}),
    };

    let attempt = 0;
    let lastCause: unknown = null;
    while (attempt < this.#retryPolicy.maxAttempts) {
      attempt++;
      let res: Response;
      try {
        res = await this.#fetch(url, {
          method: "POST",
          headers: this.#buildHeaders(),
          body: JSON.stringify(body),
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } catch (cause) {
        if (isAbortError(cause)) throw cause;
        lastCause = cause;
        if (attempt < this.#retryPolicy.maxAttempts) {
          await sleep(computeDelayMs(attempt, this.#retryPolicy));
          continue;
        }
        break;
      }

      if (res.status >= 200 && res.status < 300) {
        const parsed = await this.#parseResponse(res, url);
        if (!parsed.ok) return parsed;
        this.#emitCost(options.costHook, parsed.value);
        return parsed;
      }

      if (
        this.#retryPolicy.retryableStatuses.includes(res.status) &&
        attempt < this.#retryPolicy.maxAttempts
      ) {
        await sleep(computeDelayMs(attempt, this.#retryPolicy));
        continue;
      }

      return { ok: false, error: await this.#mapHttpError(res, url) };
    }

    return {
      ok: false,
      error: new LLMTransportError(
        "anthropic",
        `request failed after ${String(attempt)} attempts`,
        {
          requestUrl: url,
          attempts: attempt,
          cause: scrubCause(lastCause, this.#token),
        },
      ),
    };
  }

  #buildHeaders(): Headers {
    return new Headers({
      "Content-Type": "application/json",
      "User-Agent": this.#userAgent,
      "anthropic-version": ANTHROPIC_API_VERSION,
      // The ONLY place reveal() is called in this file.
      "x-api-key": this.#token.reveal(),
    });
  }

  async #parseResponse(res: Response, url: string): Promise<Result<LLMResponse, LLMClientError>> {
    let body: unknown;
    try {
      body = await res.json();
    } catch (cause) {
      return {
        ok: false,
        error: new LLMParseError("anthropic", "failed to decode JSON", { requestUrl: url, cause }),
      };
    }
    const parsed = anthropicResponseSchema.safeParse(body);
    if (!parsed.success) {
      return {
        ok: false,
        error: new LLMParseError("anthropic", `schema validation failed: ${parsed.error.message}`, {
          requestUrl: url,
        }),
      };
    }
    const data = parsed.data;
    const content =
      data.content
        ?.filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text ?? "")
        .join("") ?? "";
    const stopReason = normalizeAnthropicStopReason(data.stop_reason);
    const inputTokens = data.usage?.input_tokens ?? 0;
    const outputTokens = data.usage?.output_tokens ?? 0;
    const cacheReadTokens = data.usage?.cache_read_input_tokens;
    const cacheWriteTokens = data.usage?.cache_creation_input_tokens;

    const value: LLMResponse = {
      content,
      stopReason,
      inputTokens,
      outputTokens,
      ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
      ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
      modelUsed: data.model ?? this.modelUsed,
      providerUsed: "anthropic",
    };
    return { ok: true, value };
  }

  #emitCost(hook: LLMCostHook | undefined, response: LLMResponse): void {
    hook?.onLlmCall({
      provider: "anthropic",
      model: response.modelUsed,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      ...(response.cacheReadTokens !== undefined
        ? { cacheReadTokens: response.cacheReadTokens }
        : {}),
      ...(response.cacheWriteTokens !== undefined
        ? { cacheWriteTokens: response.cacheWriteTokens }
        : {}),
    });
  }

  async #mapHttpError(res: Response, url: string): Promise<LLMClientError> {
    const status = res.status;
    if (status === 401) {
      return new LLMUnauthorizedError("anthropic", "unauthorized", { requestUrl: url });
    }
    if (status === 403) {
      return new LLMForbiddenError("anthropic", "forbidden", { requestUrl: url });
    }
    if (status === 429) {
      return new LLMRateLimitError("anthropic", "rate limited", {
        requestUrl: url,
        status,
        retryAfterSeconds: parseAnthropicRetryAfter(res),
        limitScope: "unknown",
      });
    }
    if (status === 400) {
      // Anthropic returns 400 with a body indicating invalid_request_error;
      // context-length errors use a specific message. Best-effort peek.
      let bodyText = "";
      try {
        bodyText = await res.text();
      } catch {
        // ignore
      }
      if (/context|max tokens|too long|too large/i.test(bodyText)) {
        return new LLMContextLengthError("anthropic", `context length exceeded: ${bodyText}`, {
          requestUrl: url,
        });
      }
      return new LLMValidationError(
        "anthropic",
        `validation failed (status ${String(status)}): ${bodyText}`,
        { requestUrl: url, status },
      );
    }
    if (status === 422) {
      return new LLMValidationError("anthropic", `validation failed (status ${String(status)})`, {
        requestUrl: url,
        status,
      });
    }
    if (status >= 500) {
      return new LLMProviderOutageError("anthropic", `server error ${String(status)}`, {
        requestUrl: url,
        status,
        attempts: 1,
      });
    }
    return new LLMInternalError("anthropic", `unexpected status ${String(status)}`, {
      requestUrl: url,
    });
  }
}

const parseAnthropicRetryAfter = (res: Response): number | null => {
  // Anthropic's preferred header pair is `anthropic-ratelimit-requests-reset`
  // and `anthropic-ratelimit-tokens-reset` (Unix epoch seconds). Fall back to
  // plain `retry-after` (seconds) if neither is present.
  const reqReset = res.headers.get("anthropic-ratelimit-requests-reset");
  const tokReset = res.headers.get("anthropic-ratelimit-tokens-reset");
  const now = Math.floor(Date.now() / 1000);
  const candidates: number[] = [];
  for (const v of [reqReset, tokReset]) {
    if (v === null) continue;
    const n = Number(v);
    if (Number.isFinite(n) && n > now) candidates.push(n - now);
  }
  if (candidates.length > 0) return Math.max(...candidates);
  const ra = res.headers.get("retry-after");
  if (ra === null) return null;
  const n = Number(ra);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

const isAbortError = (err: unknown): boolean => {
  if (typeof err !== "object" || err === null) return false;
  return (err as { name?: unknown }).name === "AbortError";
};
