# ADR-0020 — Adopt Vercel AI SDK as the LLM primitive

- **Status:** Proposed — preliminary recommendation pending the broader ecosystem survey in `docs/LLM-TOOLING-RESEARCH-SPIKE.md`
- **Date:** 2026-04-15
- **Decision-maker(s):** Source, TypeScript / Runtime Agent #24
- **Consulted:** Architecture #23 (package topology), Performance #27 (cost hook + pricing), Security #25 (credential handling), DevOps #26 (provider adapters)
- **Supersedes:** ADR-0014 (partially — see §Consequences). Keeps ADR-0015's architectural intent (pricing decoupled from the LLM client) but sources the catalog from `models.dev` instead of a hand-maintained file.
- **Load-bearing:** ADR-0005 (errors-as-values, still honored via wrapper), ADR-0010 (`SecretValue`, still honored at the secrets-provider boundary), ADR-0011 (`WakeCostBuilder.addLlmTokens`, still honored via a cost-hook adapter)

## Context

ADR-0014 built `@murmurations-ai/llm` as four hand-rolled HTTP adapters (Gemini, Anthropic, OpenAI, Ollama) with a custom `LLMClient` interface, retry module, error taxonomy, and tier table. It was the right choice for Phase 2's scope: _send messages, get a text completion, get token counts_. That scope is now too small.

Three forcing functions have shifted the calculus since ADR-0014 was ratified:

1. **Anthropic pricing changes make multi-provider coverage a hard requirement.** Source-level direction: the harness must run arbitrary agents on whichever provider offers the best cost-quality tradeoff for that role, and that mapping now changes more often than quarterly. The cost of _not_ having a provider switch lands on every wake budget.
2. **Phase 3 needs streaming, tool use, and structured outputs — all of which ADR-0014 explicitly deferred.** `docs/CIRCLE-WAKE-SPEC.md` governance meetings depend on structured action blocks; the TUI dashboard wants real-time streaming; agent tool surfaces (GitHub MCP, custom tools) need normalized tool-call shapes across providers. Building all three by hand across four adapters is now the long pole of Phase 3.
3. **The ecosystem has converged.** `sst/opencode` (144k GitHub stars, MIT, TypeScript) — the most-starred open-source Claude-Code-shaped agent — uses the Vercel AI SDK as its provider layer, bundling 20+ `@ai-sdk/*` providers and dynamically installing unknown ones via `Npm.add()`. Its provider abstraction is ~400 lines of Effect-based glue over `ai` + `@ai-sdk/*` + `models.dev`. OpenClaw (`github.com/openclaw/openclaw`, MIT, _"Your own personal AI assistant. Any OS. Any Platform. The lobster way 🦞"_) is the comparison target for our Phase 2 dual-run and ships multi-provider support with model failover — almost certainly over the same underlying `@ai-sdk/*` packages, though confirmation of its provider layer is deferred to the broader research spike. Nobody hand-rolls provider adapters in 2026. ADR-0014's rejection of vendor SDKs was correct at the time (the individual vendor SDKs were each leaky, each with its own retry/auth/error model) but the Vercel AI SDK _unifies_ all of them behind one interface — which is precisely what ADR-0014 tried to build, three months ahead of the ecosystem's ability to supply it.

ADR-0014's sub-decisions read carefully today:

- **S1 — No vendor SDKs.** Was rejecting `@google/generative-ai` _et al._ individually. Vercel AI SDK is a different shape: _one_ unified SDK with per-provider plugins. It defeats the leak/divergence objection that motivated S1.
- **S2 — Pricing catalog out of this package.** Still correct. Vercel AI SDK doesn't know pricing; it returns `usage` fields. We look up cost at the cost-hook boundary — exactly as ADR-0015 intended. Only the source-of-truth changes: `models.dev` JSON catalog instead of our hand-maintained TypeScript file.
- **S3 — Discriminated union config, single factory.** Vercel AI SDK _is_ a single factory. Our factory becomes a ~5-line wrapper over `generateText` / `streamText`.
- **S4 — `reveal()` once per adapter.** Still holds — each provider adapter package takes an `apiKey: string` arg, we call `reveal()` exactly once when constructing the model object at the boot wiring layer.
- **S5 — Streaming off, tools off, vision off, JSON-mode off in 2A.** This is the sub-decision that most clearly ages out. All four are load-bearing in Phase 3. Vercel AI SDK gives us all four for free.

## Decision

**Replace `@murmurations-ai/llm`'s custom adapters with the Vercel AI SDK (`ai` npm package + `@ai-sdk/*` provider packages).** Keep the `@murmurations-ai/llm` package as a thin wrapper that preserves the `LLMClient` / `LLMCostHook` contracts the rest of the harness already depends on, so the migration is internal to the package and downstream code (`packages/cli/src/boot.ts`, `packages/cli/src/group-wake.ts`) changes by zero or one line.

### Sub-decisions

#### S1 — Use the `ai` package + `@ai-sdk/*` provider packages as the HTTP layer

- `ai` (Vercel) — MIT, unified `generateText` / `streamText` / `generateObject` API
- `@ai-sdk/anthropic` — Claude 4.5/4.6 family, prompt caching, extended thinking, reasoning effort via `providerOptions.anthropic`
- `@ai-sdk/google` — Gemini 2.5 family
- `@ai-sdk/openai` — GPT-5 family
- `@ai-sdk/openai-compatible` — wraps Ollama's `localhost:11434/v1` endpoint, LM Studio, vLLM, any OpenAI-compatible local server

Additional providers (Groq, Mistral, xAI, Perplexity, Bedrock, Vertex, Cohere, etc.) become one-line additions at import time. We do not bundle them preemptively — we add them when an agent's `role.md` asks for them.

#### S2 — `models.dev` replaces `packages/llm/src/pricing/`

`models.dev` (MIT, maintained by the sst/opencode team) publishes a JSON catalog of every commercial LLM's pricing, context window, tool-call support, modality support, and capability flags at `https://models.dev/api.json`. It is the community source of truth the rest of the ecosystem is already using.

We vendor a snapshot at `packages/llm/src/pricing/models-dev.json` (~100KB) and refresh on a Phase-boundary basis via a `pnpm run refresh-models` script. This gives us:

- Reproducible builds (checked-in snapshot, not a runtime fetch)
- Update cadence controlled by us, not by upstream
- No runtime dependency on a third-party URL
- Fall-through to `costMicros = 0` for unknown models (same behavior as ADR-0015's resolveLLMCost)

#### S3 — `LLMClient` / `LLMCostHook` contracts survive the swap

The `@murmurations-ai/llm` package's _public_ API stays identical. Internally:

- `createLLMClient(config)` routes to a new `VercelAdapter` that wraps `generateText`/`streamText` calls.
- `LLMCostHook` still receives `{provider, model, inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?}` on each call; the adapter synthesizes that tuple from Vercel AI SDK's `usage` field on the response.
- `LLMResponse` / `LLMMessage` / `LLMRequest` types stay byte-identical; a thin converter translates from Vercel AI SDK's `CoreMessage[]` / `generateText` response to our existing shapes.

This means `packages/cli/src/boot.ts` and `packages/cli/src/group-wake.ts` do not change during the migration. We can ship S1+S2 behind the existing public API, dual-run against the Phase 2 Research Agent baseline, and validate parity without touching any caller. Only _after_ the swap is proven do we start using Vercel AI SDK features (streaming, `generateObject`, tool normalization) directly, at which point we introduce new exports from `@murmurations-ai/llm` (e.g., `streamLLMCompletion`, `generateStructuredOutput`).

#### S4 — Native fetch stays; no Node-only dependencies

Vercel AI SDK runs in Node, Deno, Bun, Edge runtimes, and browsers. It uses native `fetch` under the hood — same posture as ADR-0014. No Node-polyfill surface, no Axios, no node-fetch. This matters for the TUI dashboard and any future Edge deployment.

#### S5 — Streaming, tools, structured outputs unblocked (but not required for the migration)

After the wrapper-level swap is validated, the new capabilities land as _additive_ exports. They do not gate the migration — the migration ships when we reach parity with the existing Research Agent text-only output. Phase 3 features that want streaming/tools/structured outputs consume the new exports; Phase 2 code keeps using `LLMClient` unchanged until it needs something new.

## Consequences

### Positive

- **~2000 lines of custom TypeScript deleted** from `packages/llm/src/adapters/*` + `retry.ts` + `errors.ts` (custom taxonomy) + `pricing/catalog.ts`. Replaced by ~5 npm dependencies and ~200 lines of glue.
- **17+ providers available immediately** — Anthropic, OpenAI, Google, Google Vertex, Amazon Bedrock, Azure, Groq, Mistral, Cohere, Perplexity, xAI, TogetherAI, DeepInfra, Cerebras, Alibaba, Fireworks, Replicate, plus any OpenAI-compatible local server via `@ai-sdk/openai-compatible`.
- **Streaming, structured outputs, tool-call normalization, prompt caching, extended thinking, reasoning effort** — all available through the same call surface, all unified across providers. Future features land as additive exports, not new adapters.
- **Pricing catalog maintained by the ecosystem.** When Anthropic drops prices, we run `pnpm run refresh-models` and ship the new JSON. We stop hand-editing a TypeScript file.
- **Multi-agent provider diversity becomes trivial.** `role.md` frontmatter specifies `provider: groq` and `model: llama-3.3-70b-versatile`; the daemon resolves it through the factory and the SDK handles the rest. Zero code changes per new provider.
- **Alignment with the ecosystem.** Future hires, contributors, and downstream operators already know the Vercel AI SDK. Our custom interface is one less thing for them to learn.

### Negative

- **New dependency surface.** `ai` + 4-5 `@ai-sdk/*` packages + `zod` (for structured outputs) = ~6 new direct deps. Each brings transitive deps. Audit burden on every major version.
- **We inherit Vercel AI SDK's upgrade cadence.** Breaking changes in the SDK become breaking changes in our LLM package. Mitigation: pin exact versions in `package.json`, upgrade on a Phase-boundary cadence, not continuously.
- **Credentials pass through the SDK.** `@ai-sdk/anthropic`'s factory takes `apiKey: string`, which means `SecretValue.reveal()` is called once per boot (once per `createLLMClient` call). Same discipline as ADR-0014; same grep target (`rg "reveal\(" packages/llm/src`).
- **ADR-0014's adapter tests (`llm.test.ts`, 555 lines) become mostly obsolete.** The tests against vendor HTTP contracts were the main value of hand-rolled adapters. We trade those for Vercel AI SDK's own test coverage (which is more extensive than ours, but lives in a different repo). Our tests refocus on the wrapper layer (cost-hook translation, model/provider resolution, streaming surface).
- **Ollama gets a small downgrade.** Our current Ollama adapter hits `/api/chat` directly; Vercel AI SDK's `@ai-sdk/openai-compatible` hits `/v1/chat/completions`. Both work, but the former is Ollama-native and the latter is Ollama's compat shim. If the compat shim has any functional gap (embeddings? streaming?) we discover it in the spike.

### Reversibility

**Moderate reversibility during the spike; low reversibility after the full migration.** The spike keeps `@murmurations-ai/llm`'s public API stable, so a rollback during the spike is a single-commit revert of the `packages/llm/src` internals. After the migration ships and new exports (streaming, structured outputs, tool normalization) start being used by callers, unwinding would require re-implementing those exports against the old adapter code — not feasible. Decision point: do not consume new Vercel AI SDK features from caller code until the wrapper-level swap has been dual-run-validated.

## Alternatives considered

### A. Keep custom adapters, extend as needed

Continue maintaining the four hand-rolled adapters and add streaming, tools, structured outputs ourselves. **Rejected:** the scope Phase 3 implies (streaming across 4 providers, tool-call normalization across 4 providers, structured outputs across 4 providers) is roughly ~2000 additional lines of TypeScript. That's our entire current LLM package again, for features the Vercel AI SDK gives us for free.

### B. Anthropic Managed Agents

Discussed at length in the previous session. **Rejected at the Source level** because it's Claude-only and Source requires multi-provider coverage for the Anthropic pricing concern.

### C. LangChain / LangGraph

**Rejected.** LangChain carries a much larger conceptual surface (chains, retrievers, memory, agents) that overlaps with — and would conflict with — our daemon, scheduler, signal aggregator, and governance plugin. It would require us to reframe the harness as a LangChain consumer. The Vercel AI SDK is deliberately scoped to _the call_ — inference, tool use, streaming. It sits under the harness's coordination layer; LangChain tries to replace the coordination layer.

### D. LlamaIndex

**Rejected** for the same reason as LangChain. LlamaIndex is an agent framework; we want a provider abstraction.

### E. LiteLLM (Python)

**Rejected** because the harness is TypeScript. LiteLLM is the closest analog in the Python ecosystem; Vercel AI SDK is the TypeScript answer. We pick the one that matches our language.

### F. Vendor `sst/opencode`'s provider layer directly

Considered and rejected. OpenCode's `packages/opencode/src/provider/{provider,auth,models}.ts` is deeply wired into OpenCode's Effect-based runtime, config system, and auth service. You cannot cleanly extract just the provider layer without vendoring OpenCode's world. **But we adopt what OpenCode adopts** — `ai` + `@ai-sdk/*` + `models.dev` — which is the valuable part.

## Open questions

1. **Ollama compat shim parity.** Does `@ai-sdk/openai-compatible` pointed at `localhost:11434/v1` behave identically to our current `/api/chat` adapter for (a) non-streaming completion, (b) streaming, (c) token counting? **Answered during the spike against the `ollama` provider fixture in the current `llm.test.ts`.**
2. **Gemini structured output differences.** Vercel AI SDK's `generateObject` uses OpenAI-style tool-call-based structured outputs. Gemini has its own native JSON schema support. Which path does `@ai-sdk/google` take, and does it match our needs? **Not blocking — we can use `generateText` with prompt-embedded schemas as a fallback.**
3. **Cache-control on prompt caching.** Our current adapter doesn't use Anthropic's `cache_control` at all. Vercel AI SDK routes it through `providerOptions.anthropic.cacheControl`. **Out of scope for the migration — add in a follow-up once caching is needed.**
4. **`providerOptions` lock-in.** Any provider-specific feature (Claude's cache control, Gemini's `responseSchema`, OpenAI's `structured_outputs`) lives in a `providerOptions.<provider>` field, which means agent code that uses it is no longer provider-agnostic. **Acceptable by design — the point of Vercel AI SDK is that the 80% case is unified and the remaining 20% uses typed escape hatches.**

## Related

- [ADR-0014 LLM client](./0014-llm-client.md) — partially superseded; keep for historical context
- [ADR-0015 pricing catalog](./0015-pricing-catalog.md) — still architecturally valid; only the source-of-truth swaps
- [ADR-0016 role template](./0016-role-template.md) — `role.md` frontmatter still specifies `provider` + `model`; semantics unchanged
- `docs/LLM-MIGRATION-SPEC.md` — the detailed migration plan and spike definition
