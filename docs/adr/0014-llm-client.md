# ADR-0014 — `@murmuration/llm` four-provider LLM client

- **Status:** Accepted
- **Date:** 2026-04-09
- **Decision-maker(s):** TypeScript / Runtime Agent #24 (author), Engineering Circle (ratifier)
- **Consulted:** Architecture #23 (package topology), DevOps #26 (adapter implementations), Security #25 (`SecretValue` auth, redaction), Performance #27 (cost hook seam, ADR-0015 boundary)
- **Closes:** Phase 2 prerequisite **P1** in `docs/PHASE-2-PLAN.md`
- **Load-bearing:** ADR-0005 (errors-as-values), ADR-0006 (branded primitives), ADR-0010 (`SecretValue`), ADR-0011 (`WakeCostBuilder.addLlmTokens`), ADR-0012 (mirror reference: `@murmuration/github`)

## Context

Phase 2 ports the Research Agent #1 onto the harness daemon. That requires an LLM client. Per Source direction (PHASE-2-PLAN.md "Multi-provider LLM mandate"), the package ships **four adapters concurrently** in 2A — Gemini (P0), Anthropic, OpenAI, Ollama (all P1). The four-adapter constraint exists precisely so the `LLMClient` interface cannot be Gemini-shaped (or any-other-shaped) by accident; cross-validation is the test.

The package must integrate cleanly with three already-ratified contracts:

1. **`SecretValue`** auth (ADR-0010) — `reveal()` called in exactly one grep-checkable place per adapter, never on the error path.
2. **`WakeCostBuilder.addLlmTokens`** (ADR-0011) — every completion contributes a cost record.
3. **Errors-as-values** (ADR-0005) — `Result<T, E>` for expected failures; throws only for `AbortError`.

The github client (ADR-0012) is the architectural twin: same factory shape, same daemon-long-lived / per-wake cost-hook split, same error taxonomy pattern, same `SecretValue` discipline. This ADR mirrors that design as closely as the four-provider constraint allows.

## Decision

**Adopt a single `LLMClient` interface in `@murmuration/llm` with four internal adapters behind a discriminated-union config.** Hand-rolled against native `fetch`. No provider SDKs. The client is daemon-long-lived; cost is reported via a per-call hook bound to a per-wake `WakeCostBuilder`. The pricing catalog (ADR-0015) lives outside this package; adapters emit token counts only.

### Sub-decisions

#### S1 — No vendor SDKs

`@google/generative-ai`, `@anthropic-ai/sdk`, `openai`, and `ollama` are all rejected for the same reason ADR-0012 rejected Octokit: each SDK leaks hundreds of generated types into our public API surface, each introduces an independent dependency upgrade cadence, and each implements its own auth, retry, and error handling that conflicts with our `SecretValue` / `Result` / `WakeCostBuilder` contracts. Hand-rolled adapters against documented HTTP APIs are strictly less surface area.

Each adapter pins its provider's API version explicitly in the request URL or header (Gemini `v1beta`, Anthropic `2023-06-01`, OpenAI `v1`, Ollama `/api/chat`). API-version drift becomes a PR, not a transitive dependency upgrade.

#### S2 — Pricing catalog stays out of this package

The `LLMClient` does **not** import the pricing catalog. Adapters emit token counts plus `provider` and `model`; the daemon (or whichever caller wires the `LLMCostHook`) resolves price via the ADR-0015 catalog before calling `WakeCostBuilder.addLlmTokens`.

Rationale: ADR-0015 (P2, Performance #27) is on a parallel track. If the LLM client owned pricing, the two ADRs would couple. Keeping the price lookup at the boot-wiring layer means:

- The LLM package has zero pricing knowledge — it cannot drift from the catalog because it has no opinion.
- The daemon adapter from `LLMCostHook` to `addLlmTokens` is a small closure that calls `pricingCatalog.priceFor(provider, model, usage)` and forwards the result.
- Ollama emits `provider: "ollama"`, the catalog returns `costMicros = 0`, and the same code path handles paid providers.
- Tests for the LLM package never need a pricing fixture.

This is the matching decision to ADR-0012's per-call cost hook: the package emits semantic events; the daemon translates them to builder calls.

#### S3 — Discriminated union config, single factory

`createLLMClient(config: LLMClientConfig): LLMClient` dispatches on `config.provider` to instantiate exactly one internal `LLMAdapter`. Provider swap at boot is a one-line config change. The four adapters share zero state — each is constructed fresh — but they share the retry module, the error taxonomy, and the request/response normalization helpers.

#### S4 — `reveal()` once per adapter, plus the scrub helper

Same invariant as ADR-0012: each adapter has exactly one `reveal()` call inside its `#buildHeaders` (Gemini, Anthropic, OpenAI). Ollama has zero. A shared `scrubCause(cause, token)` helper in `errors.ts` may call `reveal()` defensively on the error path, identical to the pattern in `@murmuration/github`. Grep target: `rg "reveal\(\)" packages/llm/src` should show ≤ 4 hits in adapter source + 1 in `errors.ts`.

#### S5 — Streaming off, tools off, vision off, JSON-mode off in 2A

Phase 2 needs one capability: send messages, get a text completion, get token counts. Streaming, tool use, vision, JSON mode, prompt caching, and batch APIs are explicitly out of scope. The interface is shaped so each can be added additively in Phase 3+ without breaking the 2A surface.

## Package layout

```
packages/llm/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts            # public re-exports only
│   ├── client.ts           # createLLMClient + LLMClient impl that delegates
│   ├── types.ts            # LLMRequest / LLMResponse / LLMMessage / branded
│   ├── errors.ts           # LLMClientError hierarchy + scrubCause
│   ├── tiers.ts            # ModelTier → concrete model per provider
│   ├── cost-hook.ts        # LLMCostHook interface
│   ├── retry.ts            # shared RetryPolicy + computeDelay
│   ├── adapters/
│   │   ├── adapter.ts      # package-private LLMAdapter interface
│   │   ├── gemini.ts
│   │   ├── anthropic.ts
│   │   ├── openai.ts
│   │   └── ollama.ts
│   └── llm.test.ts
```

`package.json` dependencies: `@murmuration/core` (workspace), `zod` (already in the graph). No new top-level deps. Native `fetch` for transport, identical to the github package.

## Public API

### `LLMClient` interface

```ts
// types.ts
export type ProviderId = "gemini" | "anthropic" | "openai" | "ollama";

// re-exported from @murmuration/core/execution
export type ModelTier = "fast" | "balanced" | "deep";

export type StopReason =
  | "stop"
  | "length"
  | "content_policy"
  | "tool_use" // reserved; never returned in Phase 2
  | "unknown";

export interface LLMMessage {
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
}

export interface LLMRequest {
  readonly model: string; // concrete model id, resolved via tiers.ts or pinned
  readonly messages: readonly LLMMessage[];
  readonly maxOutputTokens: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly stopSequences?: readonly string[];
  readonly systemPromptOverride?: string;
}

export interface LLMResponse {
  readonly content: string;
  readonly stopReason: StopReason;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number; // Anthropic prompt-cache support reserved
  readonly cacheWriteTokens?: number;
  readonly modelUsed: string;
  readonly providerUsed: ProviderId;
}

export interface LLMClientCapabilities {
  readonly provider: ProviderId;
  readonly supportedTiers: readonly ModelTier[];
  readonly supportsStreaming: false;
  readonly supportsToolUse: false;
  readonly supportsVision: false;
  readonly supportsJsonMode: false;
  readonly maxContextTokens: number;
}

// client.ts
export interface CallOptions {
  readonly signal?: AbortSignal;
  readonly costHook?: LLMCostHook;
  readonly idempotencyKey?: string; // OpenAI honours; others ignore
}

export interface LLMClient {
  complete(
    request: LLMRequest,
    options?: CallOptions,
  ): Promise<Result<LLMResponse, LLMClientError>>;

  capabilities(): LLMClientCapabilities;
}

export const createLLMClient: (config: LLMClientConfig) => LLMClient;
```

### `LLMClientConfig` — discriminated union

```ts
interface BaseClientConfig {
  readonly model?: string; // pin a concrete model; otherwise resolve from tier
  readonly tier?: ModelTier; // default "balanced"
  readonly baseUrl?: string;
  readonly userAgent?: string;
  readonly fetch?: typeof fetch;
  readonly retryPolicy?: RetryPolicy;
  readonly defaultCostHook?: LLMCostHook;
  readonly requestTimeoutMs?: number; // default 60_000
  readonly now?: () => Date;
}

export type LLMClientConfig =
  | (BaseClientConfig & { readonly provider: "gemini"; readonly token: SecretValue })
  | (BaseClientConfig & { readonly provider: "anthropic"; readonly token: SecretValue })
  | (BaseClientConfig & { readonly provider: "openai"; readonly token: SecretValue })
  | (BaseClientConfig & { readonly provider: "ollama"; readonly token: null });
```

The discriminated union forces callers to write `provider` and either supply a `SecretValue` or pass `null` (Ollama). `exactOptionalPropertyTypes` plus `verbatimModuleSyntax` give the compiler all it needs to refuse mismatched configs.

### `LLMAdapter` (package-private)

Adapters do not implement `LLMClient` directly. They implement a thinner internal interface; `LLMClientImpl` in `client.ts` wraps a single adapter and adds the per-call hook resolution and capabilities indirection.

```ts
// adapters/adapter.ts
export interface LLMAdapter {
  readonly providerId: ProviderId;
  readonly modelUsed: string; // resolved at construction
  readonly capabilities: LLMClientCapabilities;
  complete(
    request: LLMRequest,
    options: ResolvedCallOptions,
  ): Promise<Result<LLMResponse, LLMClientError>>;
}
```

Each adapter is constructed by a private factory in its own file; `client.ts` selects which factory to call from `config.provider`.

## Model tier resolution

`tiers.ts` exports a static table:

```ts
export const MODEL_TIER_TABLE: Record<ProviderId, Record<ModelTier, string>> = {
  gemini: {
    fast: "gemini-2.5-flash",
    balanced: "gemini-2.5-pro",
    deep: "gemini-2.5-pro", // Pro is the top Google tier
  },
  anthropic: {
    fast: "claude-sonnet-4-5-20250929",
    balanced: "claude-sonnet-4-5-20250929",
    deep: "claude-opus-4-6-20251030", // verify model id at impl time
  },
  openai: {
    fast: "gpt-4o-mini",
    balanced: "gpt-4o",
    deep: "gpt-4-turbo", // verify against current API at impl time
  },
  ollama: {
    fast: "llama3.2:3b",
    balanced: "llama3.2", // configurable via config.model
    deep: "llama3.1:70b",
  },
};
```

**Implementation note for DevOps #26:** Anthropic/OpenAI model ids above are placeholder pins that must be confirmed against the live APIs before 2A4/2A5 ship.

If `config.model` is set, it wins over the tier resolution. If neither is set, default tier is `"balanced"`.

## Error taxonomy

Mirrors `GithubClientError` in shape. All errors are constructed with `requestUrl` and `cause`. None of them ever embed the raw token; the `scrubCause` helper in `errors.ts` defensively redacts on construction.

```ts
// errors.ts
export type LLMClientErrorCode =
  | "unauthorized"
  | "forbidden"
  | "rate-limited"
  | "validation"
  | "content-policy"
  | "context-length"
  | "transport"
  | "provider-outage"
  | "parse"
  | "internal";
```

Each code gets a concrete subclass (`LLMUnauthorizedError`, `LLMRateLimitError` with `retryAfterSeconds` + `limitScope`, `LLMContentPolicyError`, `LLMContextLengthError`, `LLMTransportError` with `attempts`, `LLMProviderOutageError` with `attempts`, etc.).

**Why `LLMContentPolicyError` and `LLMContextLengthError` get their own codes:** both are _the_ two failure modes a Research Agent prompt is most likely to hit. Both are recoverable with caller intervention (rephrase, truncate); both must be distinguishable from a generic 422.

**Why `LLMProviderOutageError` is split from `LLMTransportError`:** Phase 2's dual-run week needs to distinguish "the provider is down" from "the network blipped". Risk §R1 in PHASE-2-PLAN.md lifts this from informational to load-bearing — the gate review must count outage minutes separately from harness faults.

## Cost hook contract

```ts
// cost-hook.ts
export interface LLMCostHook {
  onLlmCall(call: {
    readonly provider: ProviderId;
    readonly model: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
  }): void;
}
```

**No `costMicros` field on the hook.** This is the deliberate seam (S2): the LLM package emits token counts; the daemon resolves the price via the ADR-0015 catalog at the call site:

```ts
// daemon boot — adapter from LLMCostHook to WakeCostBuilder
const makeDaemonHook = (builder: WakeCostBuilder, catalog: PricingCatalog): LLMCostHook => ({
  onLlmCall: (call) => {
    const costMicros = catalog.priceFor(call.provider, call.model, {
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      cacheReadTokens: call.cacheReadTokens ?? 0,
      cacheWriteTokens: call.cacheWriteTokens ?? 0,
    });
    builder.addLlmTokens({
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      ...(call.cacheReadTokens !== undefined ? { cacheReadTokens: call.cacheReadTokens } : {}),
      ...(call.cacheWriteTokens !== undefined ? { cacheWriteTokens: call.cacheWriteTokens } : {}),
      modelProvider: call.provider,
      modelName: call.model,
      costMicros,
    });
  },
});
```

The hook fires exactly once per _successful_ `complete()` call. Retries inside the adapter do not fire the hook multiple times. Failed calls do not fire the hook. Ollama calls fire the hook; the catalog returns zero.

## Retry / rate-limit policy, per provider

A shared `RetryPolicy` type with per-provider defaults:

```ts
export const DEFAULT_RETRY_POLICY: Record<ProviderId, RetryPolicy> = {
  gemini: {
    maxAttempts: 3,
    baseDelayMs: 500,
    maxDelayMs: 8_000,
    retryableStatuses: [429, 500, 503],
    honourRetryAfter: true,
  },
  anthropic: {
    maxAttempts: 3,
    baseDelayMs: 500,
    maxDelayMs: 8_000,
    retryableStatuses: [429, 500, 529],
    honourRetryAfter: true,
  },
  openai: {
    maxAttempts: 3,
    baseDelayMs: 500,
    maxDelayMs: 8_000,
    retryableStatuses: [429, 500, 503],
    honourRetryAfter: true,
  },
  ollama: {
    maxAttempts: 1,
    baseDelayMs: 0,
    maxDelayMs: 0,
    retryableStatuses: [],
    honourRetryAfter: false,
  },
};
```

Per-provider retry-after parsing lives in each adapter:

- **Gemini**: HTTP `retry-after` (seconds). Fall back to exponential.
- **Anthropic**: `anthropic-ratelimit-requests-reset` / `anthropic-ratelimit-tokens-reset` headers (Unix epoch seconds).
- **OpenAI**: `x-ratelimit-reset-requests` / `x-ratelimit-reset-tokens` durations; plain `retry-after` also honoured.
- **Ollama**: no rate limits; any 5xx is "model crashed or daemon down" — fail fast with `LLMProviderOutageError`.

`AbortSignal` cancels mid-retry; the abort path re-throws (matching the github client).

## Request / response serialization

| Field                    | Gemini                                                 | Anthropic                                              | OpenAI                               | Ollama                              |
| ------------------------ | ------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------ | ----------------------------------- |
| **endpoint**             | `POST {baseUrl}/v1beta/models/{model}:generateContent` | `POST {baseUrl}/v1/messages`                           | `POST {baseUrl}/v1/chat/completions` | `POST {baseUrl}/api/chat`           |
| **auth header**          | `x-goog-api-key: <token>`                              | `x-api-key: <token>` + `anthropic-version: 2023-06-01` | `Authorization: Bearer <token>`      | (none)                              |
| **system prompt**        | `systemInstruction.parts[].text`                       | top-level `system` field                               | first message with `role: "system"`  | first message with `role: "system"` |
| **messages**             | `contents[].role ∈ {"user","model"}.parts[].text`      | `messages[].content` (string)                          | `messages[].content`                 | `messages[].content`                |
| **max tokens**           | `generationConfig.maxOutputTokens`                     | `max_tokens` (required)                                | `max_tokens`                         | `options.num_predict`               |
| **input tokens** (resp)  | `usageMetadata.promptTokenCount`                       | `usage.input_tokens`                                   | `usage.prompt_tokens`                | `prompt_eval_count`                 |
| **output tokens** (resp) | `usageMetadata.candidatesTokenCount`                   | `usage.output_tokens`                                  | `usage.completion_tokens`            | `eval_count`                        |
| **content** (resp)       | `candidates[0].content.parts[0].text`                  | `content[0].text`                                      | `choices[0].message.content`         | `message.content`                   |
| **stop reason** (resp)   | `candidates[0].finishReason`                           | `stop_reason`                                          | `choices[0].finish_reason`           | `done_reason`                       |

Stop-reason normalization is done in each adapter via a small private function mapping to the `StopReason` union. `content_policy` is the canonical mapping for any provider-specific safety/refusal signal — this triggers `LLMContentPolicyError` if the response also has empty content.

Untrusted response bodies are parsed through Zod schemas per adapter. A failed Zod parse becomes `LLMParseError`.

## Auth injection (`SecretValue`)

Each paid adapter has exactly one `reveal()` call inside its `#buildHeaders` method:

```ts
// gemini.ts
#buildHeaders(): Headers {
  return new Headers({
    "Content-Type": "application/json",
    "User-Agent": this.#userAgent,
    // The ONLY place reveal() is called in this file.
    "x-goog-api-key": this.#token.reveal(),
  });
}
```

Anthropic uses `x-api-key`; OpenAI uses `Authorization: Bearer`. Ollama has no auth.

Gemini's API also accepts `?key=<token>` as a query parameter. **Header form is chosen** because (1) URLs end up in logs more often than headers, (2) the github client's grep-checkable header pattern is the model.

Grep audit: `rg "\.reveal\(\)" packages/llm/src` should return ≤ 5 hits (3 adapter headers + 1 in `errors.ts` `scrubCause` + possibly 1 in tests).

## Tests

~20 Vitest specs in `packages/llm/src/llm.test.ts`, all via injected `fetch`:

1-4. Happy path per adapter (Gemini, Anthropic, OpenAI, Ollama)
5-8. Token extraction per adapter 9. 401 on Gemini → `LLMUnauthorizedError` 10. 429 on Anthropic with `anthropic-ratelimit-tokens-reset` → `LLMRateLimitError` 11. 422 on OpenAI → `LLMValidationError` 12. 500 on Gemini retried twice then success → hook fires once 13. 503 on Ollama → `LLMProviderOutageError` immediately (no retry) 14. Cost hook fires with correct shape (no `costMicros` field — seam preserved) 15. `SecretValue` redaction in errors — raw token never in serialized error 16. Abort signal cancellation 17. Model tier resolution — all 12 (provider × tier) combinations 18. Content policy refusal (Gemini safety finishReason → `LLMContentPolicyError`) 19. Context length exceeded (Anthropic → `LLMContextLengthError`) 20. TypeScript-level discriminated-union narrowing (`expectTypeOf`)

2A11 gate test (live Gemini + live Ollama smoke) lives behind `LIVE=1` in a separate file.

## Out of scope for Phase 2A

- Streaming responses
- Tool use / function calling
- Vision / multimodal inputs
- JSON mode / structured output
- Anthropic prompt caching (fields reserved on `LLMResponse` but not requested)
- HTTP response cache (LLM responses are non-deterministic; wrong abstraction)
- Batch APIs
- Fine-tuning APIs
- Cross-instance rate-limit coordination
- Pre-flight token counting

## Risks and carry-forwards

- **CF-llm-A** — Per-attempt cost hook granularity (mirrors CF-github-A). Phase 3 `onLlmAttempt` hook. Owner: Performance #27.
- **CF-llm-B** — Pricing catalog coupling drift — the S2 seam must match ADR-0015's shape. Owner: TypeScript #24 + Performance #27 jointly.
- **CF-llm-C** — Provider API version drift. Owner: DevOps #26.
- **CF-llm-D** — Model tier table staleness. Owner: TypeScript #24.
- **CF-llm-E** — Ollama context length defaults (2K-4K default; Research prompts may overflow). Owner: DevOps #26 during 2A6.
- **CF-llm-F** — `LLMRateLimitError.limitScope` provider parity (normalization is approximate). Owner: Performance #27.
- **CF-llm-G** — Content-policy false positives during dual-run (Gemini safety filter may reject prompts OpenClaw provider doesn't). Mitigation: 2E5 qualitative judgment.
- **CF-llm-H** — Carry-forward into ADR-0016 (role template): frontmatter must use `ProviderId` and `ModelTier` types from this ADR.

## Alternatives considered

- **One adapter first, others Phase 3.** Rejected by Source direction.
- **Vendor SDKs.** Rejected per S1.
- **Pricing inside the LLM package.** Rejected per S2.
- **Separate workspace package per provider.** Rejected — more friction, no benefit.
- **Streaming on day one.** Rejected — out of scope for Phase 2A.

## Consequences

### Positive

- Provider swap is a one-line config change (Risk §R1 mitigation).
- Public API is small: ~12 exports.
- `reveal()` audit grep-checkable across all four adapters.
- Pricing stays decoupled — ADR-0014 and ADR-0015 ratify in parallel.
- Errors-as-values keeps Research Agent call sites free of `try/catch`.

### Negative

- Hand-rolling four adapters duplicates per-provider auth/retry/parsing logic.
- Static model tier table requires a code PR on new model releases.
- Cost hook fires once per successful call; retry storms visible only via outcome log.
- Two LLM-specific error classes diverge from the github error taxonomy on purpose.

---

_This ADR closes Phase 2 prerequisite P1. Source + Claude Code implements `packages/llm/` from this design verbatim during Phase 2A._
