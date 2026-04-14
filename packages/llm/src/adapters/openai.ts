/**
 * OpenAI adapter — Chat Completions v1
 * `POST {baseUrl}/v1/chat/completions`
 *
 * Auth: `Authorization: Bearer <token>`.
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

const DEFAULT_BASE_URL = "https://api.openai.com";
const DEFAULT_USER_AGENT = "murmuration-harness/0.1";

export interface OpenAIAdapterConfig {
  readonly token: SecretValue;
  readonly model: string;
  readonly baseUrl?: string;
  readonly userAgent?: string;
  readonly fetch?: typeof fetch;
  readonly retryPolicy?: RetryPolicy;
}

const openaiResponseSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string().optional(),
        message: z
          .object({
            role: z.string().optional(),
            content: z.string().nullable().optional(),
          })
          .optional(),
      }),
    )
    .optional(),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
      prompt_tokens_details: z
        .object({
          cached_tokens: z.number().int().nonnegative().optional(),
        })
        .optional(),
    })
    .optional(),
});

const normalizeOpenAIFinishReason = (r: string | undefined): StopReason => {
  switch (r) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "content_filter":
      return "content_policy";
    case "tool_calls":
      return "tool_use";
    default:
      return r === undefined ? "unknown" : "unknown";
  }
};

export const createOpenAIAdapter = (config: OpenAIAdapterConfig): LLMAdapter =>
  new OpenAIAdapterImpl(config);

class OpenAIAdapterImpl implements LLMAdapter {
  public readonly providerId = "openai" as const;
  public readonly modelUsed: string;
  public readonly capabilities: LLMClientCapabilities;
  readonly #token: SecretValue;
  readonly #baseUrl: string;
  readonly #userAgent: string;
  readonly #fetch: typeof fetch;
  readonly #retryPolicy: RetryPolicy;

  public constructor(config: OpenAIAdapterConfig) {
    this.#token = config.token;
    this.modelUsed = config.model;
    this.#baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.#userAgent = config.userAgent ?? DEFAULT_USER_AGENT;
    this.#fetch = config.fetch ?? globalThis.fetch;
    this.#retryPolicy = config.retryPolicy ?? DEFAULT_RETRY_POLICY.openai;
    this.capabilities = {
      provider: "openai",
      supportedTiers: ["fast", "balanced", "deep"],
      supportsStreaming: false,
      supportsToolUse: false,
      supportsVision: false,
      supportsJsonMode: false,
      maxContextTokens: 128_000,
    };
  }

  public async complete(
    request: LLMRequest,
    options: ResolvedCallOptions,
  ): Promise<Result<LLMResponse, LLMClientError>> {
    const url = `${this.#baseUrl}/v1/chat/completions`;

    // OpenAI takes system as a leading message role.
    const messages: { role: string; content: string }[] = [];
    const systemText =
      request.systemPromptOverride ?? request.messages.find((m) => m.role === "system")?.content;
    if (systemText !== undefined) {
      messages.push({ role: "system", content: systemText });
    }
    for (const m of request.messages) {
      if (m.role === "system") continue;
      messages.push({ role: m.role, content: m.content });
    }

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      max_tokens: request.maxOutputTokens,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.topP !== undefined ? { top_p: request.topP } : {}),
      ...(request.stopSequences ? { stop: request.stopSequences } : {}),
    };

    let attempt = 0;
    let lastCause: unknown = null;
    while (attempt < this.#retryPolicy.maxAttempts) {
      attempt++;
      let res: Response;
      try {
        res = await this.#fetch(url, {
          method: "POST",
          headers: this.#buildHeaders(options.idempotencyKey),
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
      error: new LLMTransportError("openai", `request failed after ${String(attempt)} attempts`, {
        requestUrl: url,
        attempts: attempt,
        cause: scrubCause(lastCause, this.#token),
      }),
    };
  }

  #buildHeaders(idempotencyKey: string | undefined): Headers {
    const headers = new Headers({
      "Content-Type": "application/json",
      "User-Agent": this.#userAgent,
      // The ONLY place reveal() is called in this file.
      Authorization: `Bearer ${this.#token.reveal()}`,
    });
    if (idempotencyKey !== undefined) headers.set("Idempotency-Key", idempotencyKey);
    return headers;
  }

  async #parseResponse(res: Response, url: string): Promise<Result<LLMResponse, LLMClientError>> {
    let body: unknown;
    try {
      body = await res.json();
    } catch (cause) {
      return {
        ok: false,
        error: new LLMParseError("openai", "failed to decode JSON", { requestUrl: url, cause }),
      };
    }
    const parsed = openaiResponseSchema.safeParse(body);
    if (!parsed.success) {
      return {
        ok: false,
        error: new LLMParseError("openai", `schema validation failed: ${parsed.error.message}`, {
          requestUrl: url,
        }),
      };
    }
    const data = parsed.data;
    const choice = data.choices?.[0];
    const stopReason = normalizeOpenAIFinishReason(choice?.finish_reason);
    const content = choice?.message?.content ?? "";
    const cacheReadTokens = data.usage?.prompt_tokens_details?.cached_tokens;

    const value: LLMResponse = {
      content,
      stopReason,
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
      modelUsed: data.model ?? this.modelUsed,
      providerUsed: "openai",
    };
    return { ok: true, value };
  }

  #emitCost(hook: LLMCostHook | undefined, response: LLMResponse): void {
    hook?.onLlmCall({
      provider: "openai",
      model: response.modelUsed,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      ...(response.cacheReadTokens !== undefined
        ? { cacheReadTokens: response.cacheReadTokens }
        : {}),
    });
  }

  async #mapHttpError(res: Response, url: string): Promise<LLMClientError> {
    const status = res.status;
    if (status === 401) {
      return new LLMUnauthorizedError("openai", "unauthorized", { requestUrl: url });
    }
    if (status === 403) {
      return new LLMForbiddenError("openai", "forbidden", { requestUrl: url });
    }
    if (status === 429) {
      return new LLMRateLimitError("openai", "rate limited", {
        requestUrl: url,
        status,
        retryAfterSeconds: parseOpenAIRetryAfter(res),
        limitScope: "unknown",
      });
    }
    if (status === 400) {
      let bodyText = "";
      try {
        bodyText = await res.text();
      } catch {
        // ignore
      }
      if (/context_length|maximum context/i.test(bodyText)) {
        return new LLMContextLengthError("openai", `context length exceeded: ${bodyText}`, {
          requestUrl: url,
        });
      }
      return new LLMValidationError(
        "openai",
        `validation failed (status ${String(status)}): ${bodyText}`,
        { requestUrl: url, status },
      );
    }
    if (status === 422) {
      return new LLMValidationError("openai", `validation failed (status ${String(status)})`, {
        requestUrl: url,
        status,
      });
    }
    if (status >= 500) {
      return new LLMProviderOutageError("openai", `server error ${String(status)}`, {
        requestUrl: url,
        status,
        attempts: 1,
      });
    }
    return new LLMInternalError("openai", `unexpected status ${String(status)}`, {
      requestUrl: url,
    });
  }
}

const parseOpenAIRetryAfter = (res: Response): number | null => {
  const v = res.headers.get("retry-after");
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

const isAbortError = (err: unknown): boolean => {
  if (typeof err !== "object" || err === null) return false;
  return (err as { name?: unknown }).name === "AbortError";
};
