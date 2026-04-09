/**
 * Gemini adapter — Google Generative AI v1beta
 * `POST {baseUrl}/v1beta/models/{model}:generateContent`
 *
 * Auth: `x-goog-api-key: <token>` header (NOT query param).
 * reveal() called exactly once, in `#buildHeaders`.
 */

import type { SecretValue } from "@murmuration/core";
import { z } from "zod";

import type { LLMCostHook } from "../cost-hook.js";
import {
  LLMContentPolicyError,
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
  type RateLimitScope,
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

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
const DEFAULT_USER_AGENT = "murmuration-harness/0.1";

export interface GeminiAdapterConfig {
  readonly token: SecretValue;
  readonly model: string;
  readonly baseUrl?: string;
  readonly userAgent?: string;
  readonly fetch?: typeof fetch;
  readonly retryPolicy?: RetryPolicy;
  readonly requestTimeoutMs?: number;
}

const geminiResponseSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z
          .object({
            parts: z.array(z.object({ text: z.string().optional() })).optional(),
          })
          .optional(),
        finishReason: z.string().optional(),
      }),
    )
    .optional(),
  modelVersion: z.string().optional(),
  usageMetadata: z
    .object({
      promptTokenCount: z.number().int().nonnegative().optional(),
      candidatesTokenCount: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

const normalizeGeminiFinishReason = (r: string | undefined): StopReason => {
  switch (r) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
      return "content_policy";
    default:
      return r === undefined ? "unknown" : "unknown";
  }
};

export const createGeminiAdapter = (config: GeminiAdapterConfig): LLMAdapter =>
  new GeminiAdapterImpl(config);

class GeminiAdapterImpl implements LLMAdapter {
  public readonly providerId = "gemini" as const;
  public readonly modelUsed: string;
  public readonly capabilities: LLMClientCapabilities;
  readonly #token: SecretValue;
  readonly #baseUrl: string;
  readonly #userAgent: string;
  readonly #fetch: typeof fetch;
  readonly #retryPolicy: RetryPolicy;

  public constructor(config: GeminiAdapterConfig) {
    this.#token = config.token;
    this.modelUsed = config.model;
    this.#baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.#userAgent = config.userAgent ?? DEFAULT_USER_AGENT;
    this.#fetch = config.fetch ?? globalThis.fetch;
    this.#retryPolicy = config.retryPolicy ?? DEFAULT_RETRY_POLICY.gemini;
    this.capabilities = {
      provider: "gemini",
      supportedTiers: ["fast", "balanced", "deep"],
      supportsStreaming: false,
      supportsToolUse: false,
      supportsVision: false,
      supportsJsonMode: false,
      maxContextTokens: 2_097_152,
    };
  }

  public async complete(
    request: LLMRequest,
    options: ResolvedCallOptions,
  ): Promise<Result<LLMResponse, LLMClientError>> {
    const url = `${this.#baseUrl}/v1beta/models/${encodeURIComponent(request.model)}:generateContent`;

    // Build Gemini request body.
    const systemText =
      request.systemPromptOverride ?? request.messages.find((m) => m.role === "system")?.content;
    const contents = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));
    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        maxOutputTokens: request.maxOutputTokens,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.topP !== undefined ? { topP: request.topP } : {}),
        ...(request.stopSequences ? { stopSequences: request.stopSequences } : {}),
      },
    };
    if (systemText !== undefined) {
      body.systemInstruction = { parts: [{ text: systemText }] };
    }

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
        const retryAfter = parseGeminiRetryAfter(res);
        await sleep(retryAfter ?? computeDelayMs(attempt, this.#retryPolicy));
        continue;
      }

      return { ok: false, error: this.#mapHttpError(res, url) };
    }

    return {
      ok: false,
      error: new LLMTransportError("gemini", `request failed after ${String(attempt)} attempts`, {
        requestUrl: url,
        attempts: attempt,
        cause: scrubCause(lastCause, this.#token),
      }),
    };
  }

  #buildHeaders(): Headers {
    return new Headers({
      "Content-Type": "application/json",
      "User-Agent": this.#userAgent,
      // The ONLY place reveal() is called in this file.
      "x-goog-api-key": this.#token.reveal(),
    });
  }

  async #parseResponse(res: Response, url: string): Promise<Result<LLMResponse, LLMClientError>> {
    let body: unknown;
    try {
      body = await res.json();
    } catch (cause) {
      return {
        ok: false,
        error: new LLMParseError("gemini", "failed to decode JSON", { requestUrl: url, cause }),
      };
    }
    const parsed = geminiResponseSchema.safeParse(body);
    if (!parsed.success) {
      return {
        ok: false,
        error: new LLMParseError("gemini", `schema validation failed: ${parsed.error.message}`, {
          requestUrl: url,
        }),
      };
    }
    const data = parsed.data;
    const candidate = data.candidates?.[0];
    const stopReason = normalizeGeminiFinishReason(candidate?.finishReason);
    const content = candidate?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";

    if (stopReason === "content_policy" && content.length === 0) {
      return {
        ok: false,
        error: new LLMContentPolicyError(
          "gemini",
          `response refused by safety filter (finishReason=${String(candidate?.finishReason)})`,
          { requestUrl: url },
        ),
      };
    }

    return {
      ok: true,
      value: {
        content,
        stopReason,
        inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
        modelUsed: data.modelVersion ?? this.modelUsed,
        providerUsed: "gemini",
      },
    };
  }

  #emitCost(hook: LLMCostHook | undefined, response: LLMResponse): void {
    hook?.onLlmCall({
      provider: "gemini",
      model: response.modelUsed,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
    });
  }

  #mapHttpError(res: Response, url: string): LLMClientError {
    const status = res.status;
    if (status === 401) {
      return new LLMUnauthorizedError("gemini", "unauthorized", { requestUrl: url });
    }
    if (status === 403) {
      return new LLMForbiddenError("gemini", "forbidden", { requestUrl: url });
    }
    if (status === 429) {
      return new LLMRateLimitError("gemini", "rate limited", {
        requestUrl: url,
        status,
        retryAfterSeconds: parseGeminiRetryAfter(res),
        limitScope: "unknown",
      });
    }
    if (status === 400) {
      // Gemini 400 with context-length message → LLMContextLengthError; otherwise validation.
      // We don't parse the body here; caller gets validation.
      return new LLMValidationError("gemini", `validation failed (status ${String(status)})`, {
        requestUrl: url,
        status,
      });
    }
    if (status === 422) {
      return new LLMValidationError("gemini", `validation failed (status ${String(status)})`, {
        requestUrl: url,
        status,
      });
    }
    if (status >= 500) {
      return new LLMProviderOutageError("gemini", `server error ${String(status)}`, {
        requestUrl: url,
        status,
        attempts: 1,
      });
    }
    return new LLMInternalError("gemini", `unexpected status ${String(status)}`, {
      requestUrl: url,
    });
  }
}

const parseGeminiRetryAfter = (res: Response): number | null => {
  const v = res.headers.get("retry-after");
  if (v === null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
};

const isAbortError = (err: unknown): boolean => {
  if (typeof err !== "object" || err === null) return false;
  return (err as { name?: unknown }).name === "AbortError";
};

// Unused type-only re-export to quiet ESLint about unused type imports.
export type { RateLimitScope };
