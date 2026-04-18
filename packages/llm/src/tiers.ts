/**
 * Tier-based model resolution.
 *
 * Historically this file held a static `MODEL_TIER_TABLE`. After
 * ADR-0025 the tier tables live on each `ProviderDefinition` and are
 * consulted via `ProviderRegistry.resolveModelForTier`. The exports
 * below are back-compat shims that delegate to the process-wide
 * default registry, which the CLI seeds with its built-in providers at
 * startup (`seedDefaultRegistry`). Callers that want extension-
 * registered providers should take a `ProviderRegistry` explicitly.
 */

import { defaultRegistry } from "./providers.js";
import type { ModelTier, ProviderId } from "./types.js";

/** Deprecated. Kept for back-compat. Prefer
 *  {@link ProviderRegistry.resolveModelForTier} on a registry you
 *  populate yourself. */
export const resolveModelForTier = (provider: ProviderId, tier: ModelTier): string => {
  const model = defaultRegistry().resolveModelForTier(provider, tier);
  if (!model) {
    throw new Error(
      `resolveModelForTier: no tier "${tier}" for provider "${provider}" (register the provider — it may not be seeded into the default registry yet, or pin an explicit model)`,
    );
  }
  return model;
};

/** Deprecated. Dynamic view of the default registry's tier tables at
 *  call time. Prefer `registry.resolveModelForTier(id, tier)`. */
export const lookupTierTable = (provider: ProviderId): Record<ModelTier, string> | undefined => {
  const def = defaultRegistry().get(provider);
  return def?.tiers ? { ...def.tiers } : undefined;
};
