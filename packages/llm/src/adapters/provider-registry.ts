/**
 * Back-compat shims over the new {@link ProviderRegistry} (ADR-0025).
 *
 * Historically this file held the provider-factory switch and the
 * provider → env-var map. Both have moved to `providers.ts` where each
 * `ProviderDefinition` owns its own factory and env-key convention.
 * The exports below remain for callers that pre-date the registry;
 * they consult the process-wide default registry under the hood.
 *
 * New code should take a `ProviderRegistry` instance explicitly and
 * call `.get(id)?.create({ token, model })` directly.
 */

import type { LanguageModel } from "ai";
import type { SecretValue } from "@murmurations-ai/core";

import { defaultRegistry } from "../providers.js";
import type { ProviderId } from "../types.js";

export interface ProviderRegistryConfig {
  readonly provider: ProviderId;
  readonly model: string;
  readonly token: SecretValue | null;
  readonly baseUrl?: string | undefined;
}

/**
 * Create a Vercel AI SDK `LanguageModel` for the given provider.
 * Deprecated in favor of {@link ProviderRegistry.get}`(id).create(...)`.
 */
export const createVercelModel = async (config: ProviderRegistryConfig): Promise<LanguageModel> => {
  const def = defaultRegistry().get(config.provider);
  if (!def) {
    throw new Error(
      `createVercelModel: provider "${config.provider}" is not registered (register it on a ProviderRegistry or drop an extension that registers it)`,
    );
  }
  return def.create({
    token: config.token,
    model: config.model,
    ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
  });
};

/**
 * Env-var name each provider expects its API key under.
 *
 * Deprecated free-function form. Prefer `registry.envKeyName(id)` on
 * a `ProviderRegistry` you own — that way extension-registered
 * providers are reachable. This shim consults the default registry,
 * which only contains the four built-ins.
 */
export const providerEnvKeyName = (provider: ProviderId): string | undefined => {
  const name = defaultRegistry().envKeyName(provider);
  // `null` (keyless providers like Ollama) and `undefined` (unknown) both
  // collapse to `undefined` here for parity with the pre-registry signature.
  return name ?? undefined;
};
