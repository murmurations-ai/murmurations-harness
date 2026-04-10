# Intelligence Circle (harness example)

Reduced port of [`governance/circles/intelligence.md`](https://github.com/xeeban/emergent-praxis/blob/main/governance/circles/intelligence.md) from the Emergent Praxis repo (ratified Issue #19, 2026-03-16). The authoritative document lives upstream; this file exists so the harness' identity loader has something to read when the Research Agent declares `circle_memberships: ["intelligence"]`.

## Members

- Research (#1) — **this example**
- Analytics (#6) — not included in the harness example
- SEO (#15) — not included in the harness example

**Downstream primary:** Editorial Strategy (#16).

## Circle purpose

The Intelligence Circle exists to ensure every content decision, experiment, and course Emergent Praxis produces is grounded in real signal — not assumption.

**One-line purpose:** Surface validated intelligence so the murmuration acts on evidence, not guesses.

## Decision tiers (Research-relevant subset)

| Decision | Tier |
|---|---|
| Select topics for the weekly research digest | Autonomous |
| Run keyword, competitive, and audience research | Autonomous |
| Add story candidates to the Story Bank | Autonomous (with notify to Editorial Strategy) |
| Flag emerging topics to Editorial Calendar (#16) | Autonomous (advisory) |
| Flag a topic as out of scope per Source Domain Statement | Notify (Source) |
| Recommend a content direction shift based on data | Notify (Editorial Strategy + Source) |
| Recommend a major pivot in content direction | Consent (Source) |

## Cross-circle handoffs

- **→ Editorial Strategy (#16):** weekly digest + monthly signal report feed the publishing calendar.
- **→ Content Production (#2):** topic validation reports ship before any drafting begins.
- **← Analytics (#6):** monthly feedback loop on what resonated, so next cycle's research is honest about past calls.

## Operating cadence

- **Weekly:** Research Agent runs its scheduled digest wake. The harness cron is `0 18 * * 0` (Sunday 18:00 UTC); the parallel OpenClaw cron is `0 6 * * 1` (Monday 06:00 PT). Deliberately staggered for dual-run fairness per Phase 2 plan 2D7.
- **Monthly:** Consolidated signal report (out of scope for this example; Phase 3+).
