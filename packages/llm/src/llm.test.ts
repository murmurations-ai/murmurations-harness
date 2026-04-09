import { makeSecretValue } from "@murmuration/core";
import { describe, expect, it } from "vitest";

import {
  createLLMClient,
  LLMContentPolicyError,
  LLMParseError,
  LLMProviderOutageError,
  LLMRateLimitError,
  LLMTransportError,
  LLMUnauthorizedError,
  LLMValidationError,
  MODEL_TIER_TABLE,
  resolveModelForTier,
  type LLMCostHook,
} from "./index.js";

// ---------------------------------------------------------------------------
// Fake fetch helper — each test wires its own sequence.
// ---------------------------------------------------------------------------

interface FakeResponse {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
  readonly textBody?: string;
}

const makeFakeFetch = (
  responses: readonly FakeResponse[],
): {
  fetch: typeof fetch;
  calls: { url: string; headers: Headers; body: string | null }[];
} => {
  const calls: { url: string; headers: Headers; body: string | null }[] = [];
  let idx = 0;
  // eslint-disable-next-line @typescript-eslint/require-await -- test double mimics the fetch signature
  const fake: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    const bodyStr = typeof init?.body === "string" ? init.body : null;
    calls.push({ url, headers, body: bodyStr });
    const next = responses[idx++];
    if (!next) throw new Error("fake fetch: no more responses queued");
    const h = new Headers(next.headers);
    const responseBody =
      next.textBody ?? (next.body !== undefined ? JSON.stringify(next.body) : null);
    return new Response(responseBody, { status: next.status, headers: h });
  };
  return { fetch: fake, calls };
};

const TOKEN = makeSecretValue("test-api-key-abcdefghijklmnop");

const captureHook = (): {
  hook: LLMCostHook;
  calls: Parameters<LLMCostHook["onLlmCall"]>[0][];
} => {
  const calls: Parameters<LLMCostHook["onLlmCall"]>[0][] = [];
  return {
    hook: { onLlmCall: (call) => calls.push(call) },
    calls,
  };
};

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

describe("GeminiAdapter", () => {
  it("happy path — parses candidates, usage, emits cost hook", async () => {
    const { fetch: f, calls } = makeFakeFetch([
      {
        status: 200,
        body: {
          candidates: [
            {
              content: { parts: [{ text: "hello from gemini" }] },
              finishReason: "STOP",
            },
          ],
          modelVersion: "gemini-2.5-pro",
          usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5 },
        },
      },
    ]);
    const { hook, calls: costCalls } = captureHook();
    const client = createLLMClient({ provider: "gemini", token: TOKEN, fetch: f });
    const result = await client.complete(
      {
        model: "gemini-2.5-pro",
        messages: [{ role: "user", content: "say hi" }],
        maxOutputTokens: 100,
      },
      { costHook: hook },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toBe("hello from gemini");
      expect(result.value.stopReason).toBe("stop");
      expect(result.value.inputTokens).toBe(12);
      expect(result.value.outputTokens).toBe(5);
      expect(result.value.providerUsed).toBe("gemini");
    }
    expect(calls[0]?.headers.get("x-goog-api-key")).toBe("test-api-key-abcdefghijklmnop");
    expect(costCalls).toEqual([
      { provider: "gemini", model: "gemini-2.5-pro", inputTokens: 12, outputTokens: 5 },
    ]);
  });

  it("401 → LLMUnauthorizedError", async () => {
    const { fetch: f } = makeFakeFetch([{ status: 401 }]);
    const client = createLLMClient({ provider: "gemini", token: TOKEN, fetch: f });
    const result = await client.complete({
      model: "gemini-2.5-pro",
      messages: [{ role: "user", content: "hi" }],
      maxOutputTokens: 10,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(LLMUnauthorizedError);
  });

  it("429 → LLMRateLimitError with parsed retry-after", async () => {
    const { fetch: f } = makeFakeFetch([
      { status: 429, headers: { "retry-after": "30" } },
      { status: 429, headers: { "retry-after": "30" } },
      { status: 429, headers: { "retry-after": "30" } },
    ]);
    const client = createLLMClient({
      provider: "gemini",
      token: TOKEN,
      fetch: f,
      retryPolicy: {
        ...{
          maxAttempts: 1,
          baseDelayMs: 0,
          maxDelayMs: 0,
          retryableStatuses: [],
          honourRetryAfter: false,
        },
      },
    });
    const result = await client.complete({
      model: "gemini-2.5-pro",
      messages: [{ role: "user", content: "hi" }],
      maxOutputTokens: 10,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(LLMRateLimitError);
      expect((result.error as LLMRateLimitError).retryAfterSeconds).toBe(30);
    }
  });

  it("SAFETY finishReason + empty content → LLMContentPolicyError", async () => {
    const { fetch: f } = makeFakeFetch([
      {
        status: 200,
        body: {
          candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }],
        },
      },
    ]);
    const client = createLLMClient({ provider: "gemini", token: TOKEN, fetch: f });
    const result = await client.complete({
      model: "gemini-2.5-pro",
      messages: [{ role: "user", content: "prohibited" }],
      maxOutputTokens: 10,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(LLMContentPolicyError);
  });

  it("500 repeated → LLMProviderOutageError", async () => {
    const { fetch: f } = makeFakeFetch([{ status: 500 }, { status: 500 }, { status: 500 }]);
    const client = createLLMClient({
      provider: "gemini",
      token: TOKEN,
      fetch: f,
      retryPolicy: {
        maxAttempts: 1,
        baseDelayMs: 0,
        maxDelayMs: 0,
        retryableStatuses: [],
        honourRetryAfter: false,
      },
    });
    const result = await client.complete({
      model: "gemini-2.5-pro",
      messages: [{ role: "user", content: "hi" }],
      maxOutputTokens: 10,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(LLMProviderOutageError);
  });

  it("malformed JSON → LLMParseError", async () => {
    const { fetch: f } = makeFakeFetch([{ status: 200, textBody: "<<not json>>" }]);
    const client = createLLMClient({ provider: "gemini", token: TOKEN, fetch: f });
    const result = await client.complete({
      model: "gemini-2.5-pro",
      messages: [{ role: "user", content: "hi" }],
      maxOutputTokens: 10,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(LLMParseError);
  });
});

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

describe("AnthropicAdapter", () => {
  it("happy path — parses content blocks, usage with cache tokens", async () => {
    const { fetch: f, calls } = makeFakeFetch([
      {
        status: 200,
        body: {
          id: "msg_1",
          model: "claude-sonnet-4-5-20250929",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "hello from claude" }],
          usage: {
            input_tokens: 20,
            output_tokens: 8,
            cache_read_input_tokens: 5,
            cache_creation_input_tokens: 2,
          },
        },
      },
    ]);
    const { hook, calls: costCalls } = captureHook();
    const client = createLLMClient({ provider: "anthropic", token: TOKEN, fetch: f });
    const result = await client.complete(
      {
        model: "claude-sonnet-4-5-20250929",
        messages: [{ role: "user", content: "hi" }],
        maxOutputTokens: 100,
      },
      { costHook: hook },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toBe("hello from claude");
      expect(result.value.stopReason).toBe("stop");
      expect(result.value.inputTokens).toBe(20);
      expect(result.value.outputTokens).toBe(8);
      expect(result.value.cacheReadTokens).toBe(5);
      expect(result.value.cacheWriteTokens).toBe(2);
    }
    expect(calls[0]?.headers.get("x-api-key")).toBe("test-api-key-abcdefghijklmnop");
    expect(calls[0]?.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(costCalls[0]?.cacheReadTokens).toBe(5);
    expect(costCalls[0]?.cacheWriteTokens).toBe(2);
  });

  it("400 with 'context' in body → LLMContextLengthError", async () => {
    const { fetch: f } = makeFakeFetch([
      { status: 400, textBody: "prompt exceeds maximum context window" },
    ]);
    const client = createLLMClient({ provider: "anthropic", token: TOKEN, fetch: f });
    const result = await client.complete({
      model: "claude-sonnet-4-5-20250929",
      messages: [{ role: "user", content: "too long" }],
      maxOutputTokens: 100,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("context-length");
  });
});

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

describe("OpenAIAdapter", () => {
  it("happy path — Bearer auth, choices parsing, cached_tokens", async () => {
    const { fetch: f, calls } = makeFakeFetch([
      {
        status: 200,
        body: {
          id: "chatcmpl_1",
          model: "gpt-4o",
          choices: [
            {
              finish_reason: "stop",
              message: { role: "assistant", content: "hello from openai" },
            },
          ],
          usage: {
            prompt_tokens: 15,
            completion_tokens: 6,
            prompt_tokens_details: { cached_tokens: 3 },
          },
        },
      },
    ]);
    const { hook, calls: costCalls } = captureHook();
    const client = createLLMClient({ provider: "openai", token: TOKEN, fetch: f });
    const result = await client.complete(
      {
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
        maxOutputTokens: 100,
      },
      { costHook: hook, idempotencyKey: "abc-123" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toBe("hello from openai");
      expect(result.value.inputTokens).toBe(15);
      expect(result.value.outputTokens).toBe(6);
      expect(result.value.cacheReadTokens).toBe(3);
    }
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer test-api-key-abcdefghijklmnop");
    expect(calls[0]?.headers.get("idempotency-key")).toBe("abc-123");
    expect(costCalls[0]?.cacheReadTokens).toBe(3);
  });

  it("400 with context_length_exceeded → LLMContextLengthError", async () => {
    const { fetch: f } = makeFakeFetch([
      {
        status: 400,
        textBody: '{"error":{"type":"invalid_request","code":"context_length_exceeded"}}',
      },
    ]);
    const client = createLLMClient({ provider: "openai", token: TOKEN, fetch: f });
    const result = await client.complete({
      model: "gpt-4o",
      messages: [{ role: "user", content: "too long" }],
      maxOutputTokens: 100,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("context-length");
  });

  it("422 → LLMValidationError", async () => {
    const { fetch: f } = makeFakeFetch([{ status: 422 }]);
    const client = createLLMClient({ provider: "openai", token: TOKEN, fetch: f });
    const result = await client.complete({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      maxOutputTokens: 100,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(LLMValidationError);
  });
});

// ---------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------

describe("OllamaAdapter", () => {
  it("happy path — no auth header, local endpoint, parses message.content", async () => {
    const { fetch: f, calls } = makeFakeFetch([
      {
        status: 200,
        body: {
          model: "llama3.2",
          message: { role: "assistant", content: "hello from ollama" },
          done: true,
          done_reason: "stop",
          prompt_eval_count: 7,
          eval_count: 4,
        },
      },
    ]);
    const { hook, calls: costCalls } = captureHook();
    const client = createLLMClient({
      provider: "ollama",
      token: null,
      fetch: f,
      model: "llama3.2",
    });
    const result = await client.complete(
      {
        model: "llama3.2",
        messages: [{ role: "user", content: "hi" }],
        maxOutputTokens: 100,
      },
      { costHook: hook },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toBe("hello from ollama");
      expect(result.value.inputTokens).toBe(7);
      expect(result.value.outputTokens).toBe(4);
      expect(result.value.providerUsed).toBe("ollama");
    }
    expect(calls[0]?.url).toBe("http://localhost:11434/api/chat");
    expect(calls[0]?.headers.get("authorization")).toBeNull();
    expect(calls[0]?.headers.get("x-api-key")).toBeNull();
    expect(costCalls[0]?.provider).toBe("ollama");
  });

  it("503 → LLMProviderOutageError immediately (no retry)", async () => {
    const { fetch: f, calls } = makeFakeFetch([{ status: 503 }]);
    const client = createLLMClient({
      provider: "ollama",
      token: null,
      fetch: f,
      model: "llama3.2",
    });
    const result = await client.complete({
      model: "llama3.2",
      messages: [{ role: "user", content: "hi" }],
      maxOutputTokens: 100,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(LLMProviderOutageError);
    // Ollama maxAttempts=1; the fake fetch must have been called exactly once.
    expect(calls).toHaveLength(1);
  });

  it("transport failure → LLMTransportError", async () => {
    // eslint-disable-next-line @typescript-eslint/require-await -- test double
    const failingFetch: typeof fetch = async () => {
      throw new Error("connection refused");
    };
    const client = createLLMClient({
      provider: "ollama",
      token: null,
      fetch: failingFetch,
      model: "llama3.2",
    });
    const result = await client.complete({
      model: "llama3.2",
      messages: [{ role: "user", content: "hi" }],
      maxOutputTokens: 100,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(LLMTransportError);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting
// ---------------------------------------------------------------------------

describe("createLLMClient", () => {
  it("resolves model from tier when config.model is absent", () => {
    const client = createLLMClient({
      provider: "gemini",
      token: TOKEN,
      tier: "fast",
    });
    expect(client.capabilities().provider).toBe("gemini");
  });

  it("capabilities report streaming/tools/vision/jsonMode all false for Phase 2", () => {
    const client = createLLMClient({ provider: "anthropic", token: TOKEN });
    const caps = client.capabilities();
    expect(caps.supportsStreaming).toBe(false);
    expect(caps.supportsToolUse).toBe(false);
    expect(caps.supportsVision).toBe(false);
    expect(caps.supportsJsonMode).toBe(false);
  });
});

describe("Model tier resolution", () => {
  it("returns concrete model for every (provider, tier) combination", () => {
    const providers = ["gemini", "anthropic", "openai", "ollama"] as const;
    const tiers = ["fast", "balanced", "deep"] as const;
    for (const provider of providers) {
      for (const tier of tiers) {
        const model = resolveModelForTier(provider, tier);
        expect(model.length).toBeGreaterThan(0);
        expect(MODEL_TIER_TABLE[provider][tier]).toBe(model);
      }
    }
  });
});

describe("Token redaction in errors", () => {
  it("raw token does not appear in serialized transport errors", async () => {
    const rawToken = "ghp_sekrit_dont_leak_0123456789";
    const token = makeSecretValue(rawToken);
    // eslint-disable-next-line @typescript-eslint/require-await -- test double
    const failingFetch: typeof fetch = async () => {
      throw new Error(`wrapper error containing ${rawToken}`);
    };
    const client = createLLMClient({
      provider: "anthropic",
      token,
      fetch: failingFetch,
      retryPolicy: {
        maxAttempts: 1,
        baseDelayMs: 0,
        maxDelayMs: 0,
        retryableStatuses: [],
        honourRetryAfter: false,
      },
    });
    const result = await client.complete({
      model: "claude-sonnet-4-5-20250929",
      messages: [{ role: "user", content: "hi" }],
      maxOutputTokens: 10,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const serialised = JSON.stringify({
        message: result.error.message,
        code: result.error.code,
        status: result.error.status,
        cause: result.error.cause,
      });
      expect(serialised).not.toContain(rawToken);
    }
  });
});
