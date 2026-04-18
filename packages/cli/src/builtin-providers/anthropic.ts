/**
 * Built-in provider — Anthropic (via `@ai-sdk/anthropic`).
 */

import type { ProviderDefinition } from "@murmurations-ai/llm";

export const anthropicProvider: ProviderDefinition = {
  id: "anthropic",
  displayName: "Anthropic",
  envKeyName: "ANTHROPIC_API_KEY",
  tiers: {
    fast: "claude-sonnet-4-5-20250929",
    balanced: "claude-sonnet-4-5-20250929",
    deep: "claude-opus-4-6-20251030",
  },
  create: async ({ token, model, baseUrl }) => {
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    const anthropic = createAnthropic({
      apiKey: token?.reveal() ?? "",
      ...(baseUrl !== undefined ? { baseURL: baseUrl } : {}),
    });
    return anthropic(model);
  },
};
