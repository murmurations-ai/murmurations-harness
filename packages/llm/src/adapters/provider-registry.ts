/**
 * Vercel AI SDK provider registry — creates provider model instances
 * from harness config. Each provider's API key is revealed exactly
 * once here (grep-checkable per ADR-0014).
 */

import type { LanguageModel } from "ai";
import type { SecretValue } from "@murmurations-ai/core";
import type { ProviderId } from "../types.js";

/**
 * The environment variable name each provider expects its API key
 * under. Callers that need to resolve a secret for a given provider
 * should use this map rather than inlining the string — it keeps
 * provider-specific conventions (and any future additions) in one
 * place. Returns `undefined` for providers that don't require a key
 * (e.g. Ollama, which runs locally).
 */
export const providerEnvKeyName = (provider: ProviderId): string | undefined => {
  switch (provider) {
    case "gemini":
      return "GEMINI_API_KEY";
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "openai":
      return "OPENAI_API_KEY";
    case "ollama":
      return undefined;
  }
};

export interface ProviderRegistryConfig {
  readonly provider: ProviderId;
  readonly model: string;
  readonly token: SecretValue | null;
  readonly baseUrl?: string | undefined;
}

/**
 * Create a Vercel AI SDK LanguageModel from harness config.
 * reveal() is called exactly once per provider construction.
 */
export const createVercelModel = async (config: ProviderRegistryConfig): Promise<LanguageModel> => {
  switch (config.provider) {
    case "gemini": {
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
      const google = createGoogleGenerativeAI({
        apiKey: config.token?.reveal() ?? "",
        ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
      });
      return google(config.model);
    }
    case "anthropic": {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      const anthropic = createAnthropic({
        apiKey: config.token?.reveal() ?? "",
        ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
      });
      return anthropic(config.model);
    }
    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      const openai = createOpenAI({
        apiKey: config.token?.reveal() ?? "",
        ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
      });
      return openai(config.model);
    }
    case "ollama": {
      // Ollama exposes an OpenAI-compatible API at /v1
      const { createOpenAI } = await import("@ai-sdk/openai");
      const ollama = createOpenAI({
        baseURL: config.baseUrl ?? "http://localhost:11434/v1",
        apiKey: "ollama", // required by SDK but not validated by Ollama
      });
      return ollama(config.model);
    }
  }
};
