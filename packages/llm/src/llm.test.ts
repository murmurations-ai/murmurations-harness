/**
 * LLM package tests — Vercel AI SDK adapter.
 *
 * Uses MockLanguageModelV3 from ai/test with V3 result format.
 */

import { describe, it, expect } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { makeSecretValue } from "@murmurations-ai/core";

import { VercelAdapter } from "./adapters/vercel-adapter.js";
import { createLLMClient } from "./client.js";
import type { LLMCostHook } from "./cost-hook.js";
import {
  LLMUnauthorizedError,
  LLMForbiddenError,
  LLMRateLimitError,
  LLMTransportError,
  LLMContentPolicyError,
  LLMContextLengthError,
  LLMValidationError,
  LLMParseError,
  LLMInternalError,
} from "./errors.js";
import type { LLMRequest } from "./types.js";
import { ProviderRegistry } from "./providers.js";
import type { ProviderDefinition } from "./providers.js";

// Minimal test fixture — the llm package ships no built-ins.
const buildTestRegistry = (): ProviderRegistry => {
  const r = new ProviderRegistry();
  const fakeProvider: ProviderDefinition = {
    id: "gemini",
    displayName: "Gemini (test)",
    envKeyName: "GEMINI_API_KEY",
    tiers: { fast: "gemini-2.5-flash", balanced: "gemini-2.5-pro", deep: "gemini-2.5-pro" },
    create: () => Promise.resolve({} as never),
  };
  r.register(fakeProvider);
  return r;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeRequest = (overrides: Partial<LLMRequest> = {}): LLMRequest => ({
  model: "test-model",
  messages: [{ role: "user", content: "Hello" }],
  maxOutputTokens: 1000,
  ...overrides,
});

/** V3 finish reason must be an object with `unified` as a specific literal. */
const fr = <T extends string>(reason: T) => ({ unified: reason, raw: reason });

const makeMockModel = (
  text: string,
  usage = {
    inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 20, text: undefined, reasoning: undefined },
  },
): MockLanguageModelV3 =>
  new MockLanguageModelV3({
    doGenerate: {
      content: [{ type: "text", text }],
      usage,
      finishReason: fr("stop"),
      warnings: [],
    },
  });

// ---------------------------------------------------------------------------
// VercelAdapter
// ---------------------------------------------------------------------------

describe("VercelAdapter", () => {
  it("happy path — maps response content and tokens", async () => {
    const model = makeMockModel("Hello from the LLM!", {
      inputTokens: { total: 50, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 100, text: undefined, reasoning: undefined },
    });
    const adapter = new VercelAdapter("gemini", "test-model", model);
    const result = await adapter.complete(makeRequest(), {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toBe("Hello from the LLM!");
      expect(result.value.inputTokens).toBe(50);
      expect(result.value.outputTokens).toBe(100);
      expect(result.value.providerUsed).toBe("gemini");
      expect(result.value.modelUsed).toBe("test-model");
      expect(result.value.stopReason).toBe("stop");
    }
  });

  it("emits cost hook with token counts", async () => {
    const model = makeMockModel("response", {
      inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 200, text: undefined, reasoning: undefined },
    });
    const adapter = new VercelAdapter("openai", "gpt-4o", model);
    const hookCalls: { inputTokens: number; outputTokens: number }[] = [];
    const costHook: LLMCostHook = {
      onLlmCall: (call) => hookCalls.push(call),
    };

    await adapter.complete(makeRequest(), { costHook });

    expect(hookCalls).toHaveLength(1);
    expect(hookCalls[0]?.inputTokens).toBe(100);
    expect(hookCalls[0]?.outputTokens).toBe(200);
  });

  it("does not throw when no cost hook provided", async () => {
    const model = makeMockModel("response");
    const adapter = new VercelAdapter("gemini", "test", model);
    const result = await adapter.complete(makeRequest(), {});
    expect(result.ok).toBe(true);
  });

  it("handles errors as Result.error (not thrown)", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: () => {
        throw new Error("Something went wrong");
      },
    });
    const adapter = new VercelAdapter("gemini", "test", model);
    const result = await adapter.complete(makeRequest(), {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.provider).toBe("gemini");
      expect(result.error.message).toContain("Something went wrong");
    }
  });

  it("handles missing usage gracefully (defaults to 0)", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: {
        content: [{ type: "text", text: "ok" }],
        usage: {
          inputTokens: {
            total: undefined,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: {
            total: undefined,
            text: undefined,
            reasoning: undefined,
          },
        },
        finishReason: fr("stop"),
        warnings: [],
      },
    });
    const adapter = new VercelAdapter("ollama", "llama3", model);
    const result = await adapter.complete(makeRequest(), {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.inputTokens).toBe(0);
      expect(result.value.outputTokens).toBe(0);
    }
  });

  it("works with all four providers", async () => {
    for (const provider of ["gemini", "anthropic", "openai", "ollama"] as const) {
      const model = makeMockModel(`hello from ${provider}`);
      const adapter = new VercelAdapter(provider, "test-model", model);
      const result = await adapter.complete(makeRequest(), {});
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.providerUsed).toBe(provider);
        expect(result.value.content).toContain(provider);
      }
    }
  });

  it("passes system prompt from systemPromptOverride", async () => {
    const model = makeMockModel("ok");
    const adapter = new VercelAdapter("anthropic", "claude", model);
    await adapter.complete(makeRequest({ systemPromptOverride: "You are a researcher." }), {});
    // MockLanguageModelV3 records calls
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("converts tools and collects tool call results", async () => {
    let callCount = 0;
    const model = new MockLanguageModelV3({
      // eslint-disable-next-line @typescript-eslint/require-await
      doGenerate: async () => {
        callCount++;
        if (callCount === 1) {
          return {
            content: [
              {
                type: "tool-call" as const,
                toolCallId: "tc-1",
                toolName: "readFile",
                input: JSON.stringify({ path: "/tmp/test.md" }),
              },
            ],
            usage: {
              inputTokens: {
                total: 30,
                noCache: undefined,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 10, text: undefined, reasoning: undefined },
            },
            finishReason: fr("tool-calls"),
            warnings: [],
          };
        }
        return {
          content: [{ type: "text" as const, text: "File contents: hello world" }],
          usage: {
            inputTokens: {
              total: 40,
              noCache: undefined,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: 20, text: undefined, reasoning: undefined },
          },
          finishReason: fr("stop"),
          warnings: [],
        };
      },
    });

    const adapter = new VercelAdapter("openai", "gpt-4o", model);
    const { z } = await import("zod");

    const result = await adapter.complete(
      makeRequest({
        tools: [
          {
            name: "readFile",
            description: "Read a file",
            parameters: z.object({ path: z.string() }),
            execute: (input) => Promise.resolve(`contents of ${(input as { path: string }).path}`),
          },
        ],
        maxSteps: 3,
      }),
      {},
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toBe("File contents: hello world");
      expect(result.value.stopReason).toBe("stop");
      expect(result.value.toolCalls).toBeDefined();
      expect(result.value.toolCalls!.length).toBeGreaterThanOrEqual(1);
      expect(result.value.toolCalls![0]!.name).toBe("readFile");
      expect(result.value.steps).toBe(2);
    }
  });

  it("emits cost hook per step in multi-step tool loops", async () => {
    let stepCount = 0;
    const model = new MockLanguageModelV3({
      // eslint-disable-next-line @typescript-eslint/require-await
      doGenerate: async () => {
        stepCount++;
        if (stepCount === 1) {
          return {
            content: [
              {
                type: "tool-call" as const,
                toolCallId: "tc-1",
                toolName: "echo",
                input: JSON.stringify({ msg: "hi" }),
              },
            ],
            usage: {
              inputTokens: {
                total: 10,
                noCache: undefined,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 5, text: undefined, reasoning: undefined },
            },
            finishReason: fr("tool-calls"),
            warnings: [],
          };
        }
        return {
          content: [{ type: "text" as const, text: "done" }],
          usage: {
            inputTokens: {
              total: 20,
              noCache: undefined,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: 15, text: undefined, reasoning: undefined },
          },
          finishReason: fr("stop"),
          warnings: [],
        };
      },
    });

    const adapter = new VercelAdapter("anthropic", "claude", model);
    const hookCalls: { inputTokens: number; outputTokens: number }[] = [];
    const costHook: LLMCostHook = {
      onLlmCall: (call) => hookCalls.push(call),
    };
    const { z } = await import("zod");

    await adapter.complete(
      makeRequest({
        tools: [
          {
            name: "echo",
            description: "Echo",
            parameters: z.object({ msg: z.string() }),
            execute: (input) => Promise.resolve((input as { msg: string }).msg),
          },
        ],
        maxSteps: 3,
      }),
      { costHook },
    );

    // Should emit one hook call per step
    expect(hookCalls).toHaveLength(2);
    expect(hookCalls[0]!.inputTokens).toBe(10);
    expect(hookCalls[1]!.inputTokens).toBe(20);
  });

  it("handles single-step with no tools (no toolCalls in response)", async () => {
    const model = makeMockModel("just text");
    const adapter = new VercelAdapter("gemini", "test", model);
    const result = await adapter.complete(makeRequest(), {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.toolCalls).toBeUndefined();
      expect(result.value.steps).toBeUndefined();
    }
  });

  it("maps tool-calls finish reason correctly", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: {
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "tc-1",
            toolName: "readFile",
            input: JSON.stringify({ path: "/test" }),
          },
        ],
        usage: {
          inputTokens: {
            total: 10,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: {
            total: 5,
            text: undefined,
            reasoning: undefined,
          },
        },
        finishReason: fr("tool-calls"),
        warnings: [],
      },
    });

    const adapter = new VercelAdapter("openai", "gpt-4o", model);
    const { z } = await import("zod");

    const result = await adapter.complete(
      makeRequest({
        tools: [
          {
            name: "readFile",
            description: "Read a file",
            parameters: z.object({ path: z.string() }),
            execute: () => Promise.resolve("file content"),
          },
        ],
        // maxSteps defaults to undefined (single step, no loop)
      }),
      {},
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.stopReason).toBe("tool_use");
    }
  });
});

// ---------------------------------------------------------------------------
// Error mapping (mapError)
// ---------------------------------------------------------------------------

describe("VercelAdapter error mapping", () => {
  const makeErrorModel = (err: Error | { statusCode: number; message: string }) => {
    return new MockLanguageModelV3({
      doGenerate: () => {
        throw err instanceof Error
          ? err
          : Object.assign(new Error(err.message), { statusCode: err.statusCode });
      },
    });
  };

  it("maps 401 → LLMUnauthorizedError", async () => {
    const adapter = new VercelAdapter(
      "gemini",
      "test",
      makeErrorModel({ statusCode: 401, message: "bad key" }),
    );
    const result = await adapter.complete(makeRequest(), {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(LLMUnauthorizedError);
  });

  it("maps 403 → LLMForbiddenError", async () => {
    const adapter = new VercelAdapter(
      "openai",
      "test",
      makeErrorModel({ statusCode: 403, message: "forbidden" }),
    );
    const result = await adapter.complete(makeRequest(), {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(LLMForbiddenError);
  });

  it("maps 429 → LLMRateLimitError", async () => {
    const adapter = new VercelAdapter(
      "anthropic",
      "test",
      makeErrorModel({ statusCode: 429, message: "slow down" }),
    );
    const result = await adapter.complete(makeRequest(), {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(LLMRateLimitError);
  });

  it("maps 500 → LLMTransportError", async () => {
    const adapter = new VercelAdapter(
      "gemini",
      "test",
      makeErrorModel({ statusCode: 500, message: "server error" }),
    );
    const result = await adapter.complete(makeRequest(), {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(LLMTransportError);
  });

  it("maps 503 → LLMTransportError", async () => {
    const adapter = new VercelAdapter(
      "ollama",
      "test",
      makeErrorModel({ statusCode: 503, message: "unavailable" }),
    );
    const result = await adapter.complete(makeRequest(), {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(LLMTransportError);
  });

  it("maps 400 → LLMValidationError", async () => {
    const adapter = new VercelAdapter(
      "openai",
      "test",
      makeErrorModel({ statusCode: 400, message: "bad request" }),
    );
    const result = await adapter.complete(makeRequest(), {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(LLMValidationError);
  });

  it("maps 422 → LLMValidationError", async () => {
    const adapter = new VercelAdapter(
      "openai",
      "test",
      makeErrorModel({ statusCode: 422, message: "unprocessable" }),
    );
    const result = await adapter.complete(makeRequest(), {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(LLMValidationError);
  });

  it("maps content filter message → LLMContentPolicyError", async () => {
    const adapter = new VercelAdapter(
      "openai",
      "test",
      makeErrorModel(new Error("content filter violation")),
    );
    const result = await adapter.complete(makeRequest(), {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(LLMContentPolicyError);
  });

  it("maps content policy message → LLMContentPolicyError", async () => {
    const adapter = new VercelAdapter(
      "gemini",
      "test",
      makeErrorModel(new Error("blocked by content policy")),
    );
    const result = await adapter.complete(makeRequest(), {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(LLMContentPolicyError);
  });

  it("maps context length message → LLMContextLengthError", async () => {
    const adapter = new VercelAdapter(
      "anthropic",
      "test",
      makeErrorModel(new Error("context too long")),
    );
    const result = await adapter.complete(makeRequest(), {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(LLMContextLengthError);
  });

  it("maps max tokens message → LLMContextLengthError", async () => {
    const adapter = new VercelAdapter(
      "openai",
      "test",
      makeErrorModel(new Error("exceeds max tokens")),
    );
    const result = await adapter.complete(makeRequest(), {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(LLMContextLengthError);
  });

  it("maps parse error message → LLMParseError", async () => {
    const adapter = new VercelAdapter(
      "gemini",
      "test",
      makeErrorModel(new Error("failed to parse response")),
    );
    const result = await adapter.complete(makeRequest(), {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(LLMParseError);
  });

  it("maps unknown error → LLMInternalError", async () => {
    const adapter = new VercelAdapter(
      "gemini",
      "test",
      makeErrorModel(new Error("something unexpected")),
    );
    const result = await adapter.complete(makeRequest(), {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(LLMInternalError);
  });

  it("re-throws AbortError (not wrapped)", async () => {
    const abort = new DOMException("aborted", "AbortError");
    const model = new MockLanguageModelV3({
      doGenerate: () => {
        throw abort;
      },
    });
    const adapter = new VercelAdapter("gemini", "test", model);
    await expect(adapter.complete(makeRequest(), {})).rejects.toThrow("aborted");
  });

  it("preserves provider in error", async () => {
    const adapter = new VercelAdapter("anthropic", "claude-3", makeErrorModel(new Error("oops")));
    const result = await adapter.complete(makeRequest(), {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.provider).toBe("anthropic");
  });
});

// ---------------------------------------------------------------------------
// Model tier resolution
// ---------------------------------------------------------------------------

describe("ProviderRegistry tier resolution", () => {
  it("returns the registered model for known provider+tier", () => {
    const r = buildTestRegistry();
    expect(r.resolveModelForTier("gemini", "balanced")).toBe("gemini-2.5-pro");
    expect(r.resolveModelForTier("gemini", "fast")).toBe("gemini-2.5-flash");
  });

  it("returns undefined for unregistered providers", () => {
    const r = buildTestRegistry();
    expect(r.resolveModelForTier("unknown", "balanced")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createLLMClient
// ---------------------------------------------------------------------------

describe("createLLMClient", () => {
  it("capabilities report streaming/tools/json as true (Vercel SDK)", () => {
    const client = createLLMClient({
      registry: buildTestRegistry(),
      provider: "gemini",
      token: makeSecretValue("fake-key"),
      model: "test-model",
    });
    const caps = client.capabilities();
    expect(caps.supportsStreaming).toBe(true);
    expect(caps.supportsToolUse).toBe(true);
    expect(caps.supportsJsonMode).toBe(true);
  });
});
