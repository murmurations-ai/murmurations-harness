import { describe, expect, it } from "vitest";

import { resolveLLMCost, SEED_CATALOG } from "./index.js";
import type { ProviderRate } from "./index.js";

describe("resolveLLMCost", () => {
  it("Gemini 2.5 Pro 1000 in + 500 out = 6_250 micros", () => {
    // input: 1000 * 1_250_000 / 1_000_000 = 1_250 micros
    // output: 500 * 10_000_000 / 1_000_000 = 5_000 micros
    // total: 6_250 micros
    const result = resolveLLMCost({
      provider: "gemini",
      model: "gemini-2.5-pro",
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.value).toBe(6_250);
  });

  it("returns unknown-model for an unknown Gemini model", () => {
    const result = resolveLLMCost({
      provider: "gemini",
      model: "gemini-7.0-omega",
      inputTokens: 100,
      outputTokens: 100,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("unknown-model");
      expect(result.error.provider).toBe("gemini");
    }
  });

  it("rejects negative input tokens", () => {
    const result = resolveLLMCost({
      provider: "gemini",
      model: "gemini-2.5-pro",
      inputTokens: -1,
      outputTokens: 100,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("negative-tokens");
  });

  it("rejects negative output tokens", () => {
    const result = resolveLLMCost({
      provider: "gemini",
      model: "gemini-2.5-pro",
      inputTokens: 100,
      outputTokens: -1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("negative-tokens");
  });

  it("Ollama returns zero for any model via the sentinel", () => {
    const result = resolveLLMCost({
      provider: "ollama",
      model: "llama3.2",
      inputTokens: 100_000,
      outputTokens: 50_000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.value).toBe(0);
  });

  it("Ollama with the canonical 'ollama-local' model returns zero", () => {
    const result = resolveLLMCost({
      provider: "ollama",
      model: "ollama-local",
      inputTokens: 1_000_000,
      outputTokens: 500_000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.value).toBe(0);
  });

  it("Anthropic cache read applies the discounted rate", () => {
    // Sonnet 4.5: cache read rate = 300_000 micros/M
    // 10_000 cacheReadTokens * 300_000 / 1M = 3_000 micros
    // No input/output tokens.
    const result = resolveLLMCost({
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 10_000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.value).toBe(3_000);
  });

  it("Anthropic cache write applies the premium rate", () => {
    // Sonnet 4.5: cache write rate = 3_750_000 micros/M
    // 1_000 cacheWriteTokens * 3_750_000 / 1M = 3_750 micros
    const result = resolveLLMCost({
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 1_000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.value).toBe(3_750);
  });

  it("Gemini without cache rate falls back to input rate on cache tokens (safe over-count)", () => {
    // Gemini 2.5 Pro has NO cacheRead rate set. The resolver falls
    // back to input rate for any cacheReadTokens > 0.
    // 1000 * 1_250_000 / 1M = 1_250 micros (same as input)
    const result = resolveLLMCost({
      provider: "gemini",
      model: "gemini-2.5-pro",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.value).toBe(1_250);
  });

  it("Sonnet 4.5 mixed 50K input + 8K output matches hand computation", () => {
    // input: 50_000 * 3_000_000 / 1M = 150_000 micros
    // output: 8_000 * 15_000_000 / 1M = 120_000 micros
    // total: 270_000 micros = $0.27
    const result = resolveLLMCost({
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
      inputTokens: 50_000,
      outputTokens: 8_000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.value).toBe(270_000);
  });

  it("every seed catalog entry has all required fields", () => {
    for (const rate of SEED_CATALOG) {
      expect(rate.provider).toBeDefined();
      expect(rate.model.length).toBeGreaterThan(0);
      expect(rate.tier).toBeDefined();
      expect(Number.isInteger(rate.inputUSDMicrosPerMillionTokens)).toBe(true);
      expect(Number.isInteger(rate.outputUSDMicrosPerMillionTokens)).toBe(true);
      expect(rate.maxContextTokens).toBeGreaterThan(0);
      expect(rate.source.length).toBeGreaterThan(0);
      expect(rate.effectiveFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it.skip("resolves asOf parameter against historical entries (Phase 3 tripwire)", () => {
    // Enable when the second row per (provider, model) appears in SEED_CATALOG.
    // Until then, v0.1 always returns the first match.
  });

  it("TypeScript: ProviderRate type is exported", () => {
    const sample: ProviderRate = {
      provider: "ollama",
      model: "test",
      tier: "fast",
      inputUSDMicrosPerMillionTokens: 0,
      outputUSDMicrosPerMillionTokens: 0,
      maxContextTokens: 1000,
      source: "test",
      effectiveFrom: "2026-04-09",
    };
    expect(sample.provider).toBe("ollama");
  });
});
