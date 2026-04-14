/**
 * `createLLMClient` factory + `LLMClient` wrapper.
 *
 * The wrapper delegates to one adapter. Provider is selected via the
 * discriminated `LLMClientConfig` union. Default cost hook / per-call
 * cost hook resolution happens here, not in adapters.
 */

import type { SecretValue } from "@murmurations-ai/core";

import type { LLMCostHook } from "./cost-hook.js";
import type { LLMClientError } from "./errors.js";
import type { RetryPolicy } from "./retry.js";
import { resolveModelForTier } from "./tiers.js";
import type { LLMClientCapabilities, LLMRequest, LLMResponse, ModelTier, Result } from "./types.js";
import type { LLMAdapter } from "./adapters/adapter.js";
import { createAnthropicAdapter } from "./adapters/anthropic.js";
import { createGeminiAdapter } from "./adapters/gemini.js";
import { createOllamaAdapter } from "./adapters/ollama.js";
import { createOpenAIAdapter } from "./adapters/openai.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface CallOptions {
  readonly signal?: AbortSignal;
  readonly costHook?: LLMCostHook;
  readonly idempotencyKey?: string;
}

export interface LLMClient {
  complete(
    request: LLMRequest,
    options?: CallOptions,
  ): Promise<Result<LLMResponse, LLMClientError>>;

  capabilities(): LLMClientCapabilities;
}

interface BaseClientConfig {
  readonly model?: string;
  readonly tier?: ModelTier;
  readonly baseUrl?: string;
  readonly userAgent?: string;
  readonly fetch?: typeof fetch;
  readonly retryPolicy?: RetryPolicy;
  readonly defaultCostHook?: LLMCostHook;
  readonly requestTimeoutMs?: number;
  readonly now?: () => Date;
}

export type LLMClientConfig =
  | (BaseClientConfig & { readonly provider: "gemini"; readonly token: SecretValue })
  | (BaseClientConfig & { readonly provider: "anthropic"; readonly token: SecretValue })
  | (BaseClientConfig & { readonly provider: "openai"; readonly token: SecretValue })
  | (BaseClientConfig & { readonly provider: "ollama"; readonly token: null });

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createLLMClient = (config: LLMClientConfig): LLMClient => {
  const tier = config.tier ?? "balanced";
  const resolvedModel = config.model ?? resolveModelForTier(config.provider, tier);

  let adapter: LLMAdapter;
  switch (config.provider) {
    case "gemini": {
      adapter = createGeminiAdapter({
        token: config.token,
        model: resolvedModel,
        ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
        ...(config.userAgent !== undefined ? { userAgent: config.userAgent } : {}),
        ...(config.fetch !== undefined ? { fetch: config.fetch } : {}),
        ...(config.retryPolicy !== undefined ? { retryPolicy: config.retryPolicy } : {}),
      });
      break;
    }
    case "anthropic": {
      adapter = createAnthropicAdapter({
        token: config.token,
        model: resolvedModel,
        ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
        ...(config.userAgent !== undefined ? { userAgent: config.userAgent } : {}),
        ...(config.fetch !== undefined ? { fetch: config.fetch } : {}),
        ...(config.retryPolicy !== undefined ? { retryPolicy: config.retryPolicy } : {}),
      });
      break;
    }
    case "openai": {
      adapter = createOpenAIAdapter({
        token: config.token,
        model: resolvedModel,
        ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
        ...(config.userAgent !== undefined ? { userAgent: config.userAgent } : {}),
        ...(config.fetch !== undefined ? { fetch: config.fetch } : {}),
        ...(config.retryPolicy !== undefined ? { retryPolicy: config.retryPolicy } : {}),
      });
      break;
    }
    case "ollama": {
      adapter = createOllamaAdapter({
        model: resolvedModel,
        ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
        ...(config.userAgent !== undefined ? { userAgent: config.userAgent } : {}),
        ...(config.fetch !== undefined ? { fetch: config.fetch } : {}),
        ...(config.retryPolicy !== undefined ? { retryPolicy: config.retryPolicy } : {}),
      });
      break;
    }
  }

  return new LLMClientImpl(adapter, config.defaultCostHook);
};

// ---------------------------------------------------------------------------
// Wrapper
// ---------------------------------------------------------------------------

class LLMClientImpl implements LLMClient {
  readonly #adapter: LLMAdapter;
  readonly #defaultCostHook: LLMCostHook | undefined;

  public constructor(adapter: LLMAdapter, defaultCostHook: LLMCostHook | undefined) {
    this.#adapter = adapter;
    this.#defaultCostHook = defaultCostHook;
  }

  public complete(
    request: LLMRequest,
    options: CallOptions = {},
  ): Promise<Result<LLMResponse, LLMClientError>> {
    const costHook = options.costHook ?? this.#defaultCostHook;
    return this.#adapter.complete(request, {
      ...(costHook !== undefined ? { costHook } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
    });
  }

  public capabilities(): LLMClientCapabilities {
    return this.#adapter.capabilities;
  }
}
