/**
 * `createLLMClient` factory + `LLMClient` wrapper.
 *
 * ADR-0020: The wrapper delegates to VercelAdapter, which uses Vercel
 * AI SDK's generateText() under the hood. Provider selection via
 * discriminated `LLMClientConfig` union is unchanged.
 */

import type { SecretValue } from "@murmurations-ai/core";

import type { LLMCostHook } from "./cost-hook.js";
import type { LLMClientError } from "./errors.js";
import type { RetryPolicy } from "./retry.js";
import { resolveModelForTier } from "./tiers.js";
import type { LLMClientCapabilities, LLMRequest, LLMResponse, ModelTier, Result } from "./types.js";
import type { LLMAdapter } from "./adapters/adapter.js";
import { VercelAdapter } from "./adapters/vercel-adapter.js";
import { createVercelModel } from "./adapters/provider-registry.js";

// ---------------------------------------------------------------------------
// Public interface (unchanged from pre-migration)
// ---------------------------------------------------------------------------

export interface CallOptions {
  readonly signal?: AbortSignal;
  readonly costHook?: LLMCostHook;
  readonly idempotencyKey?: string;
  /** Agent context for Langfuse telemetry enrichment (ADR-0022 §1). */
  readonly telemetryContext?: {
    readonly agentId: string;
    readonly wakeId: string;
    readonly groupIds: readonly string[];
    readonly wakeMode: string;
  };
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
  /** @deprecated Vercel AI SDK manages retries internally. */
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
// Factory (unchanged signature — lazy Vercel model creation)
// ---------------------------------------------------------------------------

export const createLLMClient = (config: LLMClientConfig): LLMClient => {
  const tier = config.tier ?? "balanced";
  const resolvedModel = config.model ?? resolveModelForTier(config.provider, tier);

  // Vercel model is created lazily on first complete() call to keep
  // createLLMClient synchronous (preserves call-site compatibility).
  let adapterPromise: Promise<LLMAdapter> | null = null;

  const getAdapter = (): Promise<LLMAdapter> => {
    adapterPromise ??= createVercelModel({
      provider: config.provider,
      model: resolvedModel,
      token: config.provider === "ollama" ? null : config.token,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    }).then((vercelModel) => new VercelAdapter(config.provider, resolvedModel, vercelModel));
    return adapterPromise;
  };

  return new LLMClientImpl(getAdapter, config.defaultCostHook);
};

// ---------------------------------------------------------------------------
// Wrapper
// ---------------------------------------------------------------------------

class LLMClientImpl implements LLMClient {
  readonly #getAdapter: () => Promise<LLMAdapter>;
  readonly #defaultCostHook: LLMCostHook | undefined;

  public constructor(
    getAdapter: () => Promise<LLMAdapter>,
    defaultCostHook: LLMCostHook | undefined,
  ) {
    this.#getAdapter = getAdapter;
    this.#defaultCostHook = defaultCostHook;
  }

  public async complete(
    request: LLMRequest,
    options?: CallOptions,
  ): Promise<Result<LLMResponse, LLMClientError>> {
    const adapter = await this.#getAdapter();
    const costHook = options?.costHook ?? this.#defaultCostHook;
    const signal = options?.signal;
    return adapter.complete(request, {
      ...(costHook ? { costHook } : {}),
      ...(signal ? { signal } : {}),
      ...(options?.telemetryContext ? { telemetryContext: options.telemetryContext } : {}),
    });
  }

  public capabilities(): LLMClientCapabilities {
    return {
      supportsStreaming: true,
      supportsToolUse: true,
      supportsJsonMode: true,
      maxContextTokens: 200_000,
    };
  }
}
