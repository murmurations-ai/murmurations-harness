/**
 * Built-in provider — Google Gemini (via `@ai-sdk/google`).
 *
 * Ships with the harness CLI as a default provider. Registered into
 * the `ProviderRegistry` at boot via `buildBuiltinProviderRegistry()`.
 * Phase 4 will split these into standalone extensions operators can
 * opt out of; for now they live alongside the CLI binary.
 */

import type { ProviderDefinition } from "@murmurations-ai/llm";

export const geminiProvider: ProviderDefinition = {
  id: "gemini",
  displayName: "Google Gemini",
  envKeyName: "GEMINI_API_KEY",
  tiers: {
    fast: "gemini-2.5-flash",
    balanced: "gemini-2.5-pro",
    deep: "gemini-2.5-pro",
  },
  create: async ({ token, model, baseUrl }) => {
    const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
    const google = createGoogleGenerativeAI({
      apiKey: token?.reveal() ?? "",
      ...(baseUrl !== undefined ? { baseURL: baseUrl } : {}),
    });
    return google(model);
  },
};
