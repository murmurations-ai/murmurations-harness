# OpenAI Codex OAuth Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shared OAuth-capable LLM auth architecture and an `openai-codex` provider path that can power daemon wakes, group meetings, Spirit, init, doctor, and provider listing without changing existing OpenAI API-key behavior.

**Architecture:** First extend the provider/auth foundation so providers declare `api-key`, `oauth`, or `keyless` auth and every LLM surface resolves auth through one `AuthResolver`. Then add a secure auth-profile store and CLI auth commands. Finally add the `openai-codex` provider behind an explicit protocol gate, with request-bound token refresh and clear capability/cost semantics.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest, Zod, Vercel AI SDK, Node filesystem APIs, existing `SecretValue`/`DotenvSecretsProvider`, existing CLI command dispatcher.

---

## Spec Reference

Read before implementation:

- `docs/superpowers/specs/2026-04-25-openai-codex-oauth-design.md`
- `docs/ARCHITECTURE.md` Engineering Standards
- `docs/LINT-DESIGN-GUIDE.md`
- `docs/adr/0025-pluggable-llm-providers.md`

## File Structure

### New Files

- `packages/llm/src/auth.ts` — provider auth declaration and resolved auth types shared by provider definitions and clients.
- `packages/cli/src/llm-auth/auth-profile-store.ts` — root-level auth profile persistence with safe path checks, `0600`, DTO conversion, and atomic writes.
- `packages/cli/src/llm-auth/auth-state-store.ts` — runtime auth state persistence for last-used timestamps, cooldowns, disabled profiles, and future profile routing.
- `packages/cli/src/llm-auth/auth-resolver.ts` — resolves API-key, OAuth, and keyless auth for every LLM-consuming path.
- `packages/cli/src/llm-auth/auth-errors.ts` — typed auth errors and user-facing message helpers.
- `packages/cli/src/llm-auth/oauth-refresh.ts` — refresh decision helpers and lock-aware mutation seam.
- `packages/cli/src/llm-auth/auth-profile-store.test.ts` — auth profile store tests.
- `packages/cli/src/llm-auth/auth-state-store.test.ts` — auth state persistence tests.
- `packages/cli/src/llm-auth/auth-resolver.test.ts` — resolver tests.
- `packages/cli/src/auth-cmd.ts` — `murmuration auth` command handler.
- `packages/cli/src/builtin-providers/openai-codex.ts` — gated provider definition for `openai-codex`.
- `packages/llm/src/adapters/static-adapter.test.ts` or equivalent tests for native adapter support if adapter providers are introduced.

### Modified Files

- `packages/llm/src/providers.ts` — replace `envKeyName` as primary auth contract with `auth`, keep compatibility helper.
- `packages/llm/src/client.ts` — pass `ResolvedProviderAuth` and request-bound `resolveAuth` to providers; optionally accept native adapter provider runtimes.
- `packages/llm/src/adapters/adapter.ts` — promote `LLMAdapter` to a documented exported contract if provider-native adapters are needed.
- `packages/llm/src/index.ts` — export new auth and adapter contracts.
- `packages/llm/src/providers.test.ts` — update tests for `auth` and compatibility `envKeyName()`.
- `packages/cli/src/builtin-providers/*.ts` — migrate built-ins to `auth` declarations.
- `packages/cli/src/builtin-providers/index.ts` — register `openai-codex` only when protocol gate is enabled or resolved.
- `packages/cli/src/boot.ts` — use shared auth resolver for daemon agent clients.
- `packages/cli/src/group-wake.ts` — use shared registry/auth resolver.
- `packages/cli/src/spirit/client.ts` — use shared registry/auth resolver per turn or request-bound supplier.
- `packages/cli/src/harness-config.ts` — widen provider type to string.
- `packages/core/src/identity/index.ts` — widen role `llm.provider` to string and defer provider validation to registry-aware boot path.
- `packages/core/src/daemon/index.ts` or related registered agent types — widen registered LLM provider type as needed.
- `packages/cli/src/providers-cmd.ts` — show auth kind and compatibility env key.
- `packages/cli/src/doctor.ts` — report OAuth profile status and live auth diagnostics.
- `packages/cli/src/init.ts` and `packages/cli/src/init-secrets.ts` — add OpenAI Codex OAuth setup option without treating it as an API key.
- `packages/cli/src/bin.ts` — route `murmuration auth ...`.
- `packages/core/src/secrets/index.ts` — expand redaction for bearer/JWT/OAuth-shaped values.
- `packages/core/src/cost/*` and `packages/cli/src/boot.ts` cost hook path — add `billingMode` semantics.
- Relevant tests: `packages/core/src/identity/identity.test.ts`, `packages/core/src/secrets/secrets.test.ts`, `packages/core/src/cost/cost.test.ts`, `packages/cli/src/doctor.test.ts`, `packages/cli/src/init.test.ts`, `packages/cli/src/group-wake.test.ts`, `packages/cli/src/providers-cmd.test.ts` if present, and new CLI auth tests.

---

## Chunk 1: Provider Auth Contract

### Task 1: Add Explicit Provider Auth Types

**Files:**

- Create: `packages/llm/src/auth.ts`
- Modify: `packages/llm/src/providers.ts`
- Modify: `packages/llm/src/index.ts`
- Test: `packages/llm/src/providers.test.ts`

- [ ] **Step 1: Write failing provider auth contract tests**

Add tests to `packages/llm/src/providers.test.ts`:

```ts
it("stores api-key auth declarations and preserves envKeyName compatibility", () => {
  const r = new ProviderRegistry();
  r.register({
    id: "test-api",
    displayName: "Test API",
    auth: { kind: "api-key", envKeyName: "TEST_API_KEY" },
    create: () => Promise.resolve({ kind: "vercel", model: {} as never }),
  });

  expect(r.get("test-api")?.auth).toEqual({ kind: "api-key", envKeyName: "TEST_API_KEY" });
  expect(r.envKeyName("test-api")).toBe("TEST_API_KEY");
});

it("stores oauth auth declarations and returns undefined envKeyName compatibility", () => {
  const r = new ProviderRegistry();
  r.register({
    id: "openai-codex",
    displayName: "OpenAI Codex",
    auth: { kind: "oauth", profileProvider: "openai-codex" },
    create: () => Promise.resolve({ kind: "adapter", adapter: {} as never }),
  });

  expect(r.get("openai-codex")?.auth).toEqual({
    kind: "oauth",
    profileProvider: "openai-codex",
  });
  expect(r.envKeyName("openai-codex")).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run packages/llm/src/providers.test.ts`

Expected: FAIL because `ProviderDefinition.auth` and provider runtime union do not exist yet.

- [ ] **Step 3: Add auth and provider runtime types**

Create `packages/llm/src/auth.ts`:

```ts
import type { SecretValue } from "@murmurations-ai/core";

import type { ProviderId } from "./types.js";

export type ProviderAuth =
  | { readonly kind: "api-key"; readonly envKeyName: string }
  | { readonly kind: "oauth"; readonly profileProvider: string }
  | { readonly kind: "keyless" };

export type ResolvedProviderAuth =
  | { readonly kind: "api-key"; readonly token: SecretValue }
  | { readonly kind: "oauth"; readonly token: SecretValue; readonly accountId?: string }
  | { readonly kind: "keyless" };

export interface ProviderCreateOptions {
  readonly provider: ProviderId;
  readonly model: string;
  readonly baseUrl?: string;
  readonly auth: ResolvedProviderAuth;
  readonly resolveAuth: () => Promise<ResolvedProviderAuth>;
}
```

Update `packages/llm/src/providers.ts` to use `ProviderAuth` and `ProviderCreateOptions`. Keep `envKeyName()` as compatibility:

```ts
public envKeyName(id: ProviderId): string | null | undefined {
  const auth = this.#byId.get(id)?.auth;
  if (!auth) return undefined;
  if (auth.kind === "api-key") return auth.envKeyName;
  if (auth.kind === "keyless") return null;
  return undefined;
}
```

- [ ] **Step 4: Update validation**

Update `validateProviderDefinition()` to require `auth` and temporarily accept legacy `envKeyName` by normalizing it to `auth` during validation only if needed for existing extensions.

- [ ] **Step 5: Run focused tests**

Run: `npx vitest run packages/llm/src/providers.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add packages/llm/src/auth.ts packages/llm/src/providers.ts packages/llm/src/index.ts packages/llm/src/providers.test.ts
git commit -m "refactor(llm): add explicit provider auth contract"
```

### Task 2: Migrate Built-In Providers To Auth Declarations

**Files:**

- Modify: `packages/cli/src/builtin-providers/gemini.ts`
- Modify: `packages/cli/src/builtin-providers/anthropic.ts`
- Modify: `packages/cli/src/builtin-providers/openai.ts`
- Modify: `packages/cli/src/builtin-providers/ollama.ts`
- Modify: `packages/llm/src/client.ts`
- Test: `packages/llm/src/llm.test.ts`
- Test: `packages/llm/src/providers.test.ts`

- [ ] **Step 1: Write failing client/provider tests**

Add a test proving API-key providers receive `auth.token`, not `token` directly, and keyless providers receive `{ kind: "keyless" }`.

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run packages/llm/src/llm.test.ts packages/llm/src/providers.test.ts`

Expected: FAIL until built-ins and client creation use `auth`.

- [ ] **Step 3: Update built-ins**

Example `packages/cli/src/builtin-providers/openai.ts`:

```ts
export const openaiProvider: ProviderDefinition = {
  id: "openai",
  displayName: "OpenAI",
  auth: { kind: "api-key", envKeyName: "OPENAI_API_KEY" },
  tiers: { fast: "gpt-4o-mini", balanced: "gpt-4o", deep: "gpt-4-turbo" },
  create: async ({ auth, model, baseUrl }) => {
    if (auth.kind !== "api-key") throw new Error("OpenAI provider requires api-key auth");
    const { createOpenAI } = await import("@ai-sdk/openai");
    const openai = createOpenAI({
      apiKey: auth.token.reveal(),
      ...(baseUrl !== undefined ? { baseURL: baseUrl } : {}),
    });
    return { kind: "vercel", model: openai(model) };
  },
};
```

- [ ] **Step 4: Update `createLLMClient()`**

Change `LLMClientConfig` to accept `auth` and `resolveAuth`. Preserve a temporary compatibility helper for current call sites if needed, but all new code should use `auth`.

- [ ] **Step 5: Run focused tests**

Run: `npx vitest run packages/llm/src/llm.test.ts packages/llm/src/providers.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add packages/cli/src/builtin-providers packages/llm/src/client.ts packages/llm/src/llm.test.ts packages/llm/src/providers.test.ts
git commit -m "refactor(cli): migrate built-in providers to auth declarations"
```

---

## Chunk 2: Auth Profile Store And Resolver

### Task 3: Implement Secure Auth Profile Store

**Files:**

- Create: `packages/cli/src/llm-auth/auth-profile-store.ts`
- Create: `packages/cli/src/llm-auth/auth-profile-store.test.ts`

- [ ] **Step 1: Write failing tests for DTO conversion and safe persistence**

Test cases:

- saved OAuth DTO persists raw strings inside the file boundary
- loaded runtime credential wraps `access` and `refresh` with `SecretValue`
- auth file mode is `0600`
- symlink auth path is rejected
- world-writable auth parent directory is rejected
- parent directory is created safely
- malformed JSON returns a typed failure

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run packages/cli/src/llm-auth/auth-profile-store.test.ts`

Expected: FAIL because file does not exist.

- [ ] **Step 3: Implement store DTOs and load/save**

Core exports:

```ts
export interface PersistedOAuthCredential {
  readonly type: "oauth";
  readonly provider: string;
  readonly access: string;
  readonly refresh: string;
  readonly expiresAt: string;
  readonly accountId?: string;
  readonly email?: string;
}

export interface OAuthCredential {
  readonly type: "oauth";
  readonly provider: string;
  readonly access: SecretValue;
  readonly refresh: SecretValue;
  readonly expiresAt: string;
  readonly accountId?: string;
  readonly email?: string;
}
```

Implementation notes:

- Use `lstat` to reject symlink paths.
- Check parent directory mode and reject world-writable directories before writing.
- Use `writeFile` to a sibling temporary file with mode `0o600`, then `rename`.
- Never call `JSON.stringify()` on runtime `SecretValue` objects.

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run packages/cli/src/llm-auth/auth-profile-store.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add packages/cli/src/llm-auth/auth-profile-store.ts packages/cli/src/llm-auth/auth-profile-store.test.ts
git commit -m "feat(cli): add secure llm auth profile store"
```

### Task 4: Implement Auth State Store

**Files:**

- Create: `packages/cli/src/llm-auth/auth-state-store.ts`
- Create: `packages/cli/src/llm-auth/auth-state-store.test.ts`

- [ ] **Step 1: Write failing auth-state tests**

Cover:

- missing `.murmuration/auth-state.json` loads as empty state
- state persists `lastUsedAt`, `cooldownUntil`, and `disabledUntil` by profile id
- writes are atomic and use `0600`
- symlink state path is rejected
- world-writable parent directory is rejected

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run packages/cli/src/llm-auth/auth-state-store.test.ts`

Expected: FAIL because store does not exist.

- [ ] **Step 3: Implement auth-state store**

Use the same safe path and atomic write helpers as `AuthProfileStore`. Keep the first version simple: store state, but do not implement full profile rotation/cooldown routing yet.

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run packages/cli/src/llm-auth/auth-state-store.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add packages/cli/src/llm-auth/auth-state-store.ts packages/cli/src/llm-auth/auth-state-store.test.ts
git commit -m "feat(cli): add llm auth state store"
```

### Task 5: Implement Auth Resolver And Refresh Locking

**Files:**

- Create: `packages/cli/src/llm-auth/auth-errors.ts`
- Create: `packages/cli/src/llm-auth/oauth-refresh.ts`
- Create: `packages/cli/src/llm-auth/auth-resolver.ts`
- Create: `packages/cli/src/llm-auth/auth-resolver.test.ts`

- [ ] **Step 1: Write failing resolver tests**

Cover:

- API-key provider reads `.env` secret.
- Keyless provider returns `{ kind: "keyless" }`.
- OAuth provider loads a valid profile.
- Missing OAuth profile throws `OAuthProfileMissingError`.
- Expired OAuth profile calls refresh seam.
- Refresh preserves account metadata.
- Refresh acquires a per-profile lock before calling the refresh seam.
- Concurrent refresh attempts result in a single persisted refreshed credential.
- Refresh-token contention maps to `OAuthRefreshContentionError`.
- Non-contention refresh seam failure maps to `OAuthRefreshFailedError`.
- Refresh lock is released in `finally` after refresh failure.
- Expired token with no refresh available maps to `OAuthTokenExpiredError`.
- `openai` never consumes `openai-codex` profile.
- `openai-codex` never consumes `OPENAI_API_KEY`.

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run packages/cli/src/llm-auth/auth-resolver.test.ts`

Expected: FAIL because resolver does not exist.

- [ ] **Step 3: Implement typed errors**

Include error classes:

```ts
export class OAuthProfileMissingError extends Error {}
export class OAuthTokenExpiredError extends Error {}
export class OAuthRefreshFailedError extends Error {}
export class OAuthRefreshContentionError extends Error {}
export class ProviderAuthUnsupportedError extends Error {}
```

- [ ] **Step 4: Implement refresh locking**

In `oauth-refresh.ts`, add a lock wrapper that writes a per-profile lock file under `.murmuration/locks/`. The first implementation can be single-host filesystem locking only. It must acquire before refresh, re-read the profile after acquiring to avoid duplicate refresh, atomically persist refreshed credentials, detect refresh-token reuse/contention messages, throw `OAuthRefreshContentionError`, and release the lock in `finally`.

- [ ] **Step 5: Implement resolver**

Core function:

```ts
export async function resolveProviderAuth(args: {
  readonly rootDir: string;
  readonly providerRegistry: ProviderRegistry;
  readonly provider: ProviderId;
  readonly secretsProvider?: SecretsProvider;
  readonly preferredProfileId?: string;
}): Promise<ResolvedProviderAuth>;
```

- [ ] **Step 6: Run focused tests**

Run: `npx vitest run packages/cli/src/llm-auth/auth-resolver.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```sh
git add packages/cli/src/llm-auth/auth-errors.ts packages/cli/src/llm-auth/oauth-refresh.ts packages/cli/src/llm-auth/auth-resolver.ts packages/cli/src/llm-auth/auth-resolver.test.ts
git commit -m "feat(cli): add shared llm auth resolver"
```

---

## Chunk 3: Shared Resolution Across LLM Surfaces

### Task 6: Refactor Daemon Boot To Use Auth Resolver

**Files:**

- Modify: `packages/cli/src/boot.ts`
- Test: create `packages/cli/src/boot-llm-auth.test.ts` if no focused boot auth test exists

- [ ] **Step 1: Write failing daemon auth tests**

Add tests around `buildAgentClients` or extract testable helper if needed. Verify:

- API-key provider still constructs an LLM client.
- Missing API key still returns skip reason.
- OAuth provider missing profile returns actionable skip reason.
- OAuth provider with mocked valid profile constructs a client using request-bound `resolveAuth`.
- A daemon/boot integration test reaches the real daemon boot or wake-client construction path with `llm.provider: openai-codex` and a mocked valid profile.
- The same daemon/boot integration path reports a missing-profile diagnostic for `openai-codex`.
- Keyless provider still constructs an LLM client.

- [ ] **Step 2: Run targeted tests**

Run: `npx vitest run packages/cli/src/boot-llm-auth.test.ts`

Expected: FAIL until boot uses `resolveProviderAuth()`.

- [ ] **Step 3: Extract testable boot LLM-auth helper if needed**

If `buildAgentClients` is not exportable without broadening public surface, extract a narrow internal helper such as `buildLlmClientForAgent()` in `boot.ts` or `packages/cli/src/llm-auth/build-agent-llm-client.ts` and test that helper.

Do not stop at the helper test. Add an integration-level test that exercises the real boot path far enough to prove configured agents flow through shared auth resolution. Mock filesystem/auth-profile inputs and provider creation; do not call real LLM providers.

- [ ] **Step 4: Update boot client construction**

Replace direct `providerDef.envKeyName` checks with `resolveProviderAuth()`. Pass both `auth` and `resolveAuth` into `createLLMClient()`.

- [ ] **Step 5: Run focused verification**

Run: `npx vitest run packages/cli/src/boot-llm-auth.test.ts packages/cli/src/boot.test.ts && pnpm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add packages/cli/src/boot.ts packages/cli/src/boot-llm-auth.test.ts packages/cli/src/llm-auth/build-agent-llm-client.ts
git commit -m "refactor(cli): resolve daemon llm auth through shared resolver"
```

### Task 7: Refactor Group Wake And Spirit

**Files:**

- Modify: `packages/cli/src/group-wake.ts`
- Modify: `packages/cli/src/spirit/client.ts`
- Test: `packages/cli/src/group-wake.test.ts`
- Add: `packages/cli/src/spirit/client.test.ts` if absent and feasible

- [ ] **Step 1: Write failing tests**

Group wake tests:

- OAuth provider missing profile reports `murmuration auth login --provider openai-codex`.
- `openai-codex` with no tier table requires explicit `llm.model` instead of falling back to a hardcoded default.
- group wake resolves default models through `registry.resolveModelForTier()` when tiers exist.
- Keyless provider still works.

Spirit tests:

- Uses shared auth resolver.
- Re-resolves OAuth auth per turn or uses request-bound `resolveAuth` supplier.
- Removes hardcoded provider defaults; tier resolution comes from the registry and tierless providers require explicit models.

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run packages/cli/src/group-wake.test.ts packages/cli/src/spirit/client.test.ts`

Expected: FAIL until migration is implemented.

- [ ] **Step 3: Update group wake**

Build the provider registry once, resolve auth through `resolveProviderAuth()`, and pass request-bound auth supplier into `createLLMClient()`.

Remove hardcoded defaults for `openai`, `gemini`, `anthropic`, and `ollama`; use registry tier resolution. If a provider has no tiers and no explicit model, report a targeted error.

- [ ] **Step 4: Update Spirit**

Remove process-env-only token resolution. Use `resolveProviderAuth()` and ensure OAuth is re-resolved before every turn through `resolveAuth`.

Replace built-in default model maps with registry tier resolution and explicit-model requirements for tierless providers.

- [ ] **Step 5: Run focused tests**

Run: `npx vitest run packages/cli/src/group-wake.test.ts packages/cli/src/spirit/client.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add packages/cli/src/group-wake.ts packages/cli/src/spirit/client.ts packages/cli/src/group-wake.test.ts packages/cli/src/spirit/client.test.ts
git commit -m "refactor(cli): share llm auth resolution for group wake and spirit"
```

---

## Chunk 4: Open Provider Validation And UX

### Task 8: Finish Open-String Provider Migration

**Files:**

- Modify: `packages/cli/src/harness-config.ts`
- Modify: `packages/core/src/identity/index.ts`
- Modify: `packages/core/src/daemon/index.ts` or registered agent type file as needed
- Test: `packages/core/src/identity/identity.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests proving:

- `harness.yaml` can load `provider: openai-codex`.
- `role.md` can load `llm.provider: openai-codex`.
- typo diagnostics no longer hardcode only the four built-ins at parse time.

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run packages/core/src/identity/identity.test.ts`

Expected: FAIL because schemas reject unknown provider.

- [ ] **Step 3: Widen provider types to string**

Change `LLMProvider` in `harness-config.ts` and role schema provider validation to string. Move unknown-provider validation to registry-aware boot/command paths.

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run packages/core/src/identity/identity.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add packages/cli/src/harness-config.ts packages/core/src/identity/index.ts packages/core/src/daemon/index.ts packages/core/src/identity/identity.test.ts
git commit -m "refactor(core): allow registry-validated llm providers"
```

### Task 9: Update Providers List, Init, And Doctor

**Files:**

- Modify: `packages/cli/src/providers-cmd.ts`
- Modify: `packages/cli/src/init.ts`
- Modify: `packages/cli/src/init-secrets.ts`
- Modify: `packages/cli/src/doctor.ts`
- Test: `packages/cli/src/doctor.test.ts`
- Test: `packages/cli/src/init.test.ts`
- Test: `packages/cli/src/init-secrets.test.ts`

- [ ] **Step 1: Write failing UX tests**

Cover:

- providers list prints `api-key`, `oauth`, and `keyless` auth kinds.
- init offers OpenAI Codex OAuth without asking for `OPENAI_API_KEY`.
- init asks for explicit model input for `openai-codex` until verified tiers/catalogs exist.
- doctor reports missing OAuth profile with auth-login remediation.
- doctor does not validate Codex OAuth via `/v1/models` API-key path.

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run packages/cli/src/doctor.test.ts packages/cli/src/init.test.ts packages/cli/src/init-secrets.test.ts`

Expected: FAIL until UX paths understand auth kinds.

- [ ] **Step 3: Update providers list**

Print auth kind from `ProviderDefinition.auth`.

- [ ] **Step 4: Update init**

Add OpenAI Codex OAuth as a provider choice. For model selection, require explicit model input unless verified catalog support is available.

- [ ] **Step 5: Update doctor**

Add OAuth status checks via `AuthProfileStore` and `AuthResolver`. Do not call OpenAI `/v1/models` for `openai-codex`.

- [ ] **Step 6: Run focused tests**

Run: `npx vitest run packages/cli/src/doctor.test.ts packages/cli/src/init.test.ts packages/cli/src/init-secrets.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```sh
git add packages/cli/src/providers-cmd.ts packages/cli/src/init.ts packages/cli/src/init-secrets.ts packages/cli/src/doctor.ts packages/cli/src/doctor.test.ts packages/cli/src/init.test.ts packages/cli/src/init-secrets.test.ts
git commit -m "feat(cli): surface provider auth kinds in operator ux"
```

---

## Chunk 5: Auth CLI

### Task 10: Add `murmuration auth` Command Skeleton

**Files:**

- Create: `packages/cli/src/auth-cmd.ts`
- Modify: `packages/cli/src/bin.ts`
- Test: add `packages/cli/src/auth-cmd.test.ts`

- [ ] **Step 1: Write failing command tests**

Cover:

- `auth status` lists no profiles when store absent.
- `auth logout --provider openai-codex` deletes local profile.
- `auth logout --provider openai-codex` reports whether provider token revocation is unsupported.
- `auth login --provider openai-codex` reports protocol gate when implementation is disabled.

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run packages/cli/src/auth-cmd.test.ts`

Expected: FAIL because command does not exist.

- [ ] **Step 3: Implement command skeleton**

Add non-networking status/logout and gated login behavior. Login should fail with a clear message until the OAuth protocol gate is satisfied.

Logout decision for the first version: if no verified revocation endpoint exists, delete local credentials only and print that already-issued access tokens may remain valid until expiry. If a verified revocation endpoint exists later, add revocation before deletion with a mocked test.

- [ ] **Step 4: Wire `bin.ts`**

Add an `auth` case that imports and runs `runAuthCommand()`.

- [ ] **Step 5: Run focused tests**

Run: `npx vitest run packages/cli/src/auth-cmd.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add packages/cli/src/auth-cmd.ts packages/cli/src/auth-cmd.test.ts packages/cli/src/bin.ts
git commit -m "feat(cli): add llm auth command surface"
```

### Task 11: Implement OAuth Login Only After Protocol Gate

**Files:**

- Modify: `packages/cli/src/auth-cmd.ts`
- Add helper file only if it keeps OAuth flow focused, e.g. `packages/cli/src/llm-auth/openai-codex-oauth.ts`
- Test: `packages/cli/src/auth-cmd.test.ts`

- [ ] **Step 1: Make an explicit protocol gate decision**

Before code, document one of these outcomes in the implementation PR:

- **Verified official/supportable route:** list exact authorization endpoint, token endpoint, refresh endpoint, inference base URL, dependency package if any, and policy/source confirming external-tool support.
- **Unverified route:** do not implement OAuth login or inference transport. Keep the gated command, keep `openai-codex` as unavailable/experimental, and document deferral to an extension or later ADR.

If the route is unverified, skip the remaining implementation steps in this task and commit only tests/docs that preserve the gate.

- [ ] **Step 2: Write failing mocked OAuth tests**

Use mocked fetch/OAuth helper. Do not call real OpenAI endpoints in tests.

Tests must include feature flag or experimental warning behavior for undocumented routes, route-change failure diagnostics without retry storms, and no silent fallback to `OPENAI_API_KEY`.

- [ ] **Step 3: Implement login flow**

Implement browser PKCE and/or device-code flow through the selected official or pinned helper. Store credentials through `AuthProfileStore` only.

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run packages/cli/src/auth-cmd.test.ts packages/cli/src/llm-auth/auth-profile-store.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add packages/cli/src/auth-cmd.ts packages/cli/src/llm-auth/openai-codex-oauth.ts packages/cli/src/auth-cmd.test.ts
git commit -m "feat(cli): support openai codex oauth login"
```

---

## Chunk 6: Cost, Security, And Codex Provider

### Task 12: Add Billing Mode To Cost Records

**Files:**

- Modify: `packages/core/src/cost/record.ts`
- Modify: `packages/core/src/cost/builder.ts`
- Modify: `packages/cli/src/boot.ts`
- Test: `packages/core/src/cost/cost.test.ts`

- [ ] **Step 1: Write failing cost tests**

Cover:

- metered providers keep existing USD behavior.
- subscription providers record `billingMode: "subscription"`.
- unknown billing mode does not silently record zero-cost as free.
- unknown billing mode with a USD budget blocks unless an explicit allow-unknown-cost config is set.
- token budgets still apply when token counts exist for subscription/unknown billing.

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run packages/core/src/cost/cost.test.ts`

Expected: FAIL until cost schema supports billing mode.

- [ ] **Step 3: Implement billing mode**

Add `billingMode` to the LLM cost record. Keep backward compatibility for old records when reading, if any read path exists.

Add the minimum config needed for unknown-cost behavior. Prefer a daemon-level setting such as `agent.allowUnknownLlmCost: boolean` only if no existing budget config can carry this. Default must be conservative: block unknown USD-cost providers when a USD budget would otherwise apply.

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run packages/core/src/cost/cost.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add packages/core/src/cost packages/cli/src/boot.ts packages/core/src/cost/cost.test.ts
git commit -m "feat(core): distinguish subscription llm billing mode"
```

### Task 13: Expand Secret Redaction And Leakage Tests

**Files:**

- Modify: `packages/core/src/secrets/index.ts`
- Add or modify tests around run artifact/minutes/log scrubbing where helpers exist
- Test: `packages/core/src/secrets/secrets.test.ts`

- [ ] **Step 1: Write failing redaction tests**

Add tests for:

- `Authorization: Bearer ...`
- JWT-like `xxxxx.yyyyy.zzzzz`
- keys named `access`, `refresh`, `refreshToken`, `accessToken`
- simulated meeting minutes/run artifact payload containing OAuth material is scrubbed or never receives raw token material

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run packages/core/src/secrets/secrets.test.ts`

Expected: FAIL until redaction expands.

- [ ] **Step 3: Implement minimal redaction patterns**

Add patterns carefully to avoid over-redacting ordinary prose.

Trace the major artifact paths that may include provider errors or serialized records. Add targeted tests around the existing scrub helper rather than broad end-to-end filesystem tests if no artifact writer seam exists.

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run packages/core/src/secrets/secrets.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add packages/core/src/secrets/index.ts packages/core/src/secrets/secrets.test.ts
git commit -m "fix(core): redact oauth bearer token shapes"
```

### Task 14: Add Gated `openai-codex` Provider

**Files:**

- Create: `packages/cli/src/builtin-providers/openai-codex.ts`
- Modify: `packages/cli/src/builtin-providers/index.ts`
- Test: create or update built-in provider tests if present
- Test: add `packages/cli/src/builtin-providers/openai-codex.test.ts` if provider behavior is non-trivial

- [ ] **Step 1: Write failing registration tests**

Verify `buildBuiltinProviderRegistry()` includes or conditionally includes `openai-codex` according to the final gate decision.

Add tool-use behavior tests: if Codex transport supports tools, `LLMRequest.tools` is sent and tool results are surfaced; if unsupported, `complete()` returns a clear typed diagnostic before any network request is sent.

- [ ] **Step 2: Implement provider definition**

If protocol support is not verified, register an experimental/gated provider that fails with `ProviderTransportUnsupportedError` and clear remediation. If verified, implement the chosen adapter path.

- [ ] **Step 3: Tool capability decision**

If Codex adapter does not support tools, set `supportsToolUse: false` and fail fast when `LLMRequest.tools` is present.

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run packages/llm/src/providers.test.ts packages/cli/src/auth-cmd.test.ts packages/cli/src/builtin-providers/openai-codex.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add packages/cli/src/builtin-providers/openai-codex.ts packages/cli/src/builtin-providers/openai-codex.test.ts packages/cli/src/builtin-providers/index.ts
git commit -m "feat(cli): add openai codex provider registration"
```

---

## Chunk 7: End-To-End Verification And Docs

### Task 15: Add Documentation

**Files:**

- Modify: `README.md`
- Modify: `docs/GETTING-STARTED.md`
- Modify: `docs/CONFIGURATION.md` if LLM config is documented there

- [ ] **Step 1: Document routes**

Add clear distinction:

- `openai`: API key, API billing, `api.openai.com`.
- `openai-codex`: OAuth/subscription, protocol-gated, not a fallback for `openai`.

- [ ] **Step 2: Document commands**

Add `murmuration auth login/status/logout` examples.

- [ ] **Step 3: Document logout, model, and cost behavior**

Document logout behavior: if no revocation endpoint is supported, logout deletes local credentials but already-issued access tokens may remain valid until expiry. Document that `openai-codex` requires explicit model selection until model catalog/tier defaults are verified. Document subscription/unknown billing behavior and any config required to allow unknown-cost wakes.

- [ ] **Step 4: Run docs formatting**

Run: `pnpm run format:check`

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add README.md docs/GETTING-STARTED.md docs/CONFIGURATION.md
git commit -m "docs: document openai codex oauth route"
```

### Task 16: Full Verification

**Files:** all touched files

- [ ] **Step 1: Run package checks**

Run: `pnpm run typecheck`

Expected: PASS.

- [ ] **Step 2: Run lint**

Run: `pnpm run lint`

Expected: PASS.

- [ ] **Step 3: Run format check**

Run: `pnpm run format:check`

Expected: PASS.

- [ ] **Step 4: Run tests**

Run: `pnpm run test`

Expected: PASS.

- [ ] **Step 5: Run build**

Run: `pnpm run build`

Expected: PASS.

- [ ] **Step 6: Review git diff**

Run: `git diff --stat && git diff --check`

Expected: no whitespace errors; changed files match this plan.

- [ ] **Step 7: Final commit if any verification fixes were needed**

```sh
git add <fixed-files>
git commit -m "test: verify openai codex oauth support"
```

---

## Notes For Implementers

- Do not store `SecretValue` in JSON. Persist DTO strings only inside the auth store boundary.
- Do not let OAuth providers capture stale tokens in cached adapters.
- Do not silently price subscription usage as zero-cost API usage.
- Do not let `openai` consume `openai-codex` OAuth profiles.
- Do not let `openai-codex` consume `OPENAI_API_KEY`.
- Do not implement a native Codex app-server runtime in this plan.
- If Codex OAuth protocol support cannot be verified, stop after the reusable auth architecture and gated provider UX.
