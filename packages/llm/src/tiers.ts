/**
 * Tier-based model resolution.
 *
 * Historically this file held a static `MODEL_TIER_TABLE`. After
 * ADR-0025 the tier tables live on each `ProviderDefinition` and are
 * consulted via `ProviderRegistry.resolveModelForTier`. The exports
 * below are back-compat shims that use the default (built-in) registry
 * — callers that want extension-registered providers should take a
 * `ProviderRegistry` parameter instead.
 */

import { defaultRegistry } from "./providers.js";
import type { KnownProviderId, ModelTier, ProviderId } from "./types.js";

/** Deprecated. Kept for back-compat. Prefer
 *  {@link ProviderRegistry.resolveModelForTier} on a registry you
 *  construct with {@link createDefaultRegistry}. */
export const resolveModelForTier = (provider: ProviderId, tier: ModelTier): string => {
  const model = defaultRegistry().resolveModelForTier(provider, tier);
  if (!model) {
    throw new Error(
      `resolveModelForTier: no tier "${tier}" for provider "${provider}" (register the provider or pin an explicit model)`,
    );
  }
  return model;
};

/** Deprecated. The tier table for built-in providers, materialized from
 *  the default registry for legacy callers. Reads go through the
 *  registry — don't mutate. */
export const MODEL_TIER_TABLE: Readonly<Record<KnownProviderId, Record<ModelTier, string>>> =
  (() => {
    const r = defaultRegistry();
    const table = {} as Record<KnownProviderId, Record<ModelTier, string>>;
    for (const id of ["gemini", "anthropic", "openai", "ollama"] as const) {
      const def = r.get(id);
      if (def?.tiers) {
        table[id] = { ...def.tiers };
      }
    }
    return table;
  })();
