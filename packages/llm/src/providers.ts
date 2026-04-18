/**
 * ProviderRegistry — pluggable registry of LLM providers (ADR-0025).
 *
 * This package carries zero hardcoded provider knowledge as of Phase 3.
 * Provider definitions (Gemini, Anthropic, OpenAI, Ollama, Mistral,
 * Groq, Vertex AI, etc.) live outside this file — shipped as built-in
 * defaults with the CLI, as third-party extensions, or as operator-
 * authored extensions. Each provider is a `ProviderDefinition` that
 * owns its identity, display name, env-key convention, tier table,
 * and Vercel SDK construction.
 *
 * Callers construct a `ProviderRegistry`, register the providers they
 * intend to support, and consult it for env-key lookup, tier
 * resolution, and `LanguageModel` construction.
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
// Default registry + singleton
// ---------------------------------------------------------------------------

/** Build an empty `ProviderRegistry`. Callers populate it with
 *  `register(def)` — from CLI built-ins, from extensions, or from
 *  any other source they own. */
export const createDefaultRegistry = (): ProviderRegistry => new ProviderRegistry();

/**
 * Process-wide default registry. Starts empty. The CLI boot path
 * (and tests that use back-compat shims) seeds it by calling
 * `seedDefaultRegistry(...)` before any code consults the singleton.
 * Callers that want a clean registry should prefer
 * {@link createDefaultRegistry} + explicit dependency injection.
 */
let DEFAULT_REGISTRY: ProviderRegistry | null = null;

export const defaultRegistry = (): ProviderRegistry => {
  DEFAULT_REGISTRY ??= new ProviderRegistry();
  return DEFAULT_REGISTRY;
};

/** Populate the process-wide default registry with a known set of
 *  providers. Idempotent — repeat registrations of the same id are
 *  skipped rather than thrown, so CLI boot can call this once at
 *  startup without fighting tests that may have pre-seeded. */
export const seedDefaultRegistry = (defs: readonly ProviderDefinition[]): ProviderRegistry => {
  const registry = defaultRegistry();
  for (const def of defs) {
    if (!registry.has(def.id)) registry.register(def);
  }
  return registry;
};

// ---------------------------------------------------------------------------
// Validation — used by the daemon boot path when accepting
// extension-contributed provider definitions (ADR-0025 §3)
// ---------------------------------------------------------------------------

/**
 * Thrown when an extension's provider registration fails validation.
 * Fields are populated from the offending definition where possible.
 */
export class InvalidProviderDefinitionError extends Error {
  public constructor(
    message: string,
    public readonly extensionId: string,
    public readonly offending: unknown,
  ) {
    super(`[${extensionId}] ${message}`);
    this.name = "InvalidProviderDefinitionError";
  }
}

/**
 * Runtime validation for an `unknown` payload contributed by an
 * extension. Returns a typed `ProviderDefinition` or throws
 * {@link InvalidProviderDefinitionError} with a precise reason.
 *
 * The contract is enforced at the boundary so extensions written in
 * plain JavaScript can't corrupt the registry with malformed entries.
 */
export const validateProviderDefinition = (
  def: unknown,
  extensionId: string,
): ProviderDefinition => {
  if (!def || typeof def !== "object") {
    throw new InvalidProviderDefinitionError(
      "provider definition must be an object",
      extensionId,
      def,
    );
  }
  const rec = def as {
    id?: unknown;
    displayName?: unknown;
    envKeyName?: unknown;
    create?: unknown;
    tiers?: unknown;
  };

  if (typeof rec.id !== "string" || rec.id.length === 0) {
    throw new InvalidProviderDefinitionError("`id` must be a non-empty string", extensionId, def);
  }
  if (typeof rec.displayName !== "string" || rec.displayName.length === 0) {
    throw new InvalidProviderDefinitionError(
      "`displayName` must be a non-empty string",
      extensionId,
      def,
    );
  }
  if (rec.envKeyName !== null && typeof rec.envKeyName !== "string") {
    throw new InvalidProviderDefinitionError(
      "`envKeyName` must be a string or null",
      extensionId,
      def,
    );
  }
  if (typeof rec.create !== "function") {
    throw new InvalidProviderDefinitionError("`create` must be a function", extensionId, def);
  }
  if (rec.tiers !== undefined) {
    const tiers = rec.tiers;
    if (!tiers || typeof tiers !== "object") {
      throw new InvalidProviderDefinitionError(
        "`tiers` must be an object when present",
        extensionId,
        def,
      );
    }
    const tierRec = tiers as { fast?: unknown; balanced?: unknown; deep?: unknown };
    for (const key of ["fast", "balanced", "deep"] as const) {
      const v = tierRec[key];
      if (typeof v !== "string" || v.length === 0) {
        throw new InvalidProviderDefinitionError(
          `\`tiers.${key}\` must be a non-empty string when tiers are declared`,
          extensionId,
          def,
        );
      }
    }
  }

  return def as ProviderDefinition;
};
