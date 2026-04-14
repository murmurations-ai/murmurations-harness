# ADR-0015 — Per-provider LLM pricing catalog

- **Status:** Accepted
- **Date:** 2026-04-09
- **Decision-maker(s):** Performance / Observability Agent #27 (author)
- **Consulted:** TypeScript / Runtime Agent #24 (type shape), Architecture Agent #23 (package boundary), DevOps / Release Agent #26 (adapter integration), Engineering Lead #22 (gate alignment)
- **Closes:** P2 in `docs/PHASE-2-PLAN.md`. Unblocks Phase 2B (`packages/llm/pricing/`) and the 2A7 cost-hook integration. Picks up follow-up #1 from ADR-0011 ("LLM pricing catalog").
- **Related:** ADR-0006 (branded primitives), ADR-0010 (secrets), ADR-0011 (cost record), ADR-0014 (LLM client interface — parallel work)

## Context

ADR-0011 froze `WakeCostRecord.llm.costMicros: USDMicros` as the canonical home for per-wake LLM spend. In Phase 1B-c it rides as `ZERO_USD_MICROS` because no LLM call exists. Phase 2 changes that: four adapters (Gemini, Anthropic, OpenAI, Ollama) emit real token counts and the daemon must convert counts into real USD micros so the cost-parity gate against OpenClaw (harness ≤ 110% of baseline) is meaningful.

The conversion is a lookup, not arithmetic the adapter should hard-code: provider rates change, models proliferate, and the same `(provider, model)` pair is referenced from multiple call sites (live daemon, replay tooling, dashboard). One catalog, one lookup function, four providers, including Ollama as a uniform zero-cost entry.

## Decision

### S1 — Package location: `@murmurations-ai/llm/pricing` subpath

The catalog ships as a subpath of the existing `@murmurations-ai/llm` package — `packages/llm/src/pricing/{catalog,resolve,errors}.ts` — surfaced via `package.json` `"exports"` as `"./pricing"`. **No new workspace package.**

Rationale: only the LLM adapter layer consumes it. A new workspace package adds `package.json` + tsconfig + build + release overhead for one file of data and one of logic. Co-locating with the adapters keeps the invariant "add a model, add its rate" local. If a second consumer ever appears, subpath → package promotion is a mechanical refactor.

### S2 — Schema shape

```ts
export type ProviderId = "gemini" | "anthropic" | "openai" | "ollama";

export interface ProviderRate {
  readonly provider: ProviderId;
  readonly model: string; // canonical id
  readonly tier: ModelTier; // "fast" | "balanced" | "deep"
  readonly inputUSDMicrosPerMillionTokens: number;
  readonly outputUSDMicrosPerMillionTokens: number;
  readonly cacheReadUSDMicrosPerMillionTokens?: number;
  readonly cacheWriteUSDMicrosPerMillionTokens?: number;
  readonly maxContextTokens: number;
  readonly source: string; // URL citation or PLACEHOLDER marker
  readonly effectiveFrom: string; // ISO "YYYY-MM-DD"
}
```

**Unit choice — micros per million tokens.** Provider docs publish per-million. Integer micros per million sidesteps floating-point: `(tokens * ratePerMillion) / 1_000_000` is exact integer math. Per-1K thinking stays mental; per-1M is the review unit.

**`tier` is required** so the catalog can answer both "which model for `balanced` on Gemini?" and "what does this exact model cost?".

**`cacheRead/cacheWrite` are optional** because providers bill caching differently (Anthropic explicit, OpenAI explicit at 50% of input, Gemini not separately billed today, Ollama local).

### S3 — Ollama: real entries, not a code-path special case

Ollama models live in the catalog with zero rates. One generic entry (`model: "ollama-local"`) plus optional explicit entries per concrete Ollama model. The lookup function is uniform: `resolveLLMCost({ provider: "ollama", ... })` returns `Ok(USDMicros(0))` via the same code path that returns Gemini's rate.

Rationale: `if (provider === "ollama") return Ok(0)` in the resolver is a special-case lane one bug away from drifting. Uniform data wins. A future paid Ollama Cloud tier would be a catalog edit.

### S4 — Lookup function

```ts
export type PricingCatalogErrorCode =
  | "unknown-provider"
  | "unknown-model"
  | "negative-tokens"
  | "internal";

export interface PricingCatalogError {
  readonly kind: "pricing-catalog-error";
  readonly code: PricingCatalogErrorCode;
  readonly message: string;
  readonly provider?: ProviderId;
  readonly model?: string;
}

export const resolveLLMCost = (input: {
  readonly provider: ProviderId;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly asOf?: Date;
}): Result<USDMicros, PricingCatalogError>;
```

**Errors-as-values per ADR-0005.** An unknown `(provider, model)` pair is a recoverable runtime condition — a role frontmatter typo, or a provider rolling out a new model before the catalog PR lands. The daemon surfaces this as a structured warning to Performance #27's dashboard, continues running with `costMicros: 0` plus a `costEstimateMissing: true` flag on the wake record (tracked as a carry-forward ADR-0011 amendment). Throwing would crash a wake on a recoverable condition.

### S5 — Seed catalog entries (honest about uncertainty)

Six paid entries + one Ollama sentinel. **Every paid rate is marked PLACEHOLDER** — I am not inventing numbers. The 2B6 gate test flips Gemini by spot-checking a live call against the AI Studio console within 5%. Anthropic and OpenAI placeholders are flipped via a separate Source spot check before Phase 3.

Seed coverage:

- `gemini-2.5-flash` (tier: fast) — `~$0.30/M` input, `~$2.50/M` output — PLACEHOLDER
- `gemini-2.5-pro` (tier: balanced) — `~$1.25/M` input, `~$10/M` output — PLACEHOLDER
- `claude-sonnet-4-5` (tier: balanced) — `~$3/M` input, `~$15/M` output, cache read `~0.1×`, cache write `~1.25×` — PLACEHOLDER
- `claude-opus-4-6` (tier: deep) — `~$15/M` input, `~$75/M` output — PLACEHOLDER
- `gpt-4o` (tier: balanced) — `~$2.50/M` input, `~$10/M` output, cache read `50%` of input — PLACEHOLDER
- `gpt-4o-mini` (tier: fast) — `~$0.15/M` input, `~$0.60/M` output — PLACEHOLDER
- `ollama-local` — zero rates, 131_072 context — sentinel

Every `source: "PLACEHOLDER — verify before Phase 2 gate"` is a TODO that 2B6 (Gemini) and a follow-up issue (Anthropic + OpenAI) resolve before Phase 3.

### S6 — Integration with `WakeCostBuilder.addLlmTokens`: not a breaking change

`addLlmTokens` already accepts `costMicros: USDMicros` from the caller. This ADR does not change that signature. What changes is _who_ computes the value: Phase 1B-c's stub passes `ZERO_USD_MICROS`; Phase 2's adapter calls `resolveLLMCost(...)` first and passes the resolved value (or zero with a warning on catalog miss).

**Confirmed: no `WakeCostBuilder` interface change.** ADR-0011's design holds.

### S7 — Lookup happens inside the LLM adapter

The adapter owns resolution. After receiving the provider response and reading token counts, the adapter calls `resolveLLMCost(...)` and then calls the caller-provided cost hook with a fully resolved `USDMicros`.

Rationale:

- The adapter already knows `(provider, model)`. The daemon does not — and pushing resolution into the daemon leaks the four-provider taxonomy across the abstraction boundary ADR-0014's four-adapter mandate exists to enforce.
- The cost hook's payload becomes self-contained: the daemon reading it sees a complete, post-resolution row.
- Failed resolution is the adapter's to surface — the adapter knows whether the model name was a frontmatter typo or a genuinely new release.

This commits ADR-0014's cost hook to pass fully resolved values; the ADR-0014 `LLMCostHook` does not include a `costMicros` field because the adapter's cost hook wrapper (`makeDaemonHook` in the daemon boot) inserts it. ADR-0014 and ADR-0015 agree on this seam.

### S8 — Drift detection

Three layers:

1. **2B6 spot check (already in PHASE-2-PLAN.md).** First live Gemini wake → re-run cost through catalog → must match AI Studio console within 5%. Strictest check with real ground truth.
2. **Quarterly manual review.** Performance #27 calendar reminder; walk each catalog row, open each `source` URL, confirm each rate. ~30 min/quarter. Scales without code.
3. **Catalog-edit PR template checklist.** Any PR that touches `catalog.ts` requires: (a) provider pricing page link, (b) verification date, (c) previous value if changing existing entry, (d) `effectiveFrom` update.

Automated provider-doc scraping explicitly rejected — different formats, brittle, false alarms erode trust.

### S9 — Versioning: ship `effectiveFrom`, defer `asOf` to Phase 3

Each entry carries `effectiveFrom: string`. Updates ship as **new entries with a later `effectiveFrom`**, not by mutating existing rows. Old rows stay so historical wake records reconstruct against their then-current rate.

The `asOf?: Date` resolver parameter **exists in the type signature in v0.1** but the v0.1 implementation ignores it and always uses the most-recent entry per `(provider, model)`. Phase 3 wires `asOf` to "find the latest `effectiveFrom` ≤ `asOf`". A `it.skip("resolves asOf parameter against historical entries")` tripwire test lives in the spec list now — enable when the second row per `(provider, model)` appears.

Rationale: the parameter exists now so consumers opt in without a signature change later. Implementing the time-bound lookup is ~15 lines but requires multi-row fixtures that don't unblock the Phase 2 cost-parity gate.

### S10 — Cache semantics

Optional `cacheRead/cacheWrite` fields populated per provider:

- **Anthropic**: populate both (cache read ≈ 0.1× input, cache write ≈ 1.25× input)
- **OpenAI**: populate cache read at 50% of input; no separate cache write billing
- **Gemini**: leave both unset (not separately billed in the public API)
- **Ollama**: unset (local cache is free)

Resolver formula:

```
cost = (inputTokens × inputRate
       + outputTokens × outputRate
       + (cacheReadTokens ?? 0) × (cacheReadRate ?? inputRate)
       + (cacheWriteTokens ?? 0) × (cacheWriteRate ?? inputRate)
       ) / 1_000_000
```

**Fallback to `inputRate` when a cache rate is unset is the safe default** — slightly over-counts (Anthropic cache read is cheaper, OpenAI cache read is half) but never under-counts. Accurate over-counting is preferred to silent under-counting for the cost-parity gate.

## Tests (2B5 — Vitest specs)

~12 specs covering: Gemini happy path with hand-verified micros, unknown-provider / unknown-model / negative-tokens error codes, Ollama uniform zero path, Anthropic cache-read discount, hand computation of mixed large wake, seed-entry shape validation, `it.skip` tripwire for `asOf` historical replay.

## Out of scope for Phase 2B

- Automated drift detection against provider APIs
- Non-USD currencies / regional pricing variation
- Batch API pricing (separate ~50% discount model)
- Fine-tuned model pricing
- Historical price charts / analytics
- Per-tier model auto-selection (`resolveModelForTier`) — `tier` field exists but the helper does not
- Live `asOf` historical replay (deferred per S9)

## Carry-forwards

1. **Catalog placeholder rates** — 6 of 7 entries are PLACEHOLDER. 2B6 covers Gemini; Anthropic + OpenAI need a separate Source spot check before Phase 3. Owner: Performance #27.
2. **`costEstimateMissing` flag on `WakeCostRecord`** — amendment to ADR-0011 so the dashboard distinguishes real-zero (Ollama) from unknown-zero (catalog miss). Co-owned Performance #27 + TypeScript #24.
3. **Per-attempt cost hook granularity** — folds into CF-github-A / CF-llm-A lineage.
4. **Quarterly catalog review** — calendar discipline, Performance #27.
5. **Promotion to standalone package** — tripwire; no action until a second consumer exists.
6. **Anthropic cache ratio precision** — tighten rates against published tables if Phase 2 cost-parity is sensitive.

## Consequences

### Positive

- Phase 2 cost-parity gate becomes a real measurement.
- Four-provider from day one; Ollama is uniform, no special-case branching.
- Errors-as-values means frontmatter typos are structured warnings, not crashes.
- ADR-0011's frozen schema is honored.
- Single source of truth for daemon, dashboard, and any future replay tooling.

### Negative

- 6 of 7 seed rates are PLACEHOLDER until 2B6 + follow-up. Honest but provisional.
- Quarterly manual review depends on discipline.
- `asOf` deferral means multi-row catalogs silently use latest entry until Phase 3. Mitigated by tripwire test.
- Fallback-to-input-rate over-counts cost slightly. Accepted as safer default.

### Reversibility

Medium. Schema / error codes / lookup signature are public API of the LLM package; changes are ADR amendments. Catalog _contents_ are freely editable — the whole point.

## Alternatives considered

- **Standalone `@murmurations-ai/pricing` package** — rejected per S1, overhead with no second consumer.
- **Resolver throws on unknown model** — rejected, crashes wakes on recoverable conditions.
- **Hard-code rates in each adapter** — rejected, forces a code change per price update, obscures the catalog as a reviewable asset.
- **Lookup in the daemon, not the adapter** — rejected per S7.
- **Branch on `provider === "ollama"` for zero cost** — rejected per S3.
- **Per-1K-token unit instead of per-1M** — rejected, providers publish per-1M.
- **Multi-currency** — rejected as out of scope.

---

_Show me the number. Measure before you decide. Document the baseline. Track the tail._
_— Performance / Observability Agent #27_
