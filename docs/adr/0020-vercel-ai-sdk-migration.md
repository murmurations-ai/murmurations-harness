# ADR-0020 — Replace custom LLM adapters with Vercel AI SDK

- **Status:** Proposed
- **Date:** 2026-04-15
- **Decision-maker(s):** Source (design)
- **Supersedes:** ADR-0014 (custom four-provider LLM client)
- **Related:** Research spikes at xeeban/xeeban-pkm

## Context

The harness has a custom `@murmurations-ai/llm` package with 4 hand-rolled HTTP adapters (Gemini, Anthropic, OpenAI, Ollama), custom retry logic, and a custom error taxonomy. This is ~1,500 lines of plumbing code that:

- Manages provider-specific HTTP APIs, auth headers, response parsing
- Handles retry with exponential backoff and Retry-After headers
- Normalizes finish reasons, token counts, and cache tokens across providers

This is well-solved infrastructure that the ecosystem maintains better than we can. Our differentiator is governance, multi-agent coordination, and GitHub state sync — not LLM API wrappers.

## Decision

### §1 — Adopt Vercel AI SDK as the LLM foundation

Replace the four hand-rolled adapters with:

- `ai` — core SDK (`generateText`, `streamText`, tool calling)
- `@ai-sdk/google` — Gemini provider
- `@ai-sdk/anthropic` — Anthropic provider
- `@ai-sdk/openai` — OpenAI provider + Ollama via OpenAI-compatible endpoint

### §2 — Preserve the public API contract

The `LLMClient` interface, `LLMCostHook`, error taxonomy, and pricing catalog are our domain model. They stay. The Vercel adapter sits behind the same `createLLMClient` factory. Call sites (boot.ts, group-wake.ts, runner/) see no change.

### §3 — Errors-as-values at the boundary

Vercel AI SDK throws errors. The adapter catches and maps them to our `Result<LLMResponse, LLMClientError>` pattern. The error taxonomy (10 classes) is preserved.

### §4 — Cost tracking preserved via usage mapping

Vercel's `result.usage.promptTokens/completionTokens` maps to our `LLMResponse.inputTokens/outputTokens`, which flows through `LLMCostHook` → `WakeCostBuilder` → pricing catalog. The pipeline is unchanged.

### §5 — MCP for tool standardization (Phase 3)

Adopt the MCP TypeScript SDK for exposing agent tools, replacing custom JSON-RPC. Agents declare `mcp_servers` in role.md; tools are loaded from MCP at wake time and passed to Vercel's `generateText({ tools })`.

### §6 — Langfuse for observability (Phase 4)

Replace custom daemon logging for LLM calls with Langfuse traces. Each wake = one trace; each LLM call = one span. The `WakeCostBuilder` remains authoritative for cost.

## Consequences

### Positive

- 4 adapters (~1,200 LOC) replaced by one (~200 LOC)
- Streaming support for free
- Tool calling for free
- `generateObject` for structured output
- 25+ providers available (community packages)
- Community-maintained provider updates
- AgentSkills.io compatibility via MCP

### Negative

- New dependencies (ai, @ai-sdk/\*)
- Loss of Retry-After header support (Vercel issue #7247)
- Rate-limit scope may degrade to "unknown" in some error paths
- Vercel SDK version churn requires monitoring

### Neutral

- Pricing catalog stays ours (Vercel doesn't do cost tracking)
- Error taxonomy stays ours (more granular than Vercel's)
- Model tier resolution stays ours

## Alternatives considered

- **Keep custom adapters** — Rejected: 4 providers is manageable, but adding more (Mistral, Cohere, Groq) would be linear work. Vercel handles this.
- **LangChain.js** — Rejected: heavy abstractions over orchestration, but our orchestration IS our product (S3 governance). Vercel gives unopinionated primitives.
- **Direct vendor SDKs** — Rejected: couples us to each vendor's SDK shape. Vercel provides the unified layer.
