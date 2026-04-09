/**
 * Per-provider LLM pricing catalog. Populates
 * `WakeCostRecord.llm.costMicros` via `resolveLLMCost` in
 * `./resolve.ts`. Seed entries are PLACEHOLDER for the paid
 * providers — the 2B6 gate flips Gemini by spot-checking against
 * the Google AI Studio console; Anthropic + OpenAI are flipped via
 * a Source spot check before Phase 3.
 *
 * See `docs/adr/0015-pricing-catalog.md` for the full rationale.
 */

import type { ModelTier } from "../types.js";
import type { ProviderId } from "../types.js";

export interface ProviderRate {
  readonly provider: ProviderId;
  readonly model: string;
  readonly tier: ModelTier;
  readonly inputUSDMicrosPerMillionTokens: number;
  readonly outputUSDMicrosPerMillionTokens: number;
  readonly cacheReadUSDMicrosPerMillionTokens?: number;
  readonly cacheWriteUSDMicrosPerMillionTokens?: number;
  readonly maxContextTokens: number;
  readonly source: string;
  readonly effectiveFrom: string; // ISO "YYYY-MM-DD"
}

/**
 * Seed catalog. **Every paid rate is marked PLACEHOLDER** —
 * ADR-0015 §S5. The 2B6 gate test resolves the Gemini entries by
 * spot-checking a live call against the AI Studio console; a
 * separate Source spot check resolves Anthropic + OpenAI before
 * Phase 3.
 */
export const SEED_CATALOG: readonly ProviderRate[] = [
  // ───── Google Gemini ────────────────────────────────────────────
  {
    provider: "gemini",
    model: "gemini-2.5-flash",
    tier: "fast",
    // $0.30/M input (text/image/video). Audio input is $1.00/M but
    // the harness only sends text in Phase 2, so the text rate applies.
    inputUSDMicrosPerMillionTokens: 300_000,
    // $2.50/M output. Google bills thinking tokens at the output rate
    // — see CF-llm-I: the adapter must sum `usageMetadata.candidatesTokenCount`
    // + `thoughtsTokenCount` to report true billed output count.
    outputUSDMicrosPerMillionTokens: 2_500_000,
    maxContextTokens: 1_048_576,
    source:
      "Verified 2026-04-09 via live 2A11 smoke call + https://ai.google.dev/gemini-api/docs/pricing",
    effectiveFrom: "2026-04-09",
  },
  {
    provider: "gemini",
    model: "gemini-2.5-pro",
    tier: "balanced",
    inputUSDMicrosPerMillionTokens: 1_250_000, // ≈ $1.25/M — VERIFY
    outputUSDMicrosPerMillionTokens: 10_000_000, // ≈ $10/M — VERIFY
    maxContextTokens: 2_097_152,
    source:
      "PLACEHOLDER — verify before Phase 2 gate (https://ai.google.dev/gemini-api/docs/pricing)",
    effectiveFrom: "2026-04-09",
  },

  // ───── Anthropic ────────────────────────────────────────────────
  {
    provider: "anthropic",
    model: "claude-sonnet-4-5-20250929",
    tier: "balanced",
    inputUSDMicrosPerMillionTokens: 3_000_000, // ≈ $3/M — VERIFY
    outputUSDMicrosPerMillionTokens: 15_000_000, // ≈ $15/M — VERIFY
    cacheReadUSDMicrosPerMillionTokens: 300_000, // ≈ 0.1× input — VERIFY
    cacheWriteUSDMicrosPerMillionTokens: 3_750_000, // ≈ 1.25× input — VERIFY
    maxContextTokens: 200_000,
    source: "PLACEHOLDER — verify before Phase 3 (https://www.anthropic.com/pricing)",
    effectiveFrom: "2026-04-09",
  },
  {
    provider: "anthropic",
    model: "claude-opus-4-6-20251030",
    tier: "deep",
    inputUSDMicrosPerMillionTokens: 15_000_000, // ≈ $15/M — VERIFY
    outputUSDMicrosPerMillionTokens: 75_000_000, // ≈ $75/M — VERIFY
    cacheReadUSDMicrosPerMillionTokens: 1_500_000, // ≈ 0.1× input — VERIFY
    cacheWriteUSDMicrosPerMillionTokens: 18_750_000, // ≈ 1.25× input — VERIFY
    maxContextTokens: 1_000_000,
    source: "PLACEHOLDER — verify before Phase 3 (https://www.anthropic.com/pricing)",
    effectiveFrom: "2026-04-09",
  },

  // ───── OpenAI ───────────────────────────────────────────────────
  {
    provider: "openai",
    model: "gpt-4o",
    tier: "balanced",
    inputUSDMicrosPerMillionTokens: 2_500_000, // ≈ $2.50/M — VERIFY
    outputUSDMicrosPerMillionTokens: 10_000_000, // ≈ $10/M — VERIFY
    cacheReadUSDMicrosPerMillionTokens: 1_250_000, // 50% of input — VERIFY
    maxContextTokens: 128_000,
    source: "PLACEHOLDER — verify before Phase 3 (https://openai.com/api/pricing/)",
    effectiveFrom: "2026-04-09",
  },
  {
    provider: "openai",
    model: "gpt-4o-mini",
    tier: "fast",
    inputUSDMicrosPerMillionTokens: 150_000, // ≈ $0.15/M — VERIFY
    outputUSDMicrosPerMillionTokens: 600_000, // ≈ $0.60/M — VERIFY
    cacheReadUSDMicrosPerMillionTokens: 75_000, // 50% of input — VERIFY
    maxContextTokens: 128_000,
    source: "PLACEHOLDER — verify before Phase 3 (https://openai.com/api/pricing/)",
    effectiveFrom: "2026-04-09",
  },

  // ───── Ollama sentinel (real entry, zero rate) ──────────────────
  {
    provider: "ollama",
    model: "ollama-local",
    tier: "fast",
    inputUSDMicrosPerMillionTokens: 0,
    outputUSDMicrosPerMillionTokens: 0,
    maxContextTokens: 131_072,
    source: "Local inference, no per-token cost",
    effectiveFrom: "2026-04-09",
  },
];
