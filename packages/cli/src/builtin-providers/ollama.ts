/**
 * Built-in provider — Ollama (OpenAI-compatible local endpoint).
 *
 * No API key required — the local Ollama daemon listens on
 * http://localhost:11434/v1 by default.
 */

import type { ProviderDefinition } from "@murmurations-ai/llm";

export const ollamaProvider: ProviderDefinition = {
  id: "ollama",
  displayName: "Ollama",
  envKeyName: null,
  tiers: {
    fast: "llama3.2:3b",
    balanced: "llama3.2",
    deep: "llama3.1:70b",
  },
  create: async ({ model, baseUrl }) => {
    const { createOpenAI } = await import("@ai-sdk/openai");
    const ollama = createOpenAI({
      baseURL: baseUrl ?? "http://localhost:11434/v1",
      apiKey: "ollama", // required by SDK but not validated by Ollama
    });
    return ollama(model);
  },
};
