# ADR-0048 — Phase 4 scope lock for v0.8.0: ship outcome validation; defer behavioral hard-fail to 0.8.1

- **Status:** Proposed
- **Date:** 2026-05-11
- **Decision-maker(s):** Source (Nori), Engineering Circle
- **Consulted:** ADR-0047 (Execution Contracts); OpenClaw review 2026-05-08; Phase 4 implementation plan (Proposal 07 §Migration Plan)
- **Supersedes:** None
- **Gates:** v0.8.0 release tag; Phase 4 PR sequence (PR 2–6)

## Context

ADR-0047 defines a five-element execution contract with two sub-contracts (obligation, permission) and two validation surfaces (`validateOutcomes`, `validateBehavior`). The Phase 4 implementation plan in Proposal 07 §Migration laid out six PRs against a conservative cadence:

| PR  | Scope                                                                 | Soak after | Originally         |
| --- | --------------------------------------------------------------------- | ---------- | ------------------ |
| 1   | Zod schema for `contract:` block in `role.md`                         | 24h        | shipped 2026-05-11 |
| 2   | `assembleExecutionContract()` + `buildSpawnContext` wiring            | 24h        |                    |
| 3   | Contract-aware prompt (`requiredOutputs` summarized in system prompt) | 24h        |                    |
| 4   | `validateWake → validateOutcomes` refactor + obligation enforcement   | 48–72h     |                    |
| 5   | Dashboard surfaces `validationStatus` per wake                        | 24h        |                    |
| 6   | `validateBehavior` (tool-call narrative cross-check) → hard-fail      | 14d        |                    |

The original 22–28 day calendar was driven by two load-bearing soaks: a **48–72h** soak after PR 4 (the wake-outcome refactor) and a **14-day** soak before promoting `validateBehavior` from warning-only to hard-fail. Both periods were sized against OpenClaw's 2026-05-08 review feedback on PR cadence for cross-cutting changes that touch runtime correctness.

A faster ship is desirable to (a) deliver the contract layer to operators on a near-term cadence, (b) start the real-world acceptance clock on intelligence-agent's contract block sooner, and (c) ship outcome validation independently of behavioral validation so the latter can be designed against observed warning data rather than guessed thresholds.

The question is which safety properties are load-bearing for **shipping the contract layer** versus load-bearing for **promoting behavioral validation to hard-fail**, and whether those two events can be decoupled.

## Decision drivers

1. **Outcome validation is additive and reversible.** Each of PR 2–5 introduces new fields/functions/columns behind opt-in code paths until PR 4 turns on obligation enforcement. Rollback is `git revert`, not data migration.
2. **Behavioral validation is irreversible-feeling for operators.** A hard-fail on `validateBehavior` changes when a wake is recorded as `valid: false`. Once that fires in production, "is this a false positive or a real hallucination?" becomes a per-wake judgment call. Shipping it warning-only first lets us calibrate from real signal instead of synthetic.
3. **OpenClaw's 14-day soak targeted promotion-to-hard-fail, not the warning surface itself.** The warning surface (dashboard column + log line) was always considered safe to ship; the soak gates the ratchet to outcome enforcement.
4. **The 7-day acceptance criterion in ADR-0047 §17 measures contract uptime, not calendar elapsed.** What we are actually learning from is "does the Zod schema and `assembleExecutionContract` survive contact with real `role.md` blocks across daily wake cycles." Three clean wakes give that answer; seven do not give materially more.
5. **PR 3 and PR 5 are parallelizable.** PR 3 only reads the contract object (no dependence on receipts). PR 5 only depends on PR 4's data shape, which can be locked before the refactor lands. Sequential ordering was for review-load convenience, not correctness.

## Decision

**v0.8.0 ships outcome validation (`validateOutcomes`) wired end-to-end and behavioral validation (`validateBehavior`) in warning-only mode. Promotion of `validateBehavior` to hard-fail is deferred to v0.8.1.**

### 1. Scope IN for v0.8.0

- PR 1 — `contract:` Zod schema in `role.md` frontmatter (shipped 2026-05-11)
- PR 2 — `assembleExecutionContract()` + `buildSpawnContext` wiring
- PR 3 — Contract-aware system prompt (lists `requiredOutputs`, `actionItems`)
- PR 4 — `validateWake → validateOutcomes`; obligation enforcement counts toward `idleWakes`
- PR 5 — Dashboard surfaces `validationStatus` per wake
- PR 6a — `validateBehavior` implementation in **warning-only mode**: emits a `validation.behavior_warning` field on the wake record and a dashboard badge; does not affect `valid`/`successfulWakes`/`idleWakes`

### 2. Scope OUT for v0.8.0 (deferred to v0.8.1)

- PR 6b — Promote `validateBehavior` to hard-fail (a warning becomes a failed wake)
- 14-day composite-permission soak prior to promotion
- Threshold tuning for tool-call/narrative similarity (calibrated from PR 6a's warning data)

### 3. Compressed inter-PR soak periods

| Gate                   | Original           | v0.8.0 path                                               |
| ---------------------- | ------------------ | --------------------------------------------------------- |
| PR 1 → PR 2            | 24h                | 24h (unchanged — already running)                         |
| PR 2 → PR 3            | 24h                | parallel land                                             |
| PR 3 → PR 4            | 24h                | 12h                                                       |
| PR 4 → PR 5            | 24h                | parallel land                                             |
| PR 5 → 48h observation | 48–72h             | **48h kept** (PR 4 is the one that changes wake outcomes) |
| Observation → PR 6a    | —                  | 48h                                                       |
| PR 6a → v0.8.0 tag     | 14d hard-fail soak | **24h** (warning-only ships immediately)                  |

The single soak that remains at full length is the 48h observation window after PR 4+5 land. That window covers the only PR that changes outcome semantics. Every other compression is against PRs that are either additive or behind opt-in code paths.

### 4. Acceptance criterion

Replace ADR-0047 §17's "≥1 EP role under contract for ≥7 days" with:

> **intelligence-agent's `contract:` block parses cleanly across ≥3 daily wakes with no Zod errors, AND at least one wake observes a `done_when` assertion evaluating against real artifacts.**

The "≥7 days" original target was a stand-in for "uptime confidence." The ≥3-wake form measures the same property (the contract block survives the full parse + assembly + assertion cycle in production) with three independent observations instead of seven. If any of the three wakes produces a Zod error, the line stops and the ship slips.

### 5. Hard gates retained

- PR 1's 24h soak completes 2026-05-12 morning before PR 2 begins
- The 48h post-PR-4+5 observation window is not negotiable
- Real EP murmuration runs (intelligence + facilitator + at least one group convene) under full contract before tag
- Chinook Wind partnership convene under full contract before tag
- ADR-0048 (this document) accepted before PR 2 lands

### 6. Calendar

| Day     | Date    | Action                                           |
| ------- | ------- | ------------------------------------------------ |
| Mon     | 5-11    | PR 1 shipped, 24h soak running, ADR-0048 drafted |
| Tue     | 5-12    | PR 2 (AM) + PR 3 (PM, parallel)                  |
| Wed     | 5-13    | PR 4 (AM) + PR 5 (PM, parallel)                  |
| Thu–Fri | 5-14/15 | 48h observation under full contract              |
| Sat     | 5-16    | PR 6a (`validateBehavior` warning-only)          |
| Sun     | 5-17    | CHANGELOG + README + version bump                |
| Mon     | 5-18    | Final 24h observation + dashboard health check   |
| Tue     | 5-19    | Tag v0.8.0                                       |

## Consequences

### Positive

- v0.8.0 ships ~8 days from PR 1 instead of ~22–28. Operators get outcome validation 2 weeks sooner.
- `validateBehavior` ships warning-only and accumulates real false-positive/true-positive data during 0.8.x operation. PR 6b can tune thresholds from observed warnings rather than synthetic tests.
- harness#364 (validateWake false-positive on subscription-CLI source-directive wakes) can be addressed in 0.8.1 alongside PR 6b without re-opening the contract scope for v0.8.0.
- The Zod schema (PR 1) is locked at v0.8.0 — operator-authored `contract:` blocks written against v0.8.0 will parse identically in v0.8.1+.

### Negative

- Hallucinated tool-call claims continue to mark wakes as `valid: true` through v0.8.0's lifetime. This is the current state, so it is not a regression — but it does mean v0.8.0 does not close the Boundary 5 gap. Operators relying on `successfulWakes` as a correctness signal should be told explicitly that behavioral hallucinations are flagged but not enforced in v0.8.0.
- Inter-PR soaks are shorter than OpenClaw recommended. The mitigation is the additive-and-reversible structure of PRs 2–5; if any soak surfaces a regression the path forward is `git revert` and re-cut.
- The 3-wake acceptance criterion is less conservative than the 7-day spec. If a Zod regression takes ≥3 wakes to surface (e.g., a rare role.md field combination), v0.8.0 ships with that latent bug. Mitigation: ADR-0047 §17's 7-day clock continues to run after v0.8.0 ships; if a Zod error fires in days 4–7 we cut 0.8.0.1.

### Operational

- `CHANGELOG.md` for v0.8.0 must include an explicit "Known limitations" entry naming the warning-only behavioral validation and pointing at v0.8.1.
- ADR-0047 §17 is amended by reference: this ADR substitutes the acceptance criterion for v0.8.0 specifically; ADR-0047's original criterion remains the target for v0.8.1's behavioral hard-fail promotion.
- A v0.8.1 milestone is opened today in `xeeban/murmurations-harness` with PR 6b + the 14-day hard-fail soak as its only blocker.

## Status

Proposed. Accept before PR 2 lands (target: 2026-05-12 morning).
