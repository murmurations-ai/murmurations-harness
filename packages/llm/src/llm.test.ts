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
import type { LLMRequest } from "./types.js";
import { resolveModelForTier, MODEL_TIER_TABLE } from "./tiers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeRequest = (overrides: Partial<LLMRequest> = {}): LLMRequest => ({
  model: "test-model",
  messages: [{ role: "user", content: "Hello" }],
  maxOutputTokens: 1000,
  ...overrides,
});

const makeMockModel = (
  text: string,
  usage = { inputTokens: { total: 10 }, outputTokens: { total: 20 } },
): MockLanguageModelV3 =>
  new MockLanguageModelV3({
    doGenerate: {
      content: [{ type: "text", text }],
      usage,
      finishReason: "stop",
    },
  });

// ---------------------------------------------------------------------------
// VercelAdapter
// ---------------------------------------------------------------------------

describe("VercelAdapter", () => {
  it("happy path — maps response content and tokens", async () => {
    const model = makeMockModel("Hello from the LLM!", {
      inputTokens: { total: 50 },
      outputTokens: { total: 100 },
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
    }
  });

  it("emits cost hook with token counts", async () => {
    const model = makeMockModel("response", {
      inputTokens: { total: 100 },
      outputTokens: { total: 200 },
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
        usage: { inputTokens: { total: undefined }, outputTokens: { total: undefined } },
        finishReason: "stop",
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
});

// ---------------------------------------------------------------------------
// Model tier resolution
// ---------------------------------------------------------------------------

describe("Model tier resolution", () => {
  it("resolves fast/balanced/deep for all providers", () => {
    for (const provider of ["gemini", "anthropic", "openai", "ollama"] as const) {
      for (const tier of ["fast", "balanced", "deep"] as const) {
        const model = resolveModelForTier(provider, tier);
        expect(model).toBeTruthy();
        expect(model).toBe(MODEL_TIER_TABLE[provider][tier]);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// createLLMClient
// ---------------------------------------------------------------------------

describe("createLLMClient", () => {
  it("capabilities report streaming/tools/json as true (Vercel SDK)", () => {
    const client = createLLMClient({
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
