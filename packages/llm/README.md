# @murmurations-ai/llm

Typed LLM client for the Murmuration Harness. Four concurrent provider
adapters behind a single `LLMClient` interface:

| Provider      | Priority | API                      |
| ------------- | -------- | ------------------------ |
| Google Gemini | P0       | Generative AI v1beta     |
| Anthropic     | P1       | Messages API v2023-06-01 |
| OpenAI        | P1       | Chat Completions v1      |
| Ollama        | P1       | Local HTTP `/api/chat`   |

Designed by TypeScript / Runtime Agent #24. See
[`docs/adr/0014-llm-client.md`](../../docs/adr/0014-llm-client.md) for
the full rationale.

## Why four adapters concurrently

The four-adapter mandate exists so the `LLMClient` interface cannot be
Gemini-shaped (or any-other-shaped) by accident. Cross-validation is
the test.

## Key design choices

- **Native `fetch`** in production. No vendor SDKs.
- **`SecretValue` auth** — `reveal()` called exactly once per paid
  adapter (grep-checkable).
- **Per-call cost hook** — daemon-long-lived client cooperates with
  per-wake `WakeCostBuilder`.
- **Errors-as-values** for expected failures; `AbortError` re-throws.
- **Pricing stays out** — the cost hook emits token counts only; the
  daemon resolves price via `@murmurations-ai/llm/pricing` (ADR-0015).
- **Streaming / tools / vision / JSON mode** — all deferred to Phase 3+.

## Usage

```ts
import { makeSecretKey } from "@murmurations-ai/core";
import { DotenvSecretsProvider } from "@murmurations-ai/secrets-dotenv";
import { createLLMClient } from "@murmurations-ai/llm";

const GEMINI_KEY = makeSecretKey("GEMINI_API_KEY");
const provider = new DotenvSecretsProvider({ envPath: ".env" });
await provider.load({ required: [GEMINI_KEY], optional: [] });

const llm = createLLMClient({
  provider: "gemini",
  token: provider.get(GEMINI_KEY),
  tier: "balanced",
});

const result = await llm.complete({
  model: "gemini-2.5-pro",
  messages: [{ role: "user", content: "Hello, world." }],
  maxOutputTokens: 200,
});
if (result.ok) {
  console.log(result.value.content);
}
```

Provider swap is a one-line config change:

```ts
const llm = createLLMClient({
  provider: "ollama", // swap to local, no auth, zero cost
  token: null,
  model: "llama3.2",
});
```
