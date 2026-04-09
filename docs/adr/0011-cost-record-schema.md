# ADR-0011 — WakeCostRecord schema and cost instrumentation plumbing

- **Status:** Accepted
- **Date:** 2026-04-09 (landed in commit `1B-c`)
- **Decision-maker(s):** Performance / Observability Agent #27 (authored the design doc), Engineering Circle
- **Consulted:** Security Agent #25 (log redaction composition), TypeScript / Runtime Agent #24 (type shape), DevOps / Release Agent #26 (daemon log integration)
- **Closes:** Phase 1B step B5 from `docs/PHASE-1-PLAN.md` and carry-forward [harness#5](https://github.com/murmurations-ai/murmurations-harness/issues/5) — plumbing portion only (mid-wake enforcement for cost/API dimensions is Phase 2)

## Context

The ratified `CostActuals` field on `AgentResult` (see ADR-0005) is
summary-only: input tokens, output tokens, wall clock, cost micros,
budget overrun count. Performance / Observability Agent #27 needs
enough structure to answer questions like:

- How much did each wake cost, broken down by model, subprocess, and
  GitHub API calls?
- What is the cost delta against the OpenClaw baseline?
- Which agents are trending toward their budget ceiling?
- What's the week-over-week cost rollup by circle?

Without a richer schema the dashboard work (Panel 4) and the cost
delta comparison against OpenClaw cannot land, and budget gates
(carry-forward #5) have nowhere to live.

## Decision

**Add an additive optional field `costRecord: WakeCostRecord` to
`AgentResult`, populated by executors that construct a
`WakeCostBuilder`. The existing `cost: CostActuals` field stays for
backwards compatibility and is derived from the record at finalize
time.**

### Sub-decisions

1. **`schemaVersion: 1` frozen now.** LLM and GitHub fields ride as
   zero stubs in Phase 1 because neither integration has landed — the
   schema is stable so downstream readers (Phase 2+ rollup aggregator,
   dashboard panels) can be built against it without churn.

2. **`WakeCostBuilder` is the mutable accumulator.** Constructed at
   spawn, handed to cost-emitting subsystems (subprocess executor in
   Phase 1; LLM and GitHub clients in Phase 2), finalized at wake end
   to produce an immutable `WakeCostRecord`. Idempotent `finalize()`.

3. **`addSubprocessUsage`** is named `recordSubprocessUsage` and
   accepts an explicit delta. The subprocess executor captures
   `process.resourceUsage()` at spawn and again at exit, then passes
   the delta. This is an approximation — Node does not expose
   per-child rusage cheaply — and is documented in the builder and
   the subprocess executor.

4. **`USDMicros` branded primitive.** Per ADR-0006 wrapped-object
   shape. Integer-only (`Number.isInteger` check) to prevent
   floating-point drift when summing many small amounts. Helper
   `formatUSDMicros` emits a 4-digit human-readable string for log
   fields; downstream consumers must use the integer `.value` for
   aggregation.

5. **`BudgetCeiling` is enforced in two places:**
   - **Wall clock, mid-wake:** via the existing `setTimeout` hard-kill
     path already in `SubprocessExecutor`. No change.
   - **Cost and API calls, post-hoc at finalize:** the builder runs
     `evaluateBudgetCeiling` and attaches the `BudgetGateResult` to
     the record. Mid-wake enforcement for these dimensions lands in
     Phase 2 when the LLM and GitHub clients exist and can call
     `builder.snapshotTotals()` after each unit of work.

6. **Two log events per wake:**
   - **`daemon.wake.cost`** — always emitted (at level `info`). Carries
     the full serialised record.
   - **`daemon.wake.budget.breach`** — emitted only when
     `costRecord.budget?.breaches.length > 0`. Level is `warn` for
     `onBreach === "warn"` and `error` for `onBreach === "abort"`.

7. **Field name conventions:** camelCase throughout to match the
   existing daemon log events (`durationMs`, `governanceEventCount`).
   Branded primitives flatten to their `.value` in log output.
   Undefined optional fields become JSON `null` so log consumers can
   rely on field presence.

8. **Composition with Security #25 redaction.** Cost field names
   (`inputTokens`, `outputTokens`, `costMicros`, `apiCalls`, etc.) do
   not collide with the scrubber's sensitive-name regex because they
   are compound names that don't match the anchored tokens. Numeric
   values pass the scrubber untouched (the scrubber only touches
   string values). No cost field ever carries user-supplied content.

## Consequences

### Positive

- Additive to `AgentResult` — no existing test or consumer breaks.
- The rollup aggregator (Phase 2+) has forward-compat hints
  (`rollupHints.dayUtc`, `isoWeekUtc`, `circleIds`) so it can be built
  without a schema migration.
- `daemon.wake.cost` is decoupled from outcome events, so outcome and
  cost consumers can evolve independently.
- Budget gates exist (post-hoc) even in Phase 1, so the carry-forward
  #5 "gates" semantics are fulfilled structurally.

### Negative

- Zero-stub fields for LLM and GitHub look dead in Phase 1. Accepted
  cost for schema stability.
- The subprocess rusage measurement is an approximation of the
  child's own usage. Documented; precision improves in Phase 2.
- Mid-wake enforcement for cost/API dimensions is not in Phase 1.
  Accepted; the hook (`snapshotTotals`) exists and is tested.

### Follow-ups

1. **LLM pricing catalog** — who owns `(provider, model, tier) →
per-token costMicros`? Needed before Phase 2's `addLlmTokens` calls
   mean anything. Candidate owners: TypeScript #24 + CFO #13.
2. **Rollup aggregator** — Phase 2+ reader that consumes `rollupHints`
   to produce daily / weekly / per-circle sums. Owner: Performance #27.
3. **War chest 1% ceiling integration** — the
   `SOURCE-DOMAIN-STATEMENT.md` bright line requires knowing the war
   chest number. Cross-circle follow-up with CFO #13 + Source.
4. **Mid-wake enforcement for cost/API dimensions** — Phase 2 design
   follow-up. Requires LLM-client and GitHub-client cooperation.
5. **Budget config in role.md frontmatter** — `max_cost_micros`,
   `max_github_api_calls`, `on_budget_breach`. Not landed in 1B-c to
   avoid scope creep into the identity loader; tracked as a follow-up
   co-owned with TypeScript #24.
6. **Per-child rusage precision** — `posix_spawn` +
   `getrusage(RUSAGE_CHILDREN)` if the Phase 2 cost delta against
   OpenClaw is sensitive to the approximation. Measure first.

## Alternatives considered

- **Replace `CostActuals` with `WakeCostRecord`.** Breaks the
  just-ratified ADR-0005 interface. Rejected: additive is strictly
  safer and the migration cost is zero for existing consumers.
- **Emit cost data inside the existing `daemon.wake.completed` event.**
  Couples two consumers who evolve at different rates (outcome
  routing vs dashboard metrics). Rejected.
- **Defer the cost schema to Phase 2 when LLM data exists.** Leaves
  the dashboard and rollup work blocked, and means a later
  breaking-change retrofit of `AgentResult`. Rejected.
