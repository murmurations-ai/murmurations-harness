/**
 * `createLLMClient` factory + `LLMClient` wrapper.
 *
 * The client is provider-agnostic: callers supply a
 * {@link ProviderRegistry} (ADR-0025) plus a concrete provider id and
 * model. The registry's `ProviderDefinition.create` returns a Vercel
 * AI SDK `LanguageModel` which `VercelAdapter` wraps to produce
 * `LLMResponse` objects.
 *
 * Tier-based model resolution is a caller concern — the client refuses
 * to guess at a model from a tier because the tier table lives on the
 * registry's provider definitions, not in the client.
 */

import type { SecretValue } from "@murmurations-ai/core";

import type { LLMCostHook } from "./cost-hook.js";
import type { LLMClientError } from "./errors.js";
import type { RetryPolicy } from "./retry.js";
import type {
  LLMClientCapabilities,
  LLMRequest,
  LLMResponse,
  ProviderId,
  Result,
} from "./types.js";
import type { LLMAdapter } from "./adapters/adapter.js";
import { VercelAdapter } from "./adapters/vercel-adapter.js";
import type { ProviderRegistry } from "./providers.js";

// ---------------------------------------------------------------------------
// Public interface
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

export interface LLMClientConfig {
  /** The registry that knows how to construct a `LanguageModel` for
   *  {@link provider}. Callers own the registry — typically populated
   *  once at boot with built-ins + extension contributions. */
  readonly registry: ProviderRegistry;
  readonly provider: ProviderId;
  /** The concrete model id. Tier resolution is a caller concern —
   *  use `registry.resolveModelForTier(provider, tier)` to get one. */
  readonly model: string;
  readonly token: SecretValue | null;
  readonly baseUrl?: string;
  readonly userAgent?: string;
  readonly fetch?: typeof fetch;
  /** @deprecated Vercel AI SDK manages retries internally. */
  readonly retryPolicy?: RetryPolicy;
  readonly defaultCostHook?: LLMCostHook;
  readonly requestTimeoutMs?: number;
  readonly now?: () => Date;
}

// ---------------------------------------------------------------------------
// Factory — synchronous by design; Vercel model is created lazily on
// the first `complete()` call so construction never does I/O.
// ---------------------------------------------------------------------------

export const createLLMClient = (config: LLMClientConfig): LLMClient => {
  const def = config.registry.get(config.provider);
  if (!def) {
    throw new Error(
      `createLLMClient: provider "${config.provider}" is not registered on the supplied registry`,
    );
  }

  let adapterPromise: Promise<LLMAdapter> | null = null;

  const getAdapter = (): Promise<LLMAdapter> => {
    adapterPromise ??= def
      .create({
        token: config.token,
        model: config.model,
        ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
      })
      .then((vercelModel) => new VercelAdapter(config.provider, config.model, vercelModel));
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
