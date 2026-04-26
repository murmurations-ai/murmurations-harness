# OpenAI Codex OAuth Provider Design

Date: 2026-04-25
Status: Draft

## Purpose

Enable Murmuration Harness operators to power agents with an OpenAI ChatGPT/Codex subscription through an OAuth-backed provider, without confusing that path with the existing OpenAI API-key provider.

The target operator experience is:

```yaml
llm:
  provider: openai-codex
  model: <codex-model-id>
```

and:

```sh
murmuration auth login --provider openai-codex
```

The existing OpenAI API path remains unchanged:

```yaml
llm:
  provider: openai
  model: gpt-4o
```

with:

```sh
OPENAI_API_KEY=sk-...
```

## Research Summary

OpenClaw supports ChatGPT/Codex subscription use by treating it as a separate provider route, not as a different credential for the normal OpenAI API provider.

OpenClaw's documented routes are:

- `openai/*`: direct OpenAI Platform API with `OPENAI_API_KEY` against `api.openai.com`.
- `openai-codex/*`: ChatGPT/Codex OAuth against `https://chatgpt.com/backend-api/codex`.
- `openai/*` plus a `codex` runtime: native Codex app-server execution, where Codex owns more of the loop and thread state.

Relevant OpenClaw references:

- `https://docs.openclaw.ai/providers/openai`
- `https://docs.openclaw.ai/concepts/model-providers`
- `https://docs.openclaw.ai/concepts/agent-runtimes`
- `https://raw.githubusercontent.com/openclaw/openclaw/main/extensions/openai/openai-codex-provider.ts`
- `https://raw.githubusercontent.com/openclaw/openclaw/main/src/plugins/provider-openai-codex-oauth.ts`
- `https://raw.githubusercontent.com/openclaw/openclaw/main/extensions/openai/base-url.ts`

The Murmuration Harness currently cannot support this as a configuration-only change. The current provider contract is API-key oriented:

```ts
envKeyName: string | null;
create(opts: { token: SecretValue | null; model: string; baseUrl?: string }): Promise<LanguageModel>;
```

Current constraints in this repository:

- `packages/cli/src/builtin-providers/openai.ts` constructs OpenAI with `@ai-sdk/openai` and `OPENAI_API_KEY`.
- `packages/llm/src/providers.ts` supports only API-key or keyless provider declarations.
- `packages/llm/src/client.ts` expects providers to create Vercel AI SDK `LanguageModel` values.
- `packages/cli/src/boot.ts`, `packages/cli/src/group-wake.ts`, and `packages/cli/src/spirit/client.ts` each resolve provider auth separately.
- `packages/core/src/identity/index.ts` and `packages/cli/src/harness-config.ts` still constrain provider values to the built-in provider set in important paths, despite ADR-0025's open-provider direction.

The design assumes OpenAI permits Codex subscription OAuth for external tools and workflows. Before implementation, verify the current OpenAI/Codex policy and the stability of the OAuth and backend endpoints. If the route is not official or supportable, do not ship this provider as a built-in; keep the auth architecture work and defer the `openai-codex` provider to an operator extension or experimental package.

## Goals

- Add a first-class `openai-codex` provider for ChatGPT/Codex OAuth-backed text generation only if the OAuth and backend route can be verified as supportable.
- Keep `openai` as the direct API-key OpenAI provider.
- Support daemon wakes, group meetings, Spirit REPL, init, doctor, and provider listing through one shared provider/auth resolution path.
- Store OAuth credentials outside `harness.yaml`, `.env`, and role frontmatter.
- Refresh OAuth tokens safely for long-running daemons.
- Provide clear operator diagnostics when a profile is missing, expired, unsupported, or unauthorized.

## Non-Goals

- Do not make `openai` silently use ChatGPT/Codex subscription auth.
- Do not implement a native Codex app-server runtime in the first version.
- Do not browser-automate ChatGPT.
- Do not add embeddings, image, audio, or video support through Codex OAuth in this design.
- Do not persist OAuth tokens in general config files.

## Recommended Approach

Add `openai-codex` as a first-class OAuth provider and introduce an auth-profile layer shared by all LLM surfaces.

This mirrors OpenClaw's clean separation between direct API billing and subscription auth while preserving this harness's own wake, governance, and action execution lifecycle.

Alternative approaches considered:

- A minimal bearer-token `.env` provider would be faster to prototype, but access tokens expire and the operator experience would be fragile.
- A native Codex runtime would be powerful but much larger than needed. It would raise thread-state, tool-loop, and compaction ownership questions that are unrelated to enabling subscription-backed agent wakes.

## Provider Auth Contract

Replace the API-key-only provider auth contract with an explicit auth kind.

```ts
type ProviderAuth =
  | { readonly kind: "api-key"; readonly envKeyName: string }
  | { readonly kind: "oauth"; readonly profileProvider: string }
  | { readonly kind: "keyless" };

interface ProviderDefinition {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly auth: ProviderAuth;
  readonly tiers?: Readonly<Record<ModelTier, string>>;
  create(opts: ProviderCreateOptions): Promise<LanguageModel>;
}
```

Compatibility mapping:

- Gemini: `{ kind: "api-key", envKeyName: "GEMINI_API_KEY" }`
- Anthropic: `{ kind: "api-key", envKeyName: "ANTHROPIC_API_KEY" }`
- OpenAI: `{ kind: "api-key", envKeyName: "OPENAI_API_KEY" }`
- Ollama: `{ kind: "keyless" }`
- OpenAI Codex: `{ kind: "oauth", profileProvider: "openai-codex" }`

Keep `envKeyName(id)` as a compatibility helper temporarily, but move new code to `provider.auth`.

## Auth Profiles

Add a dedicated local auth store under the murmuration runtime directory:

```text
.murmuration/auth-profiles.json
.murmuration/auth-state.json
```

`auth-profiles.json` stores credentials. `auth-state.json` stores routing and operational state such as cooldowns, last-used timestamps, and disabled profiles.

This store is separate from the existing `SecretsProvider` contract because OAuth credentials are mutable: access tokens expire, refresh writes new credential material, and multiple daemon processes may contend for the same profile. `AuthProfileStore` is the single writer for OAuth credential mutation. `SecretsProvider` remains the source for static API keys and other declared secrets.

Store requirements:

- Create `.murmuration/` with safe parent-directory checks before writing auth files.
- Refuse to write through symlinks for auth-profile paths.
- Write files with `0600` permissions.
- Use atomic write-and-rename semantics.
- Use a lock file for refresh mutations.
- Preserve a future interface boundary so non-file secret backends can implement an OAuth-capable auth-profile store later.

Runtime credential shape:

```ts
type AuthCredential =
  | {
      readonly type: "api_key";
      readonly provider: string;
      readonly keyRef: SecretKey;
      readonly email?: string;
    }
  | {
      readonly type: "oauth";
      readonly provider: string;
      readonly access: SecretValue;
      readonly refresh: SecretValue;
      readonly expiresAt: string;
      readonly accountId?: string;
      readonly email?: string;
    };
```

Persisted JSON must not store `SecretValue` objects directly. In this repo, `SecretValue.toJSON()` redacts the value, so persisting `SecretValue` would destroy the credential. Use separate persistence DTOs with raw strings read only inside the auth-profile store boundary, then wrap with `makeSecretValue()` after loading.

Persisted credential DTO shape:

```ts
type PersistedAuthCredential =
  | {
      readonly type: "api_key";
      readonly provider: string;
      readonly keyRef: string;
      readonly email?: string;
    }
  | {
      readonly type: "oauth";
      readonly provider: string;
      readonly access: string;
      readonly refresh: string;
      readonly expiresAt: string;
      readonly accountId?: string;
      readonly email?: string;
    };
```

Only `AuthProfileStore` may convert between persisted DTOs and runtime `SecretValue` credentials.

The store must be created with `0600` permissions. OAuth tokens must never be written to logs, config files, role frontmatter, or generated documentation.

## OAuth Login Flow

Add CLI commands:

```sh
murmuration auth login --provider openai-codex
murmuration auth login --provider openai-codex --device-code
murmuration auth status
murmuration auth logout --provider openai-codex
```

The browser flow should use PKCE with a localhost callback when possible. A device-code or manual redirect fallback should support headless and remote operators.

Protocol gate before implementation:

- Confirm whether OpenAI documents or otherwise explicitly supports Codex OAuth for third-party CLI tools.
- Confirm the authorization, token, refresh, and inference endpoints to use.
- Prefer an official SDK or documented flow if available.
- If using a third-party helper, pin and document the dependency, its endpoint assumptions, and update responsibility.
- Add a feature flag or experimental warning if any part of the route depends on undocumented backend behavior.
- Define a shutdown path if OpenAI changes the route: clear diagnostic, no retry storm, and no silent fallback to the paid API-key provider.

The login implementation records:

- provider id: `openai-codex`
- access token
- refresh token
- expiry
- account id when available
- email or stable profile label when available

If OpenAI publishes or maintains an official SDK/library for Codex OAuth, prefer that over hand-rolled protocol code. If the implementation relies on a third-party OAuth helper, document the dependency and the upstream endpoints it uses.

## Token Refresh

The auth resolver should refresh OAuth tokens before use when they are expired or near expiry.

Resolution must happen at the wake or request boundary, not only when `createLLMClient()` first constructs an adapter. The current LLM client caches its adapter after first use, so OAuth providers need one of these concrete strategies:

- Preferred: create an OAuth-aware adapter that asks `AuthResolver` for a fresh token before every outbound request.
- Acceptable for daemon/group wakes: construct a fresh client per wake and resolve auth immediately before the wake's LLM call.
- Required for Spirit: re-resolve or refresh auth before each turn because a Spirit session may outlive an access token.

Do not capture an OAuth access token in a long-lived cached adapter without refresh support.

Refresh requirements:

- Use a file lock around refresh for each profile.
- Persist the refreshed credential atomically.
- Detect refresh-token reuse/contention and surface a re-authentication message.
- Avoid multiple daemon processes refreshing the same profile simultaneously.
- Preserve account identity metadata across refreshes.

Failure modes should be typed:

- `OAuthProfileMissingError`
- `OAuthTokenExpiredError`
- `OAuthRefreshFailedError`
- `OAuthRefreshContentionError`
- `ProviderAuthUnsupportedError`
- `ProviderTransportUnsupportedError`

## Shared Auth Resolution

Create an `AuthResolver` used by every LLM-consuming surface.

Input:

- provider registry
- provider id
- root directory
- optional preferred profile id
- existing `.env` secrets provider for API keys

Output:

```ts
type ResolvedProviderAuth =
  | { readonly kind: "api-key"; readonly token: SecretValue }
  | { readonly kind: "oauth"; readonly token: SecretValue; readonly accountId?: string }
  | { readonly kind: "keyless" };
```

`ProviderCreateOptions` must include a request-bound auth supplier so OAuth providers cannot accidentally capture stale access tokens during adapter construction.

```ts
interface ProviderCreateOptions {
  readonly provider: ProviderId;
  readonly model: string;
  readonly baseUrl?: string;
  readonly auth: ResolvedProviderAuth;
  readonly resolveAuth: () => Promise<ResolvedProviderAuth>;
}
```

API-key and keyless providers may use `auth` directly. OAuth providers must call `resolveAuth()` before each outbound request or otherwise prove that their adapter refreshes before token expiry. This requirement applies even when `LLMClient` caches provider runtimes.

Resolution behavior:

- `api-key`: read from `.env` or process environment using the provider's `envKeyName`.
- `oauth`: read and refresh a matching auth profile.
- `keyless`: return no token.

Call sites to migrate:

- daemon boot and per-wake client construction
- `murmuration convene` / group wake
- Spirit REPL client initialization
- doctor live checks
- init/onboarding
- provider listing

## Transport

The current LLM package wraps Vercel AI SDK `generateText()` in `VercelAdapter`. Codex OAuth may not fit cleanly into the existing Vercel provider contract because the route is `chatgpt.com/backend-api/codex`, not the normal OpenAI API.

Preferred design:

- Allow `ProviderDefinition` to create either a Vercel `LanguageModel` or a harness-native `LLMAdapter`.
- Keep existing built-ins on the Vercel path.
- Implement `openai-codex` as a custom adapter if the Codex backend cannot be represented correctly as a Vercel `LanguageModel`.
- Promote `LLMAdapter` to a documented public contract from `@murmurations-ai/llm` if provider definitions are allowed to return native adapters.

Possible shape:

```ts
type ProviderRuntime =
  | { readonly kind: "vercel"; readonly model: LanguageModel }
  | { readonly kind: "adapter"; readonly adapter: LLMAdapter };

interface ProviderDefinition {
  create(opts: ProviderCreateOptions): Promise<ProviderRuntime>;
}
```

This keeps the existing `LLMClient.complete()` facade stable for daemon, group, and Spirit callers.

Native adapter responsibilities:

- Map `LLMRequest` to provider payloads.
- Preserve abort handling.
- Preserve telemetry metadata.
- Invoke cost hooks with token counts when available.
- Map provider errors to existing typed `LLMClientError` values.
- Report capabilities honestly, including tool use and JSON support.
- Support multi-step tool loops or declare that tool use is unsupported.

If Codex OAuth cannot support the same tool loop semantics as the Vercel path, the provider must fail fast for agents requiring tools and print a clear diagnostic. It must not silently ignore tools, because group actions and agent plugins depend on structured tool behavior.

## OpenAI Codex Provider

Register a built-in provider:

```ts
export const openaiCodexProvider: ProviderDefinition = {
  id: "openai-codex",
  displayName: "OpenAI Codex",
  auth: { kind: "oauth", profileProvider: "openai-codex" },
  tiers: {
    fast: "<verified-fast-model>",
    balanced: "<verified-balanced-model>",
    deep: "<verified-deep-model>",
  },
  create: async (opts) => createOpenAICodexRuntime(opts),
};
```

Do not hardcode launch tier defaults until live Codex OAuth model availability is verified. If no reliable catalog is available, omit `tiers` for the first implementation and require operators to specify an explicit `llm.model`.

The transport base URL should be explicit and separated from the direct API provider:

```ts
const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
```

The provider should not accept `OPENAI_API_KEY`, and the direct `openai` provider should not consume OAuth profiles.

## Config And Validation

Complete ADR-0025's open-provider migration across the CLI and core packages.

Required changes:

- Widen `harness.yaml` `llm.provider` from the built-in union to string.
- Widen `role.md` `llm.provider` from the built-in union to string.
- Validate provider values against the live registry after built-ins and extensions are registered.
- Replace hardcoded provider default models in group wake and Spirit with registry tier resolution.
- Ensure provider extensions are loaded before validation paths that need the complete registry.

Unknown providers should produce a diagnostic listing registered providers and, when applicable, instructions for adding an extension.

## CLI And UX

`murmuration init` should offer:

- Gemini API key
- Anthropic API key
- OpenAI API key
- OpenAI Codex OAuth
- Ollama local
- Custom extension provider

If the operator chooses OpenAI Codex OAuth, init should offer to run `murmuration auth login --provider openai-codex` and then write:

```yaml
llm:
  provider: openai-codex
  model: <selected-codex-model-id>
```

The model should come from a verified live catalog, a documented static allowlist, or an explicit operator entry. If model discovery is unavailable, init should ask for the model rather than guess.

`murmuration providers list` should include auth kind:

```text
openai        OpenAI         api-key   OPENAI_API_KEY
openai-codex  OpenAI Codex   oauth     profile:openai-codex
ollama        Ollama         keyless
```

`murmuration doctor --live` should check:

- provider is registered
- required auth exists
- OAuth profile expiry status
- refresh succeeds when needed
- a lightweight provider probe succeeds when safe

## Cost And Usage

Subscription-backed usage is not the same as token-metered OpenAI Platform billing.

Initial behavior:

- Record input/output token counts when available.
- Mark cost as subscription-backed rather than API-priced.
- Do not pretend Codex OAuth usage has OpenAI API prices unless verified.

Required cost schema change:

```ts
type LlmBillingMode = "metered-usd" | "subscription" | "unknown";
```

Cost records should include `billingMode`. For subscription or unknown billing modes, USD cost should be omitted or explicitly marked unknown instead of silently recording zero as if the call were free.

Budget enforcement must remain conservative. If an agent has a USD budget and a provider returns `billingMode: "unknown"`, the wake should require an explicit configuration choice: either allow unknown-cost subscription calls or block them. Token budgets can still apply when token counts are available.

Future work can add usage-window or quota reporting if the Codex backend exposes a stable usage endpoint.

## Security And Redaction

Security requirements:

- Store auth profiles at `0600`.
- Ensure auth parent directories are not world-writable and auth paths are not symlinks.
- Refresh credentials with atomic writes under a lock.
- Never print token values.
- Redact OAuth access tokens, refresh tokens, bearer tokens, and JWT-like values.
- Keep `.env` API-key support separate from OAuth profile storage.
- Avoid writing OAuth material into generated meeting minutes, run artifacts, logs, or traces.
- Treat remote/headless OAuth flows as sensitive and avoid displaying user codes except where required.

Redaction should be expanded in `packages/core/src/secrets/index.ts` to include JWT-like and OAuth-token-shaped values, not only API-key prefixes.

## Error Handling

Operator-facing messages should be specific.

Examples:

- Missing profile: `OpenAI Codex auth profile missing. Run: murmuration auth login --provider openai-codex`.
- Expired and refresh failed: `OpenAI Codex OAuth refresh failed. Re-authenticate with: murmuration auth login --provider openai-codex`.
- Wrong provider route: `Provider openai uses OPENAI_API_KEY. Use provider openai-codex for ChatGPT/Codex OAuth.`
- Unavailable model: `Model gpt-5.5 is not available for this OpenAI Codex account. Run: murmuration providers list --models`.

## Testing Strategy

Unit tests:

- provider auth contract validation
- auth profile parsing and permissions
- expiry and refresh decision logic
- refresh locking behavior
- concurrent refresh across simulated daemon processes
- redaction for OAuth/JWT-like values
- safe path, symlink refusal, and file permission behavior
- provider registry open-string validation

Integration tests:

- daemon boots with `openai-codex` and a mocked valid profile
- daemon reports clear skip/error with missing profile
- group wake uses the shared auth resolver
- Spirit uses the shared auth resolver
- init writes `openai-codex` config after mocked OAuth login
- doctor reports missing, expired, refresh-failed, and valid profile states
- logout removes credentials and leaves no usable access token behind
- logout removes local credentials and revokes tokens when the provider exposes a supported revocation endpoint
- generated meeting minutes, run artifacts, traces, and logs do not contain OAuth material

Regression tests:

- `openai` still requires `OPENAI_API_KEY`
- `openai` never falls back to `openai-codex`
- `openai-codex` never consumes `OPENAI_API_KEY`
- Ollama remains keyless
- existing Gemini, Anthropic, and OpenAI API-key configurations continue to boot

## Phasing

### Phase 1: Auth and provider architecture

- Extend `ProviderDefinition` with explicit auth kinds.
- Add auth profile store and resolver.
- Finish open-string provider migration from ADR-0025 across core and CLI schemas.
- Refactor daemon, group wake, Spirit, init, doctor, and provider listing to use the shared registry/auth resolver.
- Preserve existing API-key and keyless behavior.

### Phase 2: OpenAI Codex OAuth provider

- Add `openai-codex` as a built-in provider.
- Add `murmuration auth login/status/logout` commands.
- Implement OAuth login and device-code fallback.
- Implement token refresh with locking.
- Implement Codex transport as a custom adapter or verified Vercel-compatible model wrapper.
- Add docs and live doctor checks.

### Phase 3: Usage, catalogs, and polish

- Add model catalog discovery if a stable endpoint is available.
- Add usage/quota visibility if a stable endpoint is available.
- Add profile selection and failover if multiple OAuth accounts are configured.
- Consider a separate ADR for native Codex runtime integration.

## Open Questions

- Which OAuth helper or protocol implementation should this project use, and what maintenance/security obligations does that create?
- Can Codex OAuth traffic be wrapped cleanly as a Vercel AI SDK `LanguageModel`, or should `ProviderDefinition` support native `LLMAdapter` creation?
- Should auth profiles live at the murmuration root or per agent? The recommended first version is root-level profiles with optional future per-agent profile selection.
- How should subscription-backed usage appear in existing cost reports?
- Which Codex models should be tier defaults at launch, and how should unavailable models be diagnosed?

## Acceptance Criteria

- An operator can authenticate with OpenAI Codex OAuth through the CLI.
- An agent configured with `provider: openai-codex` can complete a daemon wake.
- Group wake and Spirit can use the same provider/auth path.
- Missing or expired OAuth credentials produce actionable diagnostics.
- Existing `openai` API-key behavior is unchanged.
- OAuth tokens are stored securely and redacted from logs.
- Refresh is atomic and safe under concurrent daemon processes.
- Logout removes stored credentials for the selected profile/provider. If the provider exposes token revocation, logout revokes before deleting; otherwise the CLI documents that already-issued access tokens may remain valid until expiry.
- Generated meeting minutes, run artifacts, traces, and logs do not contain OAuth material.
- Tool-use behavior is either supported and tested or explicitly rejected with clear diagnostics.
- Subscription-backed cost records are not silently reported as free API calls.
- Model defaults are based on verified catalog data or operators must explicitly select a model.
- Tests cover auth resolution, refresh, validation, security behavior, and non-regression for existing providers.
