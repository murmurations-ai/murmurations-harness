/**
 * Shared helper that seeds the process-wide default `ProviderRegistry`
 * singleton with the CLI's built-in providers, and returns a fresh
 * registry instance seeded the same way.
 *
 * CLI entry points that use back-compat shims (`providerEnvKeyName`,
 * `resolveModelForTier`, `createVercelModel`) call this early so the
 * shims can resolve the four default providers without needing a
 * registry threaded explicitly.
 *
 * Idempotent — repeat calls do not duplicate registrations.
 */

import { seedDefaultRegistry, type ProviderRegistry } from "@murmurations-ai/llm";

import { buildBuiltinProviderRegistry, BUILTIN_PROVIDERS } from "./index.js";

export const seedBuiltinProviders = (): ProviderRegistry => {
  seedDefaultRegistry(BUILTIN_PROVIDERS);
  return buildBuiltinProviderRegistry();
};
