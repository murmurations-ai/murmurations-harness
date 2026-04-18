/**
 * Built-in provider — OpenAI (via `@ai-sdk/openai`).
 */

import type { ProviderDefinition } from "@murmurations-ai/llm";

export const openaiProvider: ProviderDefinition = {
  id: "openai",
  displayName: "OpenAI",
  envKeyName: "OPENAI_API_KEY",
  tiers: {
    fast: "gpt-4o-mini",
    balanced: "gpt-4o",
    deep: "gpt-4-turbo",
  },
  create: async ({ token, model, baseUrl }) => {
    const { createOpenAI } = await import("@ai-sdk/openai");
    const openai = createOpenAI({
      apiKey: token?.reveal() ?? "",
      ...(baseUrl !== undefined ? { baseURL: baseUrl } : {}),
    });
    return openai(model);
  },
};
