/**
 * Static model-tier resolution table. The single place in the package
 * where model strings live; updated via PR when providers release new
 * models.
 *
 * `ModelTier` is imported from `@murmuration/core/execution`.
 */

import type { ModelTier, ProviderId } from "./types.js";

export const MODEL_TIER_TABLE: Record<ProviderId, Record<ModelTier, string>> = {
  gemini: {
    fast: "gemini-2.5-flash",
    balanced: "gemini-2.5-pro",
    deep: "gemini-2.5-pro", // Pro is the top Google tier
  },
  anthropic: {
    fast: "claude-sonnet-4-5-20250929",
    balanced: "claude-sonnet-4-5-20250929",
    deep: "claude-opus-4-6-20251030", // verify model id against live API at impl time
  },
  openai: {
    fast: "gpt-4o-mini",
    balanced: "gpt-4o",
    deep: "gpt-4-turbo", // verify against current API at impl time
  },
  ollama: {
    fast: "llama3.2:3b",
    balanced: "llama3.2",
    deep: "llama3.1:70b",
  },
};

export const resolveModelForTier = (provider: ProviderId, tier: ModelTier): string =>
  MODEL_TIER_TABLE[provider][tier];
