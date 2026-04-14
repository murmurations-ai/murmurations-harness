# Phase 2 Implementation Plan — Murmuration Harness

**Status:** Active
**Authored:** 2026-04-09 (Engineering Lead #22, Engineering Circle Phase 0 mode)
**Spec reference:** [`MURMURATION-HARNESS-SPEC.md`](https://github.com/xeeban/emergent-praxis/blob/main/docs/MURMURATION-HARNESS-SPEC.md) §15 Phase 2
**Sibling doc:** [`PHASE-1-PLAN.md`](./PHASE-1-PLAN.md)
**Circle:** Engineering Circle (ratified via Issues #240, #241)
**Predecessor gate:** harness#7 — Phase 1B → Phase 2 CONDITIONAL-GO
**Load-bearing foundation:** ADR-0010 (secrets), ADR-0011 (cost record), ADR-0012 (github client), ADR-0013 (signal aggregator)

---

## Phase 2 Definition (from spec §15)

> **Phase 2 — One-agent end-to-end proof**
>
> - Pick one EP agent (candidate: Research Agent #1 — lightest coupling, clear output)
> - Port its role to the new identity+frontmatter format
> - Run it on the harness daemon in parallel with OpenClaw for one week
> - Dual-run: both produce output, compare, confirm no drops
> - **Gate:** the one-agent run produces the same weekly digest the OpenClaw version does, at equal or lower cost, with no human intervention

---

## Multi-provider LLM mandate (Source direction, 2026-04-09)

Phase 2's LLM client is **explicitly multi-provider**. Four first-class adapters ship in 2A:

| Provider          | Role in Phase 2                                                                                                                       | Priority |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| **Google Gemini** | **Primary Phase 2 test provider** — Source has an active Gemini API key; all live smoke tests and the first dual-run week use Gemini. | P0       |
| **Anthropic**     | Cross-provider validation + fallback. Used to confirm adapter interface is not Gemini-shaped.                                         | P1       |
| **OpenAI**        | Cross-provider validation. Same reason.                                                                                               | P1       |
| **Ollama**        | Local/free dev path + cost=$0 CI path. Enables tests that exercise the real wake pipeline without burning tokens.                     | P1       |

**Rationale for the four-provider scope up front (not incrementally):**

1. **Interface hardening.** Implementing only one adapter in 2A means the `LLMClient` interface is Anthropic-shaped by accident. Four simultaneous adapters force the interface to actually be provider-agnostic, which is the whole point of having the abstraction.
2. **Gemini-first practicality.** The only live key Nori has is Gemini. Shipping without Gemini support means Phase 2 cannot run in the real environment.
3. **Ollama-as-free-smoke.** Running CI and local dev against Ollama means the Phase 2 end-to-end flow is exercised without any cost at all. This is the same posture that let Phase 1 ship with the "subprocess-only, no LLM" hello-world — now we upgrade to "local LLM, no cost".
4. **OpenAI + Anthropic hedge.** Cross-provider validation is the cheapest insurance against the Gemini-specific idiosyncrasies biting us only during the live dual-run week, when the cost of debugging is highest.

This plan is built on the assumption that Research Agent #1 is the portable candidate. Risk §R4 covers the fallback if that assumption breaks.

---

## Pre-Phase-2 work (blocking prerequisites)

| #   | Item                                                                                                                                                                            | Owner                                                   | Blocks                  | Scope          | Kind   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------- | -------------- | ------ |
| P1  | `@murmurations-ai/llm` package **design ADR** — provider interface, four-adapter shape, cost hook seam, retry/rate-limit surface, `SecretValue` auth                            | TypeScript #24 authors, Architecture #23 consults       | 2A implementation start | Single session | Design |
| P2  | **Per-provider pricing catalog ADR** — schema for Anthropic, OpenAI, Gemini entries + Ollama-as-zero-cost-sentinel; load path; versioning                                       | Performance #27 authors, TypeScript #24 reviews types   | 2B implementation start | Single session | Design |
| P3  | Agent role template beyond hello-world — `role.md` frontmatter extension: LLM provider/model pin, `githubScopes`, wake schedule, signal subscriptions, prompt file ref          | Architecture #23 authors, Security #25 reviews          | 2C implementation start | Single session | Design |
| P4  | **harness#8 — subprocess env var scrub** — Security #25 authoring in parallel to this plan; must be merged before any 2A integration boots a real LLM client in a child process | Security #25                                            | 2D integration boot     | Single commit  | Impl   |
| P5  | **harness#16 — GitHub mutation surface** (issue create/comment, commit-on-branch, label set) — Research Agent writes its digest via GitHub mutation                             | TypeScript #24 + DevOps #26, Security #25 reviews scope | 2C role semantics, 2D   | Multi-session  | Both   |

P1, P2, P3 are pure design tasks and can run in parallel. P4 is nearly done. P5 is the only multi-session build and is on the critical path.

---

## Phase 2A — `@murmurations-ai/llm` package (four-adapter)

The LLM client package. Ships four adapters concurrently. This is the single largest new package in Phase 2.

| Step | Deliverable                                                                                                                                                                                                                                                                                                                                                   | Owner                                       | Blocks  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------- |
| 2A1  | Ratify P1 design ADR (becomes ADR-0014)                                                                                                                                                                                                                                                                                                                       | TypeScript #24 → Engineering Lead #22 gates | 2A2     |
| 2A2  | `packages/llm/` scaffold — `LLMClient` interface, `LLMRequest` / `LLMResponse` branded types, error taxonomy as Result values (ADR-0005), shared retry/rate-limit module                                                                                                                                                                                      | TypeScript #24                              | 2A3-2A6 |
| 2A3  | **`GeminiAdapter`** — Google Generative AI `generateContent` API; model tier resolution (Gemini 2.x Flash for `fast`, Gemini 2.x Pro for `balanced`/`deep`); streaming off for Phase 2. **P0 adapter.**                                                                                                                                                       | DevOps #26 impl, Architecture #23 topology  | 2A7     |
| 2A4  | `AnthropicAdapter` — Messages API; Sonnet 4.5 (`fast`/`balanced`), Opus 4.6 (`deep`); streaming off                                                                                                                                                                                                                                                           | DevOps #26                                  | 2A7     |
| 2A5  | `OpenAIAdapter` — Chat Completions API; GPT-4o (`fast`/`balanced`), GPT-4 class (`deep`)                                                                                                                                                                                                                                                                      | DevOps #26                                  | 2A7     |
| 2A6  | **`OllamaAdapter`** — HTTP client against a local Ollama daemon (`http://localhost:11434/api/generate`); model pin configurable; no auth (localhost only); cost = 0                                                                                                                                                                                           | DevOps #26                                  | 2A7     |
| 2A7  | **Cost hook integration** — every LLM call emits a `WakeCostRecord.llm` entry per ADR-0011 populated by 2B catalog lookup. Input tokens, output tokens, cost micros. Ollama calls emit `costMicros: 0`.                                                                                                                                                       | Performance #27 + TypeScript #24            | 2B, 2D  |
| 2A8  | **Auth via `SecretValue`** — `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` loaded through `DotenvSecretsProvider` (ADR-0010); Ollama needs no key. Unit tests assert redaction across all three paid providers.                                                                                                                                     | Security #25 gates                          | 2D      |
| 2A9  | Retry + rate-limit — exponential backoff on 429/5xx, max 3 attempts, per-provider retry-after header parsing, budget-aware (CF-github-D follow-up applies to LLM too)                                                                                                                                                                                         | DevOps #26                                  | 2D      |
| 2A10 | Tests — adapter unit tests against recorded fixtures for all four providers + one live smoke test per adapter behind `LIVE=1` env gate                                                                                                                                                                                                                        | TypeScript #24                              | 2A11    |
| 2A11 | **Gate test:** `pnpm --filter @murmurations-ai/llm test` green; `pnpm build` green; **live smoke call via Gemini** returns a response and emits a cost record with non-zero `costMicros`; live smoke call via Ollama returns a response and emits `costMicros: 0`; live calls via Anthropic + OpenAI deferred to Source's discretion (no active key required) | Engineering Lead #22                        | 2B      |

**Exit criteria:** Package exists, builds, tests pass, **Gemini live smoke call succeeds**, **Ollama live smoke call succeeds**, Anthropic + OpenAI adapters compile and pass fixture tests, cost records populate (non-zero for Gemini, zero for Ollama). No secret leakage in logs. No Phase 2 code yet depends on it outside the package itself.

### Provider-agnostic interface contract (must hold in 2A2)

The `LLMClient` interface is the boundary. Adapter swap at construction time must be a one-liner:

```ts
// Phase 2 CLI boot — provider selected from env or frontmatter
const llm = createLLMClient({
  provider: "gemini", // or "anthropic" | "openai" | "ollama"
  token: provider === "ollama" ? null : secrets.get(providerKey),
  model: resolvedModel,
  costHook: builder.addLlmTokens.bind(builder),
});
```

Four-adapter shipping in parallel is the only way to prove this boundary is real.

---

## Phase 2B — Pricing catalog (four-provider)

The catalog that turns token counts into dollars. Load-bearing for the cost-parity gate.

| Step | Deliverable                                                                                                                                                                                                              | Owner                                        | Blocks |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- | ------ |
| 2B1  | Ratify P2 schema ADR (becomes ADR-0015)                                                                                                                                                                                  | Performance #27 → Engineering Lead #22 gates | 2B2    |
| 2B2  | `packages/llm/pricing/catalog.ts` — typed catalog with published per-million-token rates as USD micros; `OllamaProviderRate` is a sentinel zero entry                                                                    | Performance #27 + TypeScript #24             | 2B3    |
| 2B3  | Seed entries: **Gemini 2.x Flash, Gemini 2.x Pro**, Anthropic Sonnet 4.5, Anthropic Opus 4.6, OpenAI GPT-4o, OpenAI GPT-4 class. Source URLs in code comments. Ollama = zero (sentinel).                                 | Performance #27                              | 2B4    |
| 2B4  | Integration with 2A7 cost hook — `WakeCostBuilder` resolves `(provider, model) → USDMicros` at record-emit time; Ollama records `modelProvider: "ollama"` and `costMicros: 0`                                            | Performance #27 + TypeScript #24             | 2D     |
| 2B5  | Tests — unit test per provider×model entry, integration test showing a fake 1K-input/500-output wake computes the expected USD micros for each paid provider, and zero for Ollama                                        | TypeScript #24                               | 2B6    |
| 2B6  | **Gate test:** A wake record emitted from the live Gemini call in 2A11 is re-run through the catalog and produces a `costMicros` value within 5% of the number quoted by the Google AI Studio console for the same call. | Engineering Lead #22 + Performance #27       | 2C     |

**Exit criteria:** Catalog populated for all four providers (real rates for paid; sentinel for Ollama), cost records carry real micros, catalog has a source-of-truth citation for each paid rate, drift ≤ 5% on spot check against Gemini console.

---

## Phase 2C — Research Agent #1 identity port

The actual EP agent port. Where the harness meets the murmuration.

| Step | Deliverable                                                                                                                                                                                                                                                                                           | Owner                                                 | Blocks |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------ |
| 2C1  | Ratify P3 role template ADR (becomes ADR-0016)                                                                                                                                                                                                                                                        | Architecture #23 → Engineering Lead #22 gates         | 2C2    |
| 2C2  | `agents/01-research/soul.md` — ported from EP governance layer                                                                                                                                                                                                                                        | Architecture #23 + Source                             | 2C3    |
| 2C3  | `agents/01-research/role.md` with full frontmatter: `name`, `provider: "gemini"` (Phase 2 baseline — swappable), `model_tier: "balanced"`, `schedule` (weekly cron), `signals` config, `githubScopes` (read issues/commits, write one digest path), `promptRef`                                       | TypeScript #24 (frontmatter types) + Architecture #23 | 2C4    |
| 2C4  | `agents/01-research/prompts/wake.md` — the real research wake prompt. Mirrors the OpenClaw Research Agent wake prompt 1:1 for fair comparison                                                                                                                                                         | Source + Architecture #23                             | 2C5    |
| 2C5  | Identity loader integration — confirm 1B-b identity loader reads the new frontmatter; extend schema if needed to support `provider` + `model_tier`                                                                                                                                                    | TypeScript #24                                        | 2C6    |
| 2C6  | Dry-run on Gemini — spawn Research Agent via CLI in `--dry-run` mode (no GitHub mutation), print digest to stdout, inspect by hand                                                                                                                                                                    | Engineering Lead #22 + Source                         | 2C7    |
| 2C7  | Dry-run on Ollama — same wake, Ollama provider, free cost. Proves the provider swap actually works at the role level.                                                                                                                                                                                 | Engineering Lead #22 + Source                         | 2D     |
| 2C8  | **Gate test:** Gemini dry-run produces a digest Source judges structurally equivalent to an OpenClaw Research Agent digest on the same signal set; Ollama dry-run produces a digest of reasonable shape (not necessarily equivalent; Ollama models are smaller). Judgment recorded on the gate issue. | Engineering Lead #22                                  | 2D     |

**Exit criteria:** Research Agent #1 identity ratified, `role.md` validates, Gemini dry-run judged equivalent at least once, Ollama dry-run proves provider swap. Gemini remains the Phase 2 dual-run provider.

---

## Phase 2D — CLI compose + dual-run setup

Wiring. All the parts exist; this phase glues them together.

| Step | Deliverable                                                                                                                                                                                                                                                                       | Owner                               | Blocks |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------ |
| 2D1  | Confirm P4 (harness#8 env var scrub) merged and verified in CI                                                                                                                                                                                                                    | Security #25 + Engineering Lead #22 | 2D2    |
| 2D2  | Confirm P5 (harness#16 mutation surface) merged with test coverage on issue comment + branch commit paths                                                                                                                                                                         | TypeScript #24 + DevOps #26         | 2D3    |
| 2D3  | CLI boot wiring — `packages/cli/src/boot.ts` instantiates `DotenvSecretsProvider` + `GithubClient` + `DefaultSignalAggregator` + `LLMClient` (provider resolved from role frontmatter) + `PricingCatalog` (extends `38846bb`)                                                     | DevOps #26 + Engineering Lead #22   | 2D4    |
| 2D4  | Scheduler registration — Research Agent #1 on weekly cron (Sunday 18:00 local; configurable)                                                                                                                                                                                      | Architecture #23                    | 2D5    |
| 2D5  | **Output capture** — every harness Research wake writes its digest to `.murmuration/runs/research/{YYYY-MM-DD}/digest.md`, appends a structured summary to `.murmuration/runs/research/index.jsonl` including provider + model                                                    | DevOps #26                          | 2D6    |
| 2D6  | **Structured diff tool** — `scripts/dual-run-diff.mjs` consumes (harness digest path, OpenClaw digest path) and emits JSON: (a) item-set diff, (b) normalized-text similarity, (c) cost delta in micros, (d) wall-clock delta. Thresholds: item-set drift ≤ 10%, cost delta ≤ 10% | TypeScript #24 + Performance #27    | 2D7    |
| 2D7  | OpenClaw parallel — confirm existing OpenClaw Research Agent cron still running; no modifications                                                                                                                                                                                 | Source (operational)                | 2E     |
| 2D8  | **Gate test:** A single manually-triggered harness Research wake on Gemini produces a digest file, emits a non-zero cost record, and the diff tool runs successfully against yesterday's OpenClaw digest. Output: a diff report.                                                  | Engineering Lead #22                | 2E     |

**Exit criteria:** End-to-end path compiled, one manual wake end-to-end on Gemini, diff tool runs, both runners pointing at the same signal set.

---

### **STOP POINT — between 2D and 2E**

At the close of 2D, Source + Claude Code **pauses** and waits for explicit direction to start the dual-run week. This is the most expensive segment of Phase 2 and the first one where real cost accumulates. Engineering Lead #22 and Source must both approve. Analogous to the 1A → 1B and 1B-d → 1B-e stop points in PHASE-1-PLAN.

---

## Phase 2E — Dual-run week + gate review

One calendar week of parallel operation, instrumentation collection, Phase 2 gate decision. **Primary provider: Gemini.**

| Step | Deliverable                                                                                                                                                                        | Owner                                  | Blocks  |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------- |
| 2E1  | Week 0 wake (Sunday T+0) — both runners fire (harness on Gemini, OpenClaw on its existing provider), diff report filed to the gate issue                                           | Engineering Lead #22 observes          | 2E2     |
| 2E2  | Mid-week health check (Wednesday T+3) — no incidents, cost burn on track, no human interventions logged                                                                            | Engineering Lead #22 + Performance #27 | 2E3     |
| 2E3  | Week 1 wake (Sunday T+7) — second full weekly digest, diff report filed                                                                                                            | Engineering Lead #22                   | 2E4     |
| 2E4  | Aggregate cost parity measurement — harness total cost (Gemini) vs OpenClaw total cost, USD micros, per-wake breakdown                                                             | Performance #27                        | 2E5     |
| 2E5  | Output equivalence report — diff tool scores + Source's qualitative judgment                                                                                                       | Engineering Lead #22 + Source          | 2E6     |
| 2E6  | Incident log — every manual intervention, rate-limit hit, retry, stalled wake                                                                                                      | Engineering Lead #22                   | 2E7     |
| 2E7  | **Optional cross-provider spot check** — re-run one week's wake through Anthropic or OpenAI to verify the harness output is not Gemini-shaped by accident. Spot check, not a gate. | Engineering Lead #22 (optional)        | 2E8     |
| 2E8  | Phase 2 retro — circle-wide review, carry-forwards filed, risks updated                                                                                                            | Engineering Lead #22 facilitates       | 2E9     |
| 2E9  | **GATE REVIEW** — Engineering Lead #22 writes Phase 2 → Phase 3 gate review. GO / CONDITIONAL-GO / NO-GO.                                                                          | Engineering Lead #22                   | Phase 3 |

**Exit criteria:** At least 1 harness weekly digest (target: 2) on Gemini, cost parity measured, output diff scored, zero human interventions, gate written.

---

## Phase 2 exit criteria (checklist)

- [ ] `@murmurations-ai/llm` exists with **four adapters** (Gemini, Anthropic, OpenAI, Ollama), builds, tests pass
- [ ] **Live Gemini smoke call succeeds** in 2A11
- [ ] **Live Ollama smoke call succeeds** in 2A11
- [ ] Pricing catalog populated for all four providers (real rates paid; zero sentinel Ollama); Gemini drift ≤5% vs AI Studio console
- [ ] `WakeCostRecord.llm.costMicros` populates with real values on every harness wake
- [ ] Research Agent #1 `soul.md` + `role.md` + `prompts/wake.md` ratified
- [ ] Provider swap demonstrated — dry-run works on both Gemini and Ollama from the same role definition
- [ ] Dual-run produced ≥1 weekly digest over ≥7 days on Gemini (target: 2)
- [ ] **Cost parity:** harness total USD micros ≤ 110% of OpenClaw baseline
- [ ] **Item-set drift ≤ 10%** on diff tool per weekly digest
- [ ] Source's qualitative judgment: structurally equivalent
- [ ] **Zero human interventions** during the week
- [ ] CI remains green throughout
- [ ] P4 (env scrub) and P5 (mutation surface) merged and under test
- [ ] ADRs 0014 (llm), 0015 (pricing), 0016 (role template) committed
- [ ] Engineering Lead #22 signs off on Phase 2 → Phase 3 gate

---

## Dependency graph

```
 P1 (llm ADR)   P2 (pricing ADR)   P3 (role template ADR)   P4 (#8 env scrub)   P5 (#16 mutations)
      ↓                ↓                     ↓                     ↓                   ↓
 2A1 ──┐         2B1 ──┐              2C1 ──┐               (merged)             (merged)
      ↓                ↓                    ↓                                         ↓
 2A2 (interface + shared retry module)                                                 │
      ↓                                                                                │
 2A3 (Gemini) │ 2A4 (Anthropic) │ 2A5 (OpenAI) │ 2A6 (Ollama)  ← four adapters in parallel
      ↓       ↓       ↓       ↓                                                        │
 2A7 (cost hook) ←── 2B2 → 2B3 → 2B4 → 2B5 → 2B6                                       │
      ↓                                                                                │
 2A8 (SecretValue auth, three keys)                                                    │
      ↓                                                                                │
 2A9 (retry/rate-limit, per-provider)                                                  │
      ↓                                                                                │
 2A10 → 2A11 (gate: Gemini live + Ollama live)                                         │
      ↓                                                                                │
 ───── 2A gate met ─────                                                               │
      ↓                                                                                │
 ───── 2B gate met (Gemini spot check ≤5% drift) ─────                                 │
      ↓                                                                                │
 2C2 → 2C3 → 2C4 → 2C5 → 2C6 (Gemini dry-run) → 2C7 (Ollama dry-run) → 2C8 (gate)     │
      ↓                                                                                │
 ───── 2C gate met ─────                                                               │
      ↓                                                                                │
 2D1 (verify P4) → 2D2 (verify P5) ←───────────────────────────────────────────────────┘
      ↓
 2D3 (CLI boot) → 2D4 (cron) → 2D5 (output capture) → 2D6 (diff tool) → 2D7 (OpenClaw) → 2D8 (gate)
      ↓
 ─── STOP POINT: Source + Engineering Lead #22 approval ───
      ↓
 2E1 → 2E2 → 2E3 → 2E4 → 2E5 → 2E6 → 2E7 (optional cross-provider) → 2E8 → 2E9 (GATE)
      ↓
 ───── Phase 2 Complete ─────
```

---

## Execution approach

Per the ratified builder model (spec §14, Engineering Circle doc §3):
**Source + Claude Code is the builder. The Engineering Circle reviews, designs, and gates.**

Load-bearing foundation — Phase 2 assumes as given:

- **ADR-0010** (secrets) — LLM auth flows through `SecretValue`; no raw env reads in any of the four adapters.
- **ADR-0011** (cost record) — `WakeCostRecord.llm` is the only LLM cost emission channel; 2A7 and 2B4 conform for all four providers.
- **ADR-0012** (github client) — all Research Agent reads and writes go through `GithubClient`.
- **ADR-0013** (signal aggregator) — the Research Agent consumes signals from `DefaultSignalAggregator`; dual-run fairness rests on both runners seeing the same signal set.

### Specialist involvement per sub-phase

- **2A** — TypeScript #24 (interface), Architecture #23 (topology), DevOps #26 (four adapters), Security #25 (auth gate, three paid keys), Performance #27 (cost hook)
- **2B** — Performance #27 (catalog), TypeScript #24 (types)
- **2C** — Architecture #23 (role template), Source (prompt authorship), TypeScript #24 (frontmatter schema)
- **2D** — DevOps #26 (wiring + output capture), TypeScript #24 (diff tool), Security #25 (scope enforcement review)
- **2E** — Engineering Lead #22 (facilitation + gate), Performance #27 (cost), Source (qualitative judgment)

### Engineering Lead gate reviews

1. **2A → 2B** — llm package green, Gemini + Ollama live smoke
2. **2B → 2C** — pricing catalog, Gemini drift ≤ 5%
3. **2C → 2D** — Gemini dry-run judged equivalent, Ollama dry-run proves provider swap
4. **2D → 2E** — wiring + diff tool proven on one manual wake (**stop point**)
5. **2E → Phase 3** — the Phase 2 exit gate

---

## Risks flagged ahead of time

### Risk 1 — LLM API outage during dual-run week

A multi-hour Gemini outage during the week could cause the harness Research wake to fail and the dual-run to record a false NO-GO. **Mitigation:** 2A9 retry logic; 2E6 incident log distinguishes "harness fault" from "upstream fault"; Engineering Lead #22 has discretion to extend the dual-run window up to +7 days if upstream faults dominate. Because the harness has four adapters, a **provider swap during a true upstream outage is a configuration change, not a code change** — Source can flip the role's `provider` field from `gemini` to `anthropic` or `openai` and resume. However, swapping providers mid-run invalidates the equivalence test for that week; Engineering Lead #22 decides whether the swap restarts the week or continues.

### Risk 2 — Cost overrun vs OpenClaw baseline

10% ceiling on Gemini Phase 2 pricing is defensible but not guaranteed. **Mitigation:** Performance #27 produces a pre-flight estimate after 2B6 using the first manual Gemini wake. If projected overrun > 15%, stop and re-scope before 2E1. Per-wake budget cap enforced via the daemon (ADR-0011 budget gate).

### Risk 3 — Output drift not caught by diff tool

Jaccard / cosine similarity can miss semantic drift. **Mitigation:** 2E5 requires Source's qualitative judgment in addition to the diff tool. Both must pass.

### Risk 4 — Research Agent #1 too coupled

Spec §15 names Research #1 as "lightest coupling" but the OpenClaw wiring may have hidden assumptions. **Mitigation:** 2C6 dry-run on Gemini is the discovery checkpoint. If not clean by 2C8, pause and escalate. Candidate switches: **Analytics #6** (second-lightest coupling) or **Chronicler #21** (pure-write, no signal coupling).

### Risk 5 — Dual-run infrastructure bug produces false failure

A bug in output capture or diff tool could report drift that isn't real. **Mitigation:** 2D8 gate test exercises the full diff pipeline on a known pair before 2E. 2E1 first diff is triple-checked.

### Risk 6 — Rate-limit exhaustion on shared token

The harness `GithubClient`, harness LLM calls, and OpenClaw may pull from the same credentials. **Mitigation:** Dedicated **GitHub PAT** (minimum scope from #16), dedicated **Gemini API key** for the harness — not shared with interactive Claude Code or any other tooling. Both keys named per `@murmurations-ai/secrets-dotenv` convention. Anthropic + OpenAI keys only needed for cross-provider spot checks; not required for Phase 2 if Source doesn't have them.

### Risk 7 — Carry-forward #4 (trust taxonomy) not ratified before Phase 2

Interim trust taxonomy still in place. **Mitigation:** Accept interim for Phase 2; log trust-boundary events in 2E6. Do not block Phase 2 start. Re-evaluate in Phase 3.

### Risk 8 — Provider API contract drift in Gemini

Google's Generative AI API has moved faster than Anthropic/OpenAI historically. A mid-week API version change could break the adapter. **Mitigation:** pin the Gemini API version explicitly in the adapter (`v1beta` or whatever is stable at 2A3 time); pin the underlying HTTP client dep; watch for Google deprecation notices; if breakage occurs mid-dual-run, use the provider swap hatch from Risk §R1.

### Risk 9 — Ollama model quality too low for equivalence judgment

Ollama models (Llama 3, Mistral, etc.) are smaller than Gemini Pro / Sonnet 4.5 / GPT-4. The 2C7 Ollama dry-run is a provider-swap proof, not an equivalence proof. **Mitigation:** 2C8 gate criteria for Ollama is "digest of reasonable shape", not "structurally equivalent". Only Gemini is judged for equivalence. Ollama's role is free dev loop + CI smoke, not production quality.

---

## Carry-forward integration

Categorization of the 16 open carry-forwards at harness#8-#23:

### Phase 2 blockers

- **#8 — CF-new-A: subprocess env var scrub** — Security #25 authoring in parallel (P4). **BLOCKER.**
- **#16 — CF-github-G: GitHub mutation surface** — Research Agent writes digest via GitHub (P5). **BLOCKER.**
- **#10 — CF-new-C: .gitignore preflight** — any operator init flow needs this; single commit, DevOps #26. **BLOCKER.**
- **#13 — CF-github-D: retry budget ↔ wake wall-clock** — 2A9 LLM retry needs the same discipline. **Folds into 2A9.**

### Phase 2 bites (pain if ignored)

- **#11 — CF-github-A: per-attempt cost hook granularity** — without this, LLM retry storms are invisible to the cost record. Address during 2A7.
- **#18 — CF-signals-B: inbox read-cursor** — without this, Research Agent re-reads same inbox every wake. Bites cost + drift. Address during 2C3.
- **#12 — CF-github-B: disk-backed ETag cache** — cold restart loses cache. Opportunistic.
- **#17 — CF-signals-A: replace interim trust taxonomy** — Risk §R7. Log-only in Phase 2.
- **#22 — CF-signals-F: inbox filename convention** — minor governance debt. Close during 2C.

### Defer to Phase 3+

#1, #2, #4, #9, #14, #15, #19, #20, #21, #23 — Phase 3 / 4 / 5+ per their original categorization.

---

## Stop points

Explicit points where Source + Claude Code pauses and waits for Nori's direction:

1. **After P1 + P2 + P3 ADRs ratified** — before any 2A code. Source confirms the three design ADRs.
2. **After 2A11 (llm gate)** — first live Gemini call + first real cost record. Source confirms numbers.
3. **After 2C8 (Gemini + Ollama dry-runs)** — before wiring cron. Source qualitatively judges the Gemini dry-run before committing to a week of parallel runs.
4. **Between 2D8 and 2E1** — **the big stop point.** Before the dual-run week starts. Source + Engineering Lead #22 both approve. This is where Phase 2 starts spending real Gemini tokens on an unattended loop.
5. **After 2E9 (gate review)** — before any Phase 3 work.

---

## Success signal

Phase 2 is done when all of the following are true on the same week:

- `pnpm --filter @murmurations-ai/cli run start` boots the daemon with four LLM adapters wired, Gemini selected per Research Agent #1 role, pricing catalog active
- Research Agent #1 fires on its weekly cron, pulls signals via `DefaultSignalAggregator`, calls **Gemini** via `@murmurations-ai/llm`, writes a digest, and posts it via the GitHub mutation surface (#16)
- Harness digest and OpenClaw digest for the same week score ≤ 10% item-set drift
- Harness weekly cost ≤ 110% of OpenClaw weekly cost in USD micros
- Source judges the two digests structurally equivalent
- Zero human interventions across the week
- CI green throughout
- Engineering Lead #22 signs off

Plus, as proof-of-portability (not strictly gate criteria but required by the four-provider mandate):

- The same Research Agent role definition can be run against Ollama locally and produces a digest of reasonable shape, proving the provider swap is a config change only
- Anthropic + OpenAI adapters compile, pass fixture tests, and will accept a live call if keys are provided

That is the spec §15 Phase 2 gate expressed operationally, extended with the Source-directed multi-provider mandate.

---

_This plan is a living document. Updates commit directly to this file. If the plan changes significantly, Engineering Lead #22 notes the change in the next retro. Phase 3 has its own plan; this document ends at the Phase 2 → Phase 3 gate._
