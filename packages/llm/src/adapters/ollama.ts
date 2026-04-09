/**
 * Ollama adapter — local HTTP daemon
 * `POST {baseUrl}/api/chat`
 *
 * No auth (localhost only). Cost = 0. `maxAttempts: 1` — no retry
 * on local failures (those are "model crashed" or "daemon down",
 * both fail-fast).
 */

import { z } from "zod";

import type { LLMCostHook } from "../cost-hook.js";
import {
  LLMInternalError,
  LLMParseError,
  LLMProviderOutageError,
  LLMTransportError,
  LLMValidationError,
  type LLMClientError,
} from "../errors.js";
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from "../retry.js";
import type {
  LLMClientCapabilities,
  LLMRequest,
  LLMResponse,
  Result,
  StopReason,
} from "../types.js";
import type { LLMAdapter, ResolvedCallOptions } from "./adapter.js";

const DEFAULT_BASE_URL = "http://localhost:11434";
const DEFAULT_USER_AGENT = "murmuration-harness/0.1";

export interface OllamaAdapterConfig {
  readonly model: string;
  readonly baseUrl?: string;
  readonly userAgent?: string;
  readonly fetch?: typeof fetch;
  readonly retryPolicy?: RetryPolicy;
  /**
   * Override the default context window. Phase 2 carry-forward
   * CF-llm-E: Ollama's default context is small (2K-4K); the
   * adapter defaults to a more generous value.
   */
  readonly numCtx?: number;
}

const ollamaResponseSchema = z.object({
  model: z.string().optional(),
  message: z
    .object({
      role: z.string().optional(),
      content: z.string().optional(),
    })
    .optional(),
  done: z.boolean().optional(),
  done_reason: z.string().optional(),
  prompt_eval_count: z.number().int().nonnegative().optional(),
  eval_count: z.number().int().nonnegative().optional(),
});

const normalizeOllamaDoneReason = (r: string | undefined): StopReason => {
  switch (r) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    default:
      return r === undefined ? "unknown" : "unknown";
  }
};

export const createOllamaAdapter = (config: OllamaAdapterConfig): LLMAdapter =>
  new OllamaAdapterImpl(config);

class OllamaAdapterImpl implements LLMAdapter {
  public readonly providerId = "ollama" as const;
  public readonly modelUsed: string;
  public readonly capabilities: LLMClientCapabilities;
  readonly #baseUrl: string;
  readonly #userAgent: string;
  readonly #fetch: typeof fetch;
  readonly #retryPolicy: RetryPolicy;
  readonly #numCtx: number | undefined;

  public constructor(config: OllamaAdapterConfig) {
    this.modelUsed = config.model;
    this.#baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.#userAgent = config.userAgent ?? DEFAULT_USER_AGENT;
    this.#fetch = config.fetch ?? globalThis.fetch;
    this.#retryPolicy = config.retryPolicy ?? DEFAULT_RETRY_POLICY.ollama;
    this.#numCtx = config.numCtx;
    this.capabilities = {
      provider: "ollama",
      supportedTiers: ["fast", "balanced", "deep"],
      supportsStreaming: false,
      supportsToolUse: false,
      supportsVision: false,
      supportsJsonMode: false,
      maxContextTokens: config.numCtx ?? 131_072,
    };
  }

  public async complete(
    request: LLMRequest,
    options: ResolvedCallOptions,
  ): Promise<Result<LLMResponse, LLMClientError>> {
    const url = `${this.#baseUrl}/api/chat`;

    // Ollama accepts the same messages shape as OpenAI-style chat.
    const messages: { role: string; content: string }[] = [];
    const systemText =
      request.systemPromptOverride ?? request.messages.find((m) => m.role === "system")?.content;
    if (systemText !== undefined) messages.push({ role: "system", content: systemText });
    for (const m of request.messages) {
      if (m.role === "system") continue;
      messages.push({ role: m.role, content: m.content });
    }

    const llmOptions: Record<string, unknown> = {
      num_predict: request.maxOutputTokens,
    };
    if (this.#numCtx !== undefined) llmOptions.num_ctx = this.#numCtx;
    if (request.temperature !== undefined) llmOptions.temperature = request.temperature;
    if (request.topP !== undefined) llmOptions.top_p = request.topP;
    if (request.stopSequences) llmOptions.stop = request.stopSequences;

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      stream: false,
      options: llmOptions,
    };

    // Ollama: no retry loop. maxAttempts is 1 by default.
    let res: Response;
    try {
      res = await this.#fetch(url, {
        method: "POST",
        headers: new Headers({
          "Content-Type": "application/json",
          "User-Agent": this.#userAgent,
        }),
        body: JSON.stringify(body),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (cause) {
      if (isAbortError(cause)) throw cause;
      return {
        ok: false,
        error: new LLMTransportError("ollama", `local daemon unreachable: ${String(cause)}`, {
          requestUrl: url,
          attempts: this.#retryPolicy.maxAttempts,
          cause,
        }),
      };
    }

    if (res.status >= 200 && res.status < 300) {
      const parsed = await this.#parseResponse(res, url);
      if (!parsed.ok) return parsed;
      this.#emitCost(options.costHook, parsed.value);
      return parsed;
    }

    return { ok: false, error: this.#mapHttpError(res, url) };
  }

  async #parseResponse(res: Response, url: string): Promise<Result<LLMResponse, LLMClientError>> {
    let body: unknown;
    try {
      body = await res.json();
    } catch (cause) {
      return {
        ok: false,
        error: new LLMParseError("ollama", "failed to decode JSON", { requestUrl: url, cause }),
      };
    }
    const parsed = ollamaResponseSchema.safeParse(body);
    if (!parsed.success) {
      return {
        ok: false,
        error: new LLMParseError("ollama", `schema validation failed: ${parsed.error.message}`, {
          requestUrl: url,
        }),
      };
    }
    const data = parsed.data;
    const content = data.message?.content ?? "";
    const stopReason = normalizeOllamaDoneReason(data.done_reason);

    return {
      ok: true,
      value: {
        content,
        stopReason,
        inputTokens: data.prompt_eval_count ?? 0,
        outputTokens: data.eval_count ?? 0,
        modelUsed: data.model ?? this.modelUsed,
        providerUsed: "ollama",
      },
    };
  }

  #emitCost(hook: LLMCostHook | undefined, response: LLMResponse): void {
    hook?.onLlmCall({
      provider: "ollama",
      model: response.modelUsed,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
    });
  }

  #mapHttpError(res: Response, url: string): LLMClientError {
    const status = res.status;
    if (status === 400) {
      return new LLMValidationError("ollama", `validation failed (status ${String(status)})`, {
        requestUrl: url,
        status,
      });
    }
    if (status >= 500) {
      return new LLMProviderOutageError("ollama", `ollama daemon error ${String(status)}`, {
        requestUrl: url,
        status,
        attempts: 1,
      });
    }
    return new LLMInternalError("ollama", `unexpected status ${String(status)}`, {
      requestUrl: url,
    });
  }
}

const isAbortError = (err: unknown): boolean => {
  if (typeof err !== "object" || err === null) return false;
  return (err as { name?: unknown }).name === "AbortError";
};
