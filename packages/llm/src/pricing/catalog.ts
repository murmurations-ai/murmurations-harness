/**
 * Per-provider LLM pricing catalog. Populates
 * `WakeCostRecord.llm.costMicros` via `resolveLLMCost` in
 * `./resolve.ts`.
 *
 * Update protocol: when a new model ships, fetch the pricing from the
 * provider's published table and add an entry below with a `source:`
 * line that records the URL + the date you verified it. Stale entries
 * are detectable by their `effectiveFrom` and `source` fields.
 *
 * Operators running models not in this catalog will see a
 * `daemon.cost.pricing.unknown` warn event in the daemon log and
 * `costMicros: 0` in their wake cost record. The zero is **not a
 * bill** — it is a "we couldn't price this call" sentinel that the
 * warn event explains. File an issue with the model id and we'll
 * add a verified entry.
 *
 * Source URLs (verified 2026-04-30):
 * - OpenAI:    https://developers.openai.com/api/docs/pricing
 *              and per-model pages https://developers.openai.com/api/docs/models/<id>
 * - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
 * - Gemini:    https://ai.google.dev/gemini-api/docs/pricing
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

const VERIFIED_2026_04_30 = "2026-04-30";

const OPENAI_PRICING_URL = "https://developers.openai.com/api/docs/pricing";
const ANTHROPIC_PRICING_URL = "https://platform.claude.com/docs/en/about-claude/pricing";
const GEMINI_PRICING_URL = "https://ai.google.dev/gemini-api/docs/pricing";

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
    source: `Verified 2026-04-30 via ${GEMINI_PRICING_URL}`,
    effectiveFrom: VERIFIED_2026_04_30,
  },
  {
    provider: "gemini",
    model: "gemini-2.5-flash-lite",
    tier: "fast",
    // $0.10/M input (text/image/video), $0.40/M output. Audio input
    // is $0.30/M; harness only sends text so text rate applies.
    inputUSDMicrosPerMillionTokens: 100_000,
    outputUSDMicrosPerMillionTokens: 400_000,
    maxContextTokens: 1_048_576,
    source: `Verified 2026-04-30 via ${GEMINI_PRICING_URL}`,
    effectiveFrom: VERIFIED_2026_04_30,
  },
  {
    provider: "gemini",
    model: "gemini-2.5-pro",
    tier: "balanced",
    // $1.25/M input / $10/M output for prompts ≤200K tokens. Long
    // prompts >200K are billed at $2.50/M input and $15/M output for
    // the full request, but the catalog can't represent conditional
    // pricing today — pick the short-prompt rate as the canonical
    // entry; long-prompt usage will under-report by at most 2x until
    // we model this properly (tracked separately).
    inputUSDMicrosPerMillionTokens: 1_250_000,
    outputUSDMicrosPerMillionTokens: 10_000_000,
    maxContextTokens: 2_097_152,
    source: `Verified 2026-04-30 via ${GEMINI_PRICING_URL}`,
    effectiveFrom: VERIFIED_2026_04_30,
  },

  // ───── Anthropic ────────────────────────────────────────────────
  // Pricing pattern across the 4.x line: input/output rates fixed
  // per tier, prompt-cache 5min-write at 1.25× input, cache-read at
  // 0.1× input. Source: platform.claude.com/docs/en/about-claude/pricing.
  {
    provider: "anthropic",
    model: "claude-haiku-4-5",
    tier: "fast",
    inputUSDMicrosPerMillionTokens: 1_000_000, // $1/M
    outputUSDMicrosPerMillionTokens: 5_000_000, // $5/M
    cacheReadUSDMicrosPerMillionTokens: 100_000, // $0.10/M (0.1× input)
    cacheWriteUSDMicrosPerMillionTokens: 1_250_000, // $1.25/M (1.25× input, 5m)
    maxContextTokens: 200_000,
    source: `Verified 2026-04-30 via ${ANTHROPIC_PRICING_URL}`,
    effectiveFrom: VERIFIED_2026_04_30,
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-4-5-20250929",
    tier: "balanced",
    inputUSDMicrosPerMillionTokens: 3_000_000, // $3/M
    outputUSDMicrosPerMillionTokens: 15_000_000, // $15/M
    cacheReadUSDMicrosPerMillionTokens: 300_000, // $0.30/M
    cacheWriteUSDMicrosPerMillionTokens: 3_750_000, // $3.75/M (5m write)
    maxContextTokens: 200_000,
    source: `Verified 2026-04-30 via ${ANTHROPIC_PRICING_URL}`,
    effectiveFrom: VERIFIED_2026_04_30,
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    tier: "balanced",
    inputUSDMicrosPerMillionTokens: 3_000_000,
    outputUSDMicrosPerMillionTokens: 15_000_000,
    cacheReadUSDMicrosPerMillionTokens: 300_000,
    cacheWriteUSDMicrosPerMillionTokens: 3_750_000,
    maxContextTokens: 1_000_000, // 1M long-context window
    source: `Verified 2026-04-30 via ${ANTHROPIC_PRICING_URL}`,
    effectiveFrom: VERIFIED_2026_04_30,
  },
  {
    provider: "anthropic",
    model: "claude-opus-4-5",
    tier: "deep",
    inputUSDMicrosPerMillionTokens: 5_000_000, // $5/M (4.5/4.6/4.7 share this row)
    outputUSDMicrosPerMillionTokens: 25_000_000, // $25/M
    cacheReadUSDMicrosPerMillionTokens: 500_000, // $0.50/M
    cacheWriteUSDMicrosPerMillionTokens: 6_250_000, // $6.25/M (5m write)
    maxContextTokens: 200_000,
    source: `Verified 2026-04-30 via ${ANTHROPIC_PRICING_URL}`,
    effectiveFrom: VERIFIED_2026_04_30,
  },
  {
    provider: "anthropic",
    model: "claude-opus-4-6",
    tier: "deep",
    inputUSDMicrosPerMillionTokens: 5_000_000,
    outputUSDMicrosPerMillionTokens: 25_000_000,
    cacheReadUSDMicrosPerMillionTokens: 500_000,
    cacheWriteUSDMicrosPerMillionTokens: 6_250_000,
    maxContextTokens: 1_000_000,
    source: `Verified 2026-04-30 via ${ANTHROPIC_PRICING_URL}`,
    effectiveFrom: VERIFIED_2026_04_30,
  },
  {
    provider: "anthropic",
    model: "claude-opus-4-7",
    tier: "deep",
    inputUSDMicrosPerMillionTokens: 5_000_000,
    outputUSDMicrosPerMillionTokens: 25_000_000,
    cacheReadUSDMicrosPerMillionTokens: 500_000,
    cacheWriteUSDMicrosPerMillionTokens: 6_250_000,
    maxContextTokens: 1_000_000,
    source: `Verified 2026-04-30 via ${ANTHROPIC_PRICING_URL}`,
    effectiveFrom: VERIFIED_2026_04_30,
  },

  // ───── OpenAI ───────────────────────────────────────────────────
  // The 5.4 / 5.5 lines are current as of 2026-04-30. Earlier
  // single-digit-only ids (gpt-5, gpt-5.1) are still callable but
  // OpenAI has positioned 5.4 / 5.5 as the recommended path; we keep
  // the older entries so existing operator configs don't fall into
  // the unknown-model warn.
  {
    provider: "openai",
    model: "gpt-5",
    tier: "balanced",
    inputUSDMicrosPerMillionTokens: 1_250_000, // $1.25/M
    outputUSDMicrosPerMillionTokens: 10_000_000, // $10/M
    cacheReadUSDMicrosPerMillionTokens: 125_000, // $0.125/M (0.1× input)
    maxContextTokens: 400_000,
    source: `Verified 2026-04-30 via ${OPENAI_PRICING_URL}`,
    effectiveFrom: VERIFIED_2026_04_30,
  },
  {
    provider: "openai",
    model: "gpt-5.1",
    tier: "balanced",
    inputUSDMicrosPerMillionTokens: 1_250_000,
    outputUSDMicrosPerMillionTokens: 10_000_000,
    cacheReadUSDMicrosPerMillionTokens: 125_000,
    maxContextTokens: 400_000,
    source: `Verified 2026-04-30 via ${OPENAI_PRICING_URL}`,
    effectiveFrom: VERIFIED_2026_04_30,
  },
  {
    provider: "openai",
    model: "gpt-5-codex",
    tier: "balanced",
    inputUSDMicrosPerMillionTokens: 1_250_000,
    outputUSDMicrosPerMillionTokens: 10_000_000,
    cacheReadUSDMicrosPerMillionTokens: 125_000,
    maxContextTokens: 400_000,
    source: `Verified 2026-04-30 via ${OPENAI_PRICING_URL}`,
    effectiveFrom: VERIFIED_2026_04_30,
  },
  {
    provider: "openai",
    model: "gpt-5.4",
    tier: "balanced",
    inputUSDMicrosPerMillionTokens: 2_500_000, // $2.50/M
    outputUSDMicrosPerMillionTokens: 15_000_000, // $15/M
    cacheReadUSDMicrosPerMillionTokens: 250_000, // $0.25/M
    maxContextTokens: 1_050_000,
    source: `Verified 2026-04-30 via ${OPENAI_PRICING_URL}`,
    effectiveFrom: VERIFIED_2026_04_30,
  },
  {
    provider: "openai",
    model: "gpt-5.4-mini",
    tier: "fast",
    inputUSDMicrosPerMillionTokens: 750_000, // $0.75/M
    outputUSDMicrosPerMillionTokens: 4_500_000, // $4.50/M
    cacheReadUSDMicrosPerMillionTokens: 75_000, // $0.075/M
    maxContextTokens: 400_000,
    source: `Verified 2026-04-30 via ${OPENAI_PRICING_URL}`,
    effectiveFrom: VERIFIED_2026_04_30,
  },
  {
    provider: "openai",
    model: "gpt-5.4-nano",
    tier: "fast",
    inputUSDMicrosPerMillionTokens: 200_000, // $0.20/M
    outputUSDMicrosPerMillionTokens: 1_250_000, // $1.25/M
    // Cached input not separately listed for the nano tier; resolve.ts
    // falls back to input rate when cache rate is omitted, which is
    // conservative (over-reports cache cost rather than zero).
    maxContextTokens: 400_000,
    source: `Verified 2026-04-30 via ${OPENAI_PRICING_URL}`,
    effectiveFrom: VERIFIED_2026_04_30,
  },
  {
    provider: "openai",
    model: "gpt-5.4-pro",
    tier: "deep",
    inputUSDMicrosPerMillionTokens: 30_000_000, // $30/M
    outputUSDMicrosPerMillionTokens: 180_000_000, // $180/M
    // The pro tier doesn't offer a cached-input discount.
    maxContextTokens: 1_050_000,
    source: `Verified 2026-04-30 via ${OPENAI_PRICING_URL}`,
    effectiveFrom: VERIFIED_2026_04_30,
  },
  {
    provider: "openai",
    model: "gpt-5.5",
    tier: "deep",
    inputUSDMicrosPerMillionTokens: 5_000_000, // $5/M
    outputUSDMicrosPerMillionTokens: 30_000_000, // $30/M
    cacheReadUSDMicrosPerMillionTokens: 500_000, // $0.50/M
    // Note: prompts >272K input tokens get 2× input + 1.5× output for
    // the full session. Catalog doesn't model conditional rates yet;
    // long-prompt usage under-reports by up to 2×.
    maxContextTokens: 1_050_000,
    source: `Verified 2026-04-30 via ${OPENAI_PRICING_URL}`,
    effectiveFrom: VERIFIED_2026_04_30,
  },
  {
    provider: "openai",
    model: "gpt-5.5-pro",
    tier: "deep",
    inputUSDMicrosPerMillionTokens: 30_000_000, // $30/M
    outputUSDMicrosPerMillionTokens: 180_000_000, // $180/M
    // No cached-input discount on pro tier.
    maxContextTokens: 1_050_000,
    source: `Verified 2026-04-30 via ${OPENAI_PRICING_URL}`,
    effectiveFrom: VERIFIED_2026_04_30,
  },
  {
    provider: "openai",
    model: "gpt-4o",
    tier: "balanced",
    inputUSDMicrosPerMillionTokens: 2_500_000, // $2.50/M
    outputUSDMicrosPerMillionTokens: 10_000_000, // $10/M
    cacheReadUSDMicrosPerMillionTokens: 1_250_000, // $1.25/M (50% of input)
    maxContextTokens: 128_000,
    source: `Verified 2026-04-30 via ${OPENAI_PRICING_URL}`,
    effectiveFrom: VERIFIED_2026_04_30,
  },
  {
    provider: "openai",
    model: "gpt-4o-mini",
    tier: "fast",
    inputUSDMicrosPerMillionTokens: 150_000, // $0.15/M
    outputUSDMicrosPerMillionTokens: 600_000, // $0.60/M
    cacheReadUSDMicrosPerMillionTokens: 75_000, // $0.075/M (50% of input)
    maxContextTokens: 128_000,
    source: `Verified 2026-04-30 via ${OPENAI_PRICING_URL}`,
    effectiveFrom: VERIFIED_2026_04_30,
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
