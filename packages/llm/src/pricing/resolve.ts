/**
 * `resolveLLMCost` — compute USD micros from token counts for any
 * provider/model in the catalog. Errors-as-values per ADR-0005.
 *
 * See `docs/adr/0015-pricing-catalog.md` for rationale.
 */

import { makeUSDMicros, type USDMicros } from "@murmuration/core";

import type { ProviderId, Result } from "../types.js";
import { SEED_CATALOG, type ProviderRate } from "./catalog.js";

export type PricingCatalogErrorCode =
  | "unknown-provider"
  | "unknown-model"
  | "negative-tokens"
  | "internal";

export interface PricingCatalogError {
  readonly kind: "pricing-catalog-error";
  readonly code: PricingCatalogErrorCode;
  readonly message: string;
  readonly provider?: ProviderId;
  readonly model?: string;
}

export interface ResolveLLMCostInput {
  readonly provider: ProviderId;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  /**
   * Reserved for Phase 3 historical replay. v0.1 ignores this and
   * always uses the most-recent entry per (provider, model).
   */
  readonly asOf?: Date;
}

const KNOWN_PROVIDERS: ReadonlySet<ProviderId> = new Set([
  "gemini",
  "anthropic",
  "openai",
  "ollama",
]);

/**
 * Find the catalog entry for a (provider, model) pair. v0.1 returns
 * the first match; when multiple entries per pair become legal in
 * Phase 3, this becomes an `asOf`-aware lookup.
 */
const findRate = (
  catalog: readonly ProviderRate[],
  provider: ProviderId,
  model: string,
): ProviderRate | null => {
  for (const rate of catalog) {
    if (rate.provider === provider && rate.model === model) return rate;
  }
  // Ollama has a generic sentinel so any Ollama model resolves to zero.
  if (provider === "ollama") {
    return catalog.find((r) => r.provider === "ollama" && r.model === "ollama-local") ?? null;
  }
  return null;
};

/**
 * Compute the cost of an LLM call from token counts. Uses `SEED_CATALOG`
 * by default; tests may inject a different catalog via the closure.
 */
export const resolveLLMCost = (
  input: ResolveLLMCostInput,
): Result<USDMicros, PricingCatalogError> => resolveLLMCostWith(SEED_CATALOG, input);

export const resolveLLMCostWith = (
  catalog: readonly ProviderRate[],
  input: ResolveLLMCostInput,
): Result<USDMicros, PricingCatalogError> => {
  if (!KNOWN_PROVIDERS.has(input.provider)) {
    return {
      ok: false,
      error: {
        kind: "pricing-catalog-error",
        code: "unknown-provider",
        message: `unknown provider: ${input.provider}`,
        provider: input.provider,
      },
    };
  }
  if (
    input.inputTokens < 0 ||
    input.outputTokens < 0 ||
    (input.cacheReadTokens !== undefined && input.cacheReadTokens < 0) ||
    (input.cacheWriteTokens !== undefined && input.cacheWriteTokens < 0)
  ) {
    return {
      ok: false,
      error: {
        kind: "pricing-catalog-error",
        code: "negative-tokens",
        message: `negative token count not allowed`,
        provider: input.provider,
        model: input.model,
      },
    };
  }
  const rate = findRate(catalog, input.provider, input.model);
  if (rate === null) {
    return {
      ok: false,
      error: {
        kind: "pricing-catalog-error",
        code: "unknown-model",
        message: `unknown model for provider ${input.provider}: ${input.model}`,
        provider: input.provider,
        model: input.model,
      },
    };
  }

  const inputMicros = input.inputTokens * rate.inputUSDMicrosPerMillionTokens;
  const outputMicros = input.outputTokens * rate.outputUSDMicrosPerMillionTokens;
  const cacheReadMicros =
    (input.cacheReadTokens ?? 0) *
    (rate.cacheReadUSDMicrosPerMillionTokens ?? rate.inputUSDMicrosPerMillionTokens);
  const cacheWriteMicros =
    (input.cacheWriteTokens ?? 0) *
    (rate.cacheWriteUSDMicrosPerMillionTokens ?? rate.inputUSDMicrosPerMillionTokens);
  const total = Math.floor(
    (inputMicros + outputMicros + cacheReadMicros + cacheWriteMicros) / 1_000_000,
  );
  return { ok: true, value: makeUSDMicros(total) };
};
