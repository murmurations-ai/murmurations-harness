# ADR-0025 — Pluggable LLM provider registry

- **Status:** Proposed
- **Date:** 2026-04-17
- **Decision-maker(s):** Source (design)
- **Related:** ADR-0014 (LLM client), ADR-0020 (Vercel AI SDK migration), ADR-0023 (Extension system), ADR-0024 (Spirit of the Murmuration)

## Context

The harness hardcodes four LLM providers — `gemini`, `anthropic`, `openai`, `ollama` — across multiple sites:

- `ProviderId = "gemini" | "anthropic" | "openai" | "ollama"` as a closed union in `packages/llm/src/types.ts`
- `createVercelModel` with a four-case switch in `packages/llm/src/adapters/provider-registry.ts`
- `MODEL_TIER_TABLE: Record<ProviderId, Record<ModelTier, string>>` in `packages/llm/src/tiers.ts`
- `providerEnvKeyName` in `packages/llm/src/adapters/provider-registry.ts`
- Duplicated maps in `packages/cli/src/init.ts`, `packages/cli/src/boot.ts`, `packages/cli/src/group-wake.ts`

The underlying Vercel AI SDK supports a much wider set: `@ai-sdk/mistral`, `@ai-sdk/cohere`, `@ai-sdk/amazon-bedrock`, `@ai-sdk/fireworks`, `@ai-sdk/groq`, `@ai-sdk/xai`, `@ai-sdk/perplexity`, `@ai-sdk/google-vertex` (Google Cloud Vertex AI — hosts Anthropic, Meta, Mistral, and Google models under one API), `@ai-sdk/deepseek`, `@ai-sdk/cerebras`, and community adapters following the same shape. None of them are reachable today without forking the harness.

This ADR replaces the closed union with an extensible registry. Operators can add any Vercel-AI-SDK-compatible provider without patching the harness, through the same extension system established in ADR-0023.

### Related but distinct

This ADR is about **provider plurality**: supporting many LLM vendors. It does not change the harness's relationship with a single provider (e.g. the prompt-caching work for Anthropic, or Gemini thinking-token accounting). Each provider still exposes its own capabilities through the same `LLMClient` facade.

## Decision

### §1 — Widen `ProviderId` to an open string

Replace the closed union with an open type that preserves autocomplete for built-ins:

```ts
// packages/llm/src/types.ts
export const KNOWN_PROVIDERS = ["gemini", "anthropic", "openai", "ollama"] as const;
export type KnownProviderId = (typeof KNOWN_PROVIDERS)[number];
// Preserves autocomplete without closing the set.
export type ProviderId = KnownProviderId | (string & {});
```

Callers that had `switch(provider)` exhaustiveness on the union must either fall through to a registry lookup or declare a default. `LLMClientConfig` is widened correspondingly — unknown providers route through the registry rather than the existing switch.

### §2 — `ProviderRegistry` in `@murmurations-ai/llm`

A new class owns the provider lookup. Built-ins are registered automatically at construction; extensions register more via the hook in §3.

```ts
export interface ProviderDefinition {
  readonly id: ProviderId;
  /** Env-var name for the provider's API key. Null for keyless providers (e.g. Ollama). */
  readonly envKeyName: string | null;
  /** Instantiate a Vercel LanguageModel for this provider + model. */
  create(opts: { readonly token: SecretValue | null; readonly model: string; readonly baseUrl?: string }): Promise<LanguageModel>;
  /** Optional model-tier fallback table. If absent, tiers require an explicit model in config. */
  readonly tiers?: Readonly<Record<ModelTier, string>>;
  /** Human-readable name for logs + diagnostics. */
  readonly displayName: string;
}

export class ProviderRegistry {
  register(def: ProviderDefinition): void;
  has(id: ProviderId): boolean;
  get(id: ProviderId): ProviderDefinition | undefined;
  list(): readonly ProviderDefinition[];
  envKeyName(id: ProviderId): string | null | undefined;
  resolveModelForTier(id: ProviderId, tier: ModelTier): string | undefined;
}

export const createDefaultRegistry = (): ProviderRegistry; // registers the 4 built-ins
```

The registry is the single source of truth. Code in `@murmurations-ai/cli` consumes it exclusively — no inline provider strings, no duplicated env-key maps.

### §3 — Extension hook for provider registration

ADR-0023 extensions gain an optional `registerProviders(api)` entry point. An extension that wants to add Mistral ships its own SDK dependency and declares a provider:

```ts
// extensions/mistral/index.mjs
import { createMistral } from "@ai-sdk/mistral";

export default {
  id: "mistral-provider",
  version: "1.0.0",
  registerProviders(api) {
    api.registerProvider({
      id: "mistral",
      envKeyName: "MISTRAL_API_KEY",
      displayName: "Mistral",
      tiers: {
        fast: "mistral-small-latest",
        balanced: "mistral-large-latest",
        deep: "mistral-large-latest",
      },
      create: async ({ token, model }) => {
        const client = createMistral({ apiKey: token?.reveal() ?? "" });
        return client(model);
      },
    });
  },
};
```

Extensions are discovered at daemon boot by `packages/core/src/extensions/loader.ts` (already exists). The daemon constructs a `ProviderRegistry`, seeds it with built-ins, then invokes `registerProviders(api)` on every extension that exposes one. The registry is then passed through to anything that needs to resolve a provider (runner, Spirit, boot validation).

Extensions that only register providers (no tools, no skills) are legitimate — the registration hook is orthogonal to the tool hook added in ADR-0023.

### §4 — `harness.yaml` schema additions

No schema changes are required for operators who stick with the four built-ins. For operators that want more, the existing `extensions/` directory is the discovery mechanism — drop in a provider extension, it registers automatically.

Optional hints in `harness.yaml` for UX:

```yaml
llm:
  provider: mistral
  model: mistral-large-latest
  # Optional: pin a specific version of the model if the provider supports it.
```

Agents keep their `role.md` `llm:` frontmatter exactly as today. The `provider` field becomes a free-form string validated against the live registry at boot. An unknown provider fails boot with a clear diagnostic listing registered providers.

### §5 — Migration path

Zero breaking changes for existing murmurations:

- The four built-in providers are registered by default at construction, matching today's behavior bit-for-bit.
- Existing `role.md` files continue to validate.
- Existing `harness.yaml` files continue to parse.
- The duplicated provider → env-key maps in `boot.ts`, `group-wake.ts`, and `init.ts` are replaced with `registry.envKeyName(provider)` calls — pure internal refactor, no surface change.
- `resolveModelForTier(provider, tier)` becomes `registry.resolveModelForTier(provider, tier)` with the same behavior for built-ins.

Operators who want Mistral (or any other provider) add an extension. The day-zero experience is identical; day-one adds a clear upgrade path.

### §6 — CLI surface

One new read-only command:

```
murmuration providers list       # Show registered providers with their env-key + tier defaults
```

`murmuration init` prompt widens:

```
Default LLM provider [gemini]:   # accepts anything; suggests built-ins in help text
```

If the operator types an unknown provider, `init` still scaffolds `harness.yaml` with that value and emits a note: _"Unknown provider 'mistral' — drop an extension at `extensions/mistral/` to register it before booting the daemon. See docs/provider-extensions.md."_

## Consequences

**Positive:**

- Any Vercel-AI-SDK-compatible provider becomes reachable without patching the harness.
- Single source of truth for provider identity, env-key convention, and tier tables.
- Consistent extension model — provider registration reuses the ADR-0023 machinery.
- Operators own their provider dependencies: extensions bundle the `@ai-sdk/*` SDK and any auth conventions.
- Vertex AI (via `@ai-sdk/google-vertex`) becomes a first-class option for operators who want to host Claude on GCP.

**Negative:**

- Adding a provider now requires either using the built-in four or authoring a small extension. (Today: no option beyond the four.) Mitigate with shipped example extensions.
- Boot becomes slightly heavier — one pass over extensions to collect provider registrations. O(n) in extension count; not meaningful at realistic scale.
- Open type `string & {}` loses exhaustiveness checking on `provider` switches. Code that previously relied on exhaustiveness must route through the registry instead. This is the right shape but it's a refactor.

**Neutral:**

- Model tier tables for unknown providers require the operator to specify a concrete model in config. This is a conscious tradeoff — we cannot anticipate tier mappings for every SDK.
- Extensions that register providers are plain JavaScript, not declarative YAML. This is intentional: factory signatures and auth conventions vary too much between providers for pure config to work.

## Open questions

1. **Vertex AI auth** — `@ai-sdk/google-vertex` uses Application Default Credentials (ADC) rather than a simple API key. The `envKeyName` contract doesn't fit. Provider definitions may need an optional `authCheck(context)` hook for providers with non-key auth. Decide in Phase 2.

2. **Model tier coverage** — extensions that don't declare `tiers` require operators to always specify `llm.model` in config. Should the registry reject `tier-based` resolution for those providers at boot, or fall back to some harness-wide default? Proposal: reject explicitly — better an error than a wrong model.

3. **Provider versioning** — extensions declare a version, but the `ProviderRegistry` currently ignores it. If two extensions register the same provider id with different versions, last-write-wins. Acceptable for MVP; revisit if it becomes a real problem.

4. **Live model catalogs** — some providers expose a models API (e.g. OpenAI `/v1/models`). A future enhancement: `providers list --models` queries live catalogs via the provider's factory. Out of scope here.

5. **Registration order vs. extension order** — if two extensions register the same provider id, which wins? Proposal: explicit error at registration time; force the operator to resolve the conflict. Alternative: first-write-wins (built-ins never lose, since they register first). Decide in Phase 1 implementation.

## Implementation plan

Three phases, each independently shippable.

### Phase 1 — Core registry

- `ProviderRegistry` class in `@murmurations-ai/llm`
- `createDefaultRegistry()` pre-registers the four built-ins with existing behavior
- `ProviderId` widened to `KnownProviderId | (string & {})`
- `MODEL_TIER_TABLE` moved behind `registry.resolveModelForTier`
- `providerEnvKeyName` becomes `registry.envKeyName` (deprecate the free function over one release)
- Dedupe the four hardcoded maps in `boot.ts`, `group-wake.ts`, `init.ts` through the registry
- Registry construction happens once in `boot.ts` and is passed explicitly through to the runner, Spirit, and any other consumer — no module-level singleton

### Phase 2 — Extension integration

- Extend the ADR-0023 `Extension` interface with optional `registerProviders(api)`
- `packages/core/src/extensions/loader.ts` collects provider registrations at boot
- Daemon boot validates `harness.yaml llm.provider` against the registry; unknown provider → boot fails with registered-providers listing
- Spirit reads its provider through the same registry (ADR-0024 integration point)
- Example extension for one non-built-in provider (e.g. `extensions/mistral/`) as the canonical reference
- `murmuration providers list` CLI command
- Docs: `docs/provider-extensions.md` — authoring guide with the Mistral example worked through end-to-end

### Phase 3 — Polish + ecosystem

- Example extensions for 3-5 more providers (Vertex AI, Groq, Bedrock, xAI, Perplexity)
- `murmuration providers list --models` that queries live catalogs where available
- Address open question 1 (non-key auth) for Vertex
- Address open question 3 (version conflicts) if it's actually hurting
- Consider promoting popular community extensions into `@murmurations-ai/provider-*` packages bundled with the harness binary

Each phase is a separate release. Phase 1 alone is a meaningful internal improvement (single source of truth, no duplicated maps). Phase 2 is the operator-visible win. Phase 3 is ecosystem-facing.
