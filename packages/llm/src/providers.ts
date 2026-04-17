/**
 * ProviderRegistry — pluggable registry of LLM providers (ADR-0025).
 *
 * The harness ships with four built-in providers (Gemini, Anthropic,
 * OpenAI, Ollama) that match the Vercel AI SDK's first-party adapters.
 * Extensions (ADR-0023) can register additional providers at daemon
 * boot by calling `api.registerProvider(definition)` in their
 * `registerProviders(api)` hook (wired in Phase 2).
 *
 * This file is the single source of truth for:
 *   - provider identity + display name
 *   - env-var convention for each provider's API key
 *   - model-tier mappings for each provider
 *   - how to construct a Vercel AI SDK `LanguageModel` for a provider
 *
 * Callers that previously consulted hardcoded switches, inline maps,
 * or the deprecated free functions (`providerEnvKeyName`,
 * `resolveModelForTier`) should obtain a `ProviderRegistry` instance
 * and ask it instead.
 */

import type { LanguageModel } from "ai";

import type { SecretValue } from "@murmurations-ai/core";

import type { ModelTier, ProviderId } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Arguments passed to a provider's `create` factory. */
export interface ProviderCreateOptions {
  readonly token: SecretValue | null;
  readonly model: string;
  /** Optional override for the provider's API base URL (proxies, self-hosted, etc). */
  readonly baseUrl?: string;
}

/** A registered provider — everything the harness needs to use it. */
export interface ProviderDefinition {
  readonly id: ProviderId;
  readonly displayName: string;
  /** Env-var name for this provider's API key. `null` means keyless
   *  (e.g. Ollama runs locally and needs no key). */
  readonly envKeyName: string | null;
  /** Optional model-tier fallback table. When absent, tier-based
   *  resolution fails loudly — the operator must pin an explicit model
   *  in `harness.yaml` or `role.md`. */
  readonly tiers?: Readonly<Record<ModelTier, string>>;
  /** Construct a Vercel AI SDK `LanguageModel` for this provider + model. */
  create(opts: ProviderCreateOptions): Promise<LanguageModel>;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class ProviderRegistry {
  readonly #byId = new Map<string, ProviderDefinition>();

  /** Register a provider. Throws if the id is already taken. */
  public register(def: ProviderDefinition): void {
    if (this.#byId.has(def.id)) {
      throw new Error(`ProviderRegistry: provider id "${def.id}" is already registered`);
    }
    this.#byId.set(def.id, def);
  }

  public has(id: ProviderId): boolean {
    return this.#byId.has(id);
  }

  public get(id: ProviderId): ProviderDefinition | undefined {
    return this.#byId.get(id);
  }

  public list(): readonly ProviderDefinition[] {
    return [...this.#byId.values()];
  }

  /** Env-var name for `id`'s API key, or `null` if keyless.
   *  Returns `undefined` when the provider is not registered. */
  public envKeyName(id: ProviderId): string | null | undefined {
    const def = this.#byId.get(id);
    if (!def) return undefined;
    return def.envKeyName;
  }

  /** Resolve a tier to a concrete model for the given provider.
   *  Returns `undefined` when the provider is not registered or has
   *  no tier table. */
  public resolveModelForTier(id: ProviderId, tier: ModelTier): string | undefined {
    return this.#byId.get(id)?.tiers?.[tier];
  }
}

// ---------------------------------------------------------------------------
// Built-in providers
// ---------------------------------------------------------------------------

const GEMINI_PROVIDER: ProviderDefinition = {
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

const ANTHROPIC_PROVIDER: ProviderDefinition = {
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

const OPENAI_PROVIDER: ProviderDefinition = {
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

const OLLAMA_PROVIDER: ProviderDefinition = {
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
      apiKey: "ollama",
    });
    return ollama(model);
  },
};

export const BUILT_IN_PROVIDERS: readonly ProviderDefinition[] = [
  GEMINI_PROVIDER,
  ANTHROPIC_PROVIDER,
  OPENAI_PROVIDER,
  OLLAMA_PROVIDER,
];

// ---------------------------------------------------------------------------
// Default registry + singleton for back-compat shims
// ---------------------------------------------------------------------------

/** Build a fresh `ProviderRegistry` with the four built-in providers
 *  pre-registered. Callers that accept extension contributions
 *  (daemon boot, Spirit init) should use this and then allow
 *  additional registrations before sealing. */
export const createDefaultRegistry = (): ProviderRegistry => {
  const registry = new ProviderRegistry();
  for (const def of BUILT_IN_PROVIDERS) {
    registry.register(def);
  }
  return registry;
};

/** Process-wide default registry. Used by the back-compat free
 *  functions (`providerEnvKeyName`, `resolveModelForTier`,
 *  `createVercelModel`) that pre-date the registry. Phase 2 will
 *  discourage implicit-singleton use and favor explicit injection. */
let DEFAULT_REGISTRY: ProviderRegistry | null = null;

export const defaultRegistry = (): ProviderRegistry => {
  DEFAULT_REGISTRY ??= createDefaultRegistry();
  return DEFAULT_REGISTRY;
};
