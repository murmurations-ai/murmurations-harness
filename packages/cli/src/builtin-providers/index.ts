/**
 * Built-in providers shipped with the Murmuration Harness CLI.
 *
 * The `@murmurations-ai/llm` package knows nothing about specific
 * vendors — it exposes the `ProviderRegistry` interface, and the CLI
 * seeds the registry at boot with the four default providers below.
 * Operator extensions under `<root>/extensions/` register more.
 *
 * Phase 4 will split these into standalone extensions operators can
 * opt out of without forking.
 */

import { ProviderRegistry, type ProviderDefinition } from "@murmurations-ai/llm";

import { anthropicProvider } from "./anthropic.js";
import { geminiProvider } from "./gemini.js";
import { ollamaProvider } from "./ollama.js";
import { openaiProvider } from "./openai.js";

/** The four providers bundled with the CLI binary. Order is stable
 *  so logs and `murmuration providers list` output stay deterministic. */
export const BUILTIN_PROVIDERS: readonly ProviderDefinition[] = [
  geminiProvider,
  anthropicProvider,
  openaiProvider,
  ollamaProvider,
];

/** Build a fresh `ProviderRegistry` seeded with the CLI's built-in
 *  providers. Callers add more via extensions before using the
 *  registry for dispatch. */
export const buildBuiltinProviderRegistry = (): ProviderRegistry => {
  const registry = new ProviderRegistry();
  for (const def of BUILTIN_PROVIDERS) {
    registry.register(def);
  }
  return registry;
};

export { anthropicProvider, geminiProvider, ollamaProvider, openaiProvider };
