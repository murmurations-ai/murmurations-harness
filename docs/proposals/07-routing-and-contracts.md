# Architectural Proposal 07: Routing & Contracts

- **Status:** Draft — incorporating engineering circle amendments (review in progress until 2026-05-07)
- **Date:** 2026-04-30
- **Author:** Source (Nori / Kozan)
- **Scope:** three boundary contracts; ~1 sprint of focused work
- **Tracks:** [#232](https://github.com/murmurations-ai/murmurations-harness/issues/232), [#235](https://github.com/murmurations-ai/murmurations-harness/issues/235), [#236](https://github.com/murmurations-ai/murmurations-harness/issues/236)
- **Amendments incorporated:** see § Amendments at end of document

## Context

Three issues filed in the past 72 hours surface what is structurally the same failure pattern, at three different layers:

| Issue | Layer                                 | Failure                                                                                                                                                                                                                                         |
| ----- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #236  | role.md schema ↔ runtime expectations | ADR-0026's role.md migration silently dropped `signals.github_scopes` from 27 EP agents on 2026-04-18. Zod accepted every intermediate state. Agents went wake-blind for 9 days before anyone noticed.                                          |
| #232  | signal aggregator silent-degradation  | When an agent has empty/missing scopes, the aggregator returns `[]` with no warning. The wake completes "successfully" with `signal_count: 0`.                                                                                                  |
| #235  | directive labels ↔ signal aggregator  | `murmuration directive --group engineering` emits `scope:group:engineering` labels. No agent's signal pipeline listens for those labels — they listen for `assigned:<id>`. Group-scoped and all-scoped directives are invisible to every agent. |

These are not three independent bugs. They are three instances of the same architectural pattern: **interface drift at boundaries that are not typed, not tested, and not observable**. The harness has clean typed contracts inside modules (Zod-validated frontmatter, branded `AgentId` / `WakeId`, plugin interfaces) but the _cross-module_ contracts are mostly written in prose. When prose drifts, nothing catches it.

This proposal scopes a focused architectural pass to remediate exactly these three boundaries — no broader refactoring, no new features. Each boundary gets the same three things: a typed contract, a round-trip integration test, and a non-silent failure path.

## The pattern

A boundary contract is the agreement between two modules about what one of them produces and the other one consumes. In the harness today, three properties characterize each cross-module boundary:

1. **Typed or untyped.** Is the agreement encoded in TypeScript types, schemas, or shared constants? Or is it implicit in two parallel string literals?
2. **Tested or untested at the round trip.** Is there an integration test that proves "X produces something Y can consume"? Or do X and Y each have unit tests that don't talk to each other?
3. **Observable or silent at failure.** When the contract breaks, does the system warn loudly? Or does it silently produce zero work?

A boundary that is typed _and_ round-trip-tested _and_ observable on failure cannot drift without somebody noticing. A boundary that is none of these is a 9-day blackout waiting to happen.

The three boundaries in scope below all currently score zero or one out of three. The proposal is to bring each to three out of three.

## Boundary 1: Directive labels ↔ signal aggregator (#235)

### Current state

| Property           | Status                                                                                                                                                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typed contract     | **None.** `packages/cli/src/directive.ts:115-121` hardcodes `scope:agent:`, `scope:group:`, `scope:all` strings. The signal aggregator reads agent role.md `signals.github_scopes.filter.labels` strings. They share no type, no constant, no schema. |
| Round-trip test    | **None.** No test verifies that filing a directive with `--group X` causes an agent in group X to receive it as a signal.                                                                                                                             |
| Non-silent failure | **Silent.** Aggregator returns `[]` with no log when no labels match. No warning when an issue with `scope:*` labels exists but no agent's filter would catch it.                                                                                     |

### Drift incident

Discovered 2026-04-30: three EP directives (xeeban/emergent-praxis#552, #553, #554) filed via `murmuration directive --group <X>` between 2026-04-25 and 2026-04-26 had been open for 5 days with zero agent activity. The CLI had emitted only `scope:group:<X>` labels; no agent's `assigned:<id>` filter caught them. The directives were invisible until manually backfilled with 28 `assigned:<agent-id>` labels.

### Deliverables

**1.1 Typed contract.** A new module `packages/core/src/routing/index.ts` exporting:

```ts
export type RoutingScope =
  | { kind: "agent"; agentId: AgentId }
  | { kind: "group"; groupId: GroupId }
  | { kind: "all" };

export const toLabels = (scope: RoutingScope): string[] => {
  /* ... */
};
export const parseLabels = (labels: readonly string[]): RoutingScope[] => {
  /* ... */
};

export const routingScopeMatchesAgent = (
  scope: RoutingScope,
  agent: { agentId: AgentId; groupMemberships: readonly GroupId[] },
): boolean => {
  /* ... */
};
```

Both the directive CLI (`packages/cli/src/directive.ts`) and the signal aggregator (`packages/signals/src/`) import from this single source. The label format becomes a typed serialization, not a string-literal coincidence.

**1.2 Round-trip integration test.** New `packages/core/src/daemon/daemon.routing.test.ts` extending the existing in-process daemon harness:

- Two agents in group `engineering`, one in group `content`.
- Run `runDirective(['--group', 'engineering', 'test'])` against the in-memory collaboration provider.
- Fire a wake for each agent.
- Assert: both engineering agents see the directive in their `SignalBundle`. The content agent does not.
- Repeat for `--all` (all three see it) and `--agent <id>` (only the named agent sees it).

**1.3 Non-silent failure path.** Implement the membership-aware aggregator from #235 Option C: when aggregating signals for agent X with `groupMemberships: [G1, G2]`, the aggregator queries GitHub for issues matching ANY of `[assigned:<id>]`, `[scope:agent:<id>]`, `[scope:group:G1]`, `[scope:group:G2]`, `[scope:all]`. Then dedupe by issue number. As a transition-period backstop: if the aggregator finds an issue with a `scope:*` label that no current agent's filter catches, log `daemon.signals.unrouted` with the issue number and label.

## Boundary 2: role.md schema ↔ runtime expectations (#236)

### Current state

| Property           | Status                                                                                                                                                                                                                                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typed contract     | **Partial.** `packages/core/src/identity/index.ts:300-381` has Zod schemas with sensible defaults. But the schemas validate _syntactic_ validity, not _operational_ completeness. An agent with empty `signals.sources`, empty `signals.github_scopes`, and empty `tools.mcp` is "valid" by Zod and wake-blind in production. |
| Round-trip test    | **None.** No test asserts that "an agent with `signals.sources: [github-issue]` and empty `signals.github_scopes` fails or warns."                                                                                                                                                                                            |
| Non-silent failure | **Silent.** Daemon boot logs `daemon.compose.agent` happily for misconfigured agents. The first wake produces `signal_count: 0` and idles, with no clue why.                                                                                                                                                                  |

### Drift incident

Discovered 2026-04-27: the harness's ADR-0026 schema migration (commit `54fe887`, 2026-04-18) wholesale-rewrote 27 EP role.md files with minimal frontmatter. Subsequent commits added back `signals.sources`, `github.write_scopes`, MCP plugins, and `max_wall_clock_ms` — but never restored `signals.github_scopes`. Zod accepted every intermediate state. Agents woke, queried the signal aggregator, got `[]`, and went idle for 9 days.

### Deliverables

**2.1 Typed contract.** A new function `validateOperationalCompleteness(frontmatter: RoleFrontmatterParsed): OperationalGap[]` returning a typed list of gaps:

```ts
export type OperationalGap =
  | { code: "no-signal-sources"; severity: "warn"; reason: string }
  | { code: "github-issue-source-without-scopes"; severity: "error"; reason: string }
  | { code: "no-mcp-tools"; severity: "warn"; reason: string }
  | { code: "no-write-scopes"; severity: "info"; reason: string }
  | { code: "wake-but-no-llm"; severity: "error"; reason: string };
```

This sits between the Zod parse and the runtime composition. The Zod schema continues to allow defaults (templates, tests need this); the operational validator declares which defaults are dangerous in a real murmuration.

**Constraint on `reason` content** (security-agent amendment, 2026-04-30): the `reason` string must be constructed from static template strings plus configuration values that the operator already controls (agent id, source kind, repo coordinate). It must not embed dynamic system data — full filesystem paths, environment variables, raw stack traces, or anything that could leak host internals through a doctor or log surface. Acceptable: `` `Agent '${agentId}' has source 'github-issue' but no scopes defined` ``. Not acceptable: `` `Agent failed at /Users/operator/.../role.md line 42` ``.

**2.2 Round-trip integration test.** New `identity.operational-completeness.test.ts` with one fixture per `OperationalGap` code, asserting the validator returns the expected gap. New `daemon.boot.gaps.test.ts` asserting that when an `error`-severity gap is present, daemon boot logs `daemon.compose.agent.gaps` and (if `runtime.allow_incomplete_agents !== true` in harness.yaml) refuses to register the agent.

**2.3 Non-silent failure path.** Three call sites:

1. `murmuration doctor` consumes the validator and surfaces gaps as findings.
2. Daemon boot logs `daemon.compose.agent.gaps` for every agent with non-empty gaps.
3. New schema-drift detector: operators commit `governance/schema-baseline.json` (a snapshot of expected role.md operational shape per agent). Doctor adds a check `schema.role.<slug>.drift-from-baseline` that diffs current against baseline and surfaces dropped fields as findings.

## Boundary 3: Signal pipeline silent-degradation (#232)

### Current state

| Property           | Status                                                                                                                                                                                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typed contract     | **Partial.** `SignalAggregator.aggregate()` has typed inputs. The output is `Result<{ bundle: SignalBundle }, AggregatorError>` — but there is no typed concept of "warning" between success and error.                                                                                         |
| Round-trip test    | **Partial.** Unit tests cover happy paths. No test exercises the silent-degradation paths (empty scopes, unreachable repo, github-client unavailable).                                                                                                                                          |
| Non-silent failure | **Silent.** `packages/signals/src/index.ts:187-189` short-circuits to `return []` when scopes are empty or no github client is configured. No warning is emitted. The wake outcome distinguishes "successful with 0 signals" from "broken with 0 signals" only by reading the daemon boot logs. |

### Drift incident

The 9-day EP blackout was _also_ this issue, observed from the aggregator side. Even after `signals.github_scopes` was dropped from role.md, the aggregator saw "0 scopes configured → no work to do" and quietly produced an empty bundle. A loud warning at the aggregator layer would have caught the regression on day one.

### Deliverables

**3.1 Typed contract.** Extend `SignalAggregator.aggregate()` to return warnings alongside the bundle:

```ts
export type AggregatorWarning =
  | { code: "scopes-empty-but-sources-include-github-issue"; severity: "error" }
  | { code: "github-client-unavailable"; severity: "error" }
  | { code: "repo-unreachable"; repo: string; severity: "warn" }
  | { code: "scope-matched-zero-issues"; scope: RepoCoordinate; severity: "info" };

export type AggregateResult =
  | { ok: true; bundle: SignalBundle; warnings: readonly AggregatorWarning[] }
  | { ok: false; error: AggregatorError };
```

Warnings flow into the `WakeOutcome` and into `daemon.wake.aggregator.warning` log events.

**3.2 Round-trip integration test.** New `packages/signals/src/aggregator.warnings.test.ts` covering each warning code with a controlled fixture (in-memory github client, configurable scope shapes).

**3.3 Non-silent failure path.** Daemon log surface for every warning. Dashboard surface so operators can see warning counts at a glance. Critically: when `scopes-empty-but-sources-include-github-issue` fires, the wake artifact records the warning so it appears in the wake summary, not just in the boot logs.

## Boundary 4 (deferred — follow-up sprint): role.md `group_memberships` ↔ `governance/groups/<g>.md` `## Members` (#238)

**Status: out of scope for this sprint. Documented here so the next sprint picks it up cleanly under the same pattern.**

This boundary was surfaced 2026-04-30 during the active consent round on this proposal — the same round that brings B1–B3 into scope. It is the fourth instance of the same architectural pattern at a fourth layer, but folding it into the in-flight 3-boundary scope would invalidate the consent already given by 5 specialists. It is therefore filed as [#238](https://github.com/murmurations-ai/murmurations-harness/issues/238) and deferred to the next sprint, with this section as the spec stub.

### Current state

| Property           | Status                                                                                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Typed contract     | **Partial.** Both sources of truth have typed parsers (Zod for role.md, regex parser in `packages/cli/src/group-wake.ts:201`). They share no consistency check — agreement is informal.                                                                      |
| Round-trip test    | **None.** No test asserts that "an agent declaring `group_memberships: [X]` is also listed in `governance/groups/X.md` `## Members`," or the reverse.                                                                                                        |
| Non-silent failure | **Silent.** `murmuration doctor` walks groups → members → checks each named member is a real agent dir. It does not walk agents → group_memberships → check each named group lists this agent. Drift is invisible until a Source consent round counts votes. |

### Drift incident

Discovered 2026-04-30 during the consent round on this proposal. Three EP agents (cfo-agent, quality-analyst-agent, knowledge-management-agent) declare `group_memberships: [..., engineering]` in their role.md but are not listed in `governance/groups/engineering.md` `## Members`. cfo-agent and quality-analyst-agent posted CONSENT on EP #592 self-identifying as engineering members. From the daemon's per-wake `groupMemberships` perspective they are; from the formal `## Members` perspective they are not. The 3-of-6 formal-member consent count vs the 5-of-N "everyone who self-identified" count diverge.

### Deliverables (sketch — to be finalized when the issue is picked up)

**4.1 Typed contract.** Establish a canonical reconciliation rule: `## Members` is canonical for circle composition (who is invited to consent rounds, group-wake meetings, formal governance); `group_memberships` is canonical for per-wake routing (which `scope:group:<g>` labels reach this agent). The two sources of truth serve different purposes and need not always agree, but disagreement is operationally meaningful and must be surfaced.

**4.2 Round-trip integration test.** New `doctor.membership-consistency.test.ts` covering both directions with controlled fixtures (agent in `## Members` but not in `group_memberships`; agent in `group_memberships` but not in `## Members`).

**4.3 Non-silent failure path.** New doctor check `schema.group.<g>.membership-consistency` that fails bidirectionally:

- An agent declares `group_memberships: [X]` but is not in `governance/groups/X.md` `## Members` → error.
- An agent is in `governance/groups/X.md` `## Members` but does not declare `X` in `group_memberships` → error.
- Optional: `murmuration doctor --reconcile-memberships` command surfaces a diff and offers to write either direction (operator picks per-agent).

### Why deferred, not folded in

Three reasons:

1. **Consent integrity.** Five specialists have already consented to a 3-boundary scope. Expanding scope mid-round would either require re-consent (slow) or silently expand what they consented to (a second-order instance of the same drift problem we are trying to fix).
2. **Sprint shape.** The current sprint is 3 days. Adding a fourth boundary changes the sprint to 4 days and risks all four landing late.
3. **Independence.** B4's deliverables don't unlock B1–B3 and are not blocked by them. It is a clean follow-up.

The follow-up sprint that picks up #238 should also retire any other instances of the pattern that have surfaced by then. The amendments section below records this discovery for the consent round.

## Cross-cutting principles

These three boundaries are the in-scope work for this proposal. The principles below are the design rules the work should follow — and the rules future cross-module boundaries should also follow.

1. **Single source of truth for cross-module strings.** Any string literal that appears in two modules — label names, frontmatter keys, event names, source kinds — must be a `const` or a discriminated union exported from a shared module. Two parallel string literals is an interface waiting to drift.

2. **Round-trip tests for cross-module behavior.** Any "X causes Y to happen" that spans more than one module needs an integration test. Unit tests of X and Y separately do not catch contract drift; they only catch implementation bugs within each module.

3. **Loud-on-zero.** When a system expects N items but finds 0, that is almost always wrong. Treat zero as a warning by default. Suppress warnings only with explicit operator opt-in (`harness.yaml: runtime.allow_zero_signals: true` or similar). When suppression is active, the system must announce it loudly, not silently honor it (security-agent amendment, 2026-04-30):
   - At daemon boot, log a `WARN`-level message to stderr: `SECURITY: Silent signal degradation is enabled via harness.yaml. Operational warnings will be suppressed.`
   - `murmuration doctor` must include a check that flags `runtime.allow_zero_signals: true` as a `warning`-severity finding, with the reasoning that the operator has opted out of drift detection. This way, the suppression is visible to anyone running doctor, not just to the operator who set it.

4. **Schema validity is not operational completeness.** Zod (or any schema layer) tells you the shape is parseable. It does not tell you the agent will function. A second validation layer between schema parse and runtime composition is required when defaults are sensible for templates but dangerous for production.

## Scope and non-goals

**In scope:**

- The three boundary contracts named above (#232, #235, #236).
- Typed contracts at each boundary, exported from a shared module.
- Round-trip integration tests for each.
- Non-silent failure paths for each.
- One ADR ratifying the "typed + tested + observable" pattern as a harness convention.
- Documentation of Boundary 4 (#238) as a deferred follow-up under the same pattern. This sprint does not implement B4; it does commit to the pattern that B4 will follow when picked up.

**Non-goals:**

- General architectural review of the harness.
- Refactoring the governance plugin interfaces, the executor interfaces, or the collaboration provider interface.
- New features (auto-wake-on-directive, real-time SSE, etc.).
- Performance optimization.
- Schema migration tooling beyond what is needed for the schema-baseline check.
- Backward-compatibility shims for the silent-degradation behavior. Operators on older role.md formats receive warnings by default; if they relied on silence, they explicitly opt back into it via harness.yaml.

## Implementation plan

Three days of focused work, sequenced to land each boundary's contract, test, and failure path together. Boundary 2 is sequenced first because its operational validator is reused by Boundaries 1 and 3.

| Day | Deliverable                                                                                       | Owner                               | Lands                    |
| --- | ------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------ |
| 1   | Boundary 2: `OperationalGap` type, validator, doctor integration, schema-drift detector.          | typescript-runtime + architecture   | #236 closed; ADR drafted |
| 2   | Boundary 1: `RoutingScope` type, label serializers, membership-aware aggregator, round-trip test. | architecture + typescript-runtime   | #235 closed              |
| 3   | Boundary 3: `AggregatorWarning` type, warning emission, dashboard surface, integration tests.     | typescript-runtime + devops-release | #232 closed              |

The same engineering pair (architecture + typescript-runtime) carries Boundaries 1 and 2; devops-release picks up the dashboard surface for Boundary 3. Security reviews each boundary for "could this warning surface leak something we don't intend." Engineering-lead facilitates and closes out.

## Acceptance

This proposal is complete when all of the following are true:

- [ ] `RoutingScope` type and serializers exist in a shared module; both directive CLI and signal aggregator import from it.
- [ ] `OperationalGap` type and `validateOperationalCompleteness` exist; doctor surfaces gaps; daemon boot logs gaps.
- [ ] `AggregatorWarning` type and warning emission exist; warnings flow into `WakeOutcome` and daemon logs.
- [ ] `governance/schema-baseline.json` schema documented; doctor's drift-from-baseline check is implemented.
- [ ] Round-trip integration tests exist for each boundary, exercising both happy and degraded paths.
- [ ] One ADR ratifies the "typed + tested + observable" pattern (numbered after the existing 0033).
- [ ] All three referenced issues (#232, #235, #236) are closed by PRs that link back to this proposal.
- [ ] CI passes; no breaking changes for operators who upgrade with default `harness.yaml`.

## Alternatives considered

**A. Do nothing — handle each issue as it appears.** Rejected because we have already paid this cost three times in 14 days (9-day directive blackout, ADR collisions, scope-routing gap). The three issues we have filed are almost certainly not the only instances of this pattern in the codebase. Treating them one-at-a-time means re-discovering the pattern each time and not building the muscle to prevent the next one.

**B. Full architectural review of all cross-module contracts.** Rejected because (a) the harness team is small and a full review would take several sprints, and (b) only some boundaries have actually drifted — the ones that have are the ones with concrete drift incidents to learn from. Better to fix the three known cases well than to speculatively touch every boundary.

**C. Schema-only fix (just #236).** Rejected because the schema layer is only one of three places this pattern manifests. Fixing schema validity without also fixing routing types and aggregator warnings would leave the silent-degradation behavior at two of three boundaries.

**D. ADR-only — write down the rule and rely on PR review to enforce it.** Rejected because the ADR-collision pattern is the canonical proof that prose rules don't enforce. The pre-flight check rule we added on 2026-04-27 is good and should stay, but it doesn't enforce; it only documents. Enforcement requires types, tests, and observable failures.

## Risks and open questions

**Risks**

- **Code churn touching many files.** Most of the change is additive (new types, new tests, new log fields). The one breaking-shape change is the `AggregatorWarning` flow into `WakeOutcome`, which may require updating downstream consumers in `runs/` digest assembly and the dashboard.
- **Test infrastructure extension.** The round-trip integration tests need an in-process daemon + agent fixture. The existing `daemon.test.ts` provides patterns to extend; this is not green-field.
- **Operator-facing change in default warning behavior.** Operators currently running with empty scopes will start seeing warnings. We treat this as the intended behavior — the warning is the point — but call it out explicitly in the v0.6 release notes and provide the opt-out (`runtime.allow_zero_signals: true`).

**Open questions for engineering circle**

1. Should `RoutingScope` live in `@murmurations-ai/core` or a new `@murmurations-ai/protocol` package? Recommendation: core for now; consider extraction in v0.5 if a second consumer emerges.
2. For the membership-aware aggregator (#235), GitHub's REST `?labels=` filter is AND-only. Two implementation options: (a) issue N parallel `listIssues` calls (one per label-set), dedupe; (b) use the search API. The search API has its own rate limit and does not respect REST conditional caching. Recommendation: (a), with `If-None-Match` ETags per scope-tier to keep API call cost bounded.
3. For schema-drift detection (#236), should `governance/schema-baseline.json` be operator-maintained (each operator commits their own baseline) or harness-shipped (the harness ships a "minimum sensible" baseline that operators inherit)? Recommendation: operator-maintained, with a `murmuration doctor --capture-baseline` command that snapshots the current state.
4. Should the operational-completeness validator be opt-in or opt-out per agent? Recommendation: opt-out via a `runtime.allow_incomplete_agents: true` flag in the agent's role.md frontmatter — explicit, per-agent, auditable.
5. Is one ADR for the whole pattern enough, or do we want one ADR per boundary? Recommendation: one ADR for the pattern, with each boundary's implementation linked from it.

## Decision sought

The engineering circle is asked to consent, object, or amend on:

1. **Scope** — limited to the three named boundaries; no broader review.
2. **Pattern** — typed contract + round-trip integration test + non-silent failure at every cross-module boundary going forward.
3. **Sequencing** — Boundary 2 first (operational validator is reused), then Boundary 1, then Boundary 3.
4. **Opt-out posture** — warnings on by default; operators must explicitly silence them.

If consent is reached, the next step is for engineering-lead to file the implementation ADR and break this proposal into the three sub-PRs.

## Amendments

This section catalogues amendments incorporated during the consent round, with attribution to the agent who proposed them. Each amendment is also reflected inline in the body of the proposal.

### A1 — `OperationalGap.reason` content constraint

- **Proposed by:** security-agent (#25)
- **Filed:** 2026-04-30, [PR #237 review](https://github.com/murmurations-ai/murmurations-harness/pull/237#issuecomment-4353550490)
- **Incorporated:** Boundary 2, deliverable 2.1 — added "Constraint on `reason` content" paragraph
- **Rule:** `OperationalGap.reason` must be built from static template strings + operator-controlled configuration values. Must not embed dynamic system data (filesystem paths, environment variables, raw stack traces) that could leak host internals through doctor output or log surfaces.
- **Rationale:** The gap reasons surface in `murmuration doctor` output and daemon logs that operators may share or post in support channels; the data inside them is therefore a low-grade information disclosure surface. Static-template construction keeps that surface auditable.

### A2 — `governance/schema-baseline.json` security review (no change)

- **Proposed by:** security-agent (#25)
- **Filed:** 2026-04-30, [PR #237 review](https://github.com/murmurations-ai/murmurations-harness/pull/237#issuecomment-4353550490)
- **Incorporated:** No proposal change required. Recorded for future reference.
- **Finding:** `governance/schema-baseline.json` is not a meaningful new attack surface. It is a JSON data file consumed by a comparison routine, not executed. An attacker with commit access could modify it, but that attacker can also modify role.md directly — this feature does not lower the bar. Use a standard safe JSON parser at the call site (already implied by existing harness patterns).
- **Implication:** No special access control is needed on the baseline file. Standard repo permissions apply.

### A4 — Boundary 4 (membership drift) documented as deferred follow-up

- **Surfaced by:** Source (Nori / Kozan), 2026-04-30, during the consent round
- **Tracked at:** [#238](https://github.com/murmurations-ai/murmurations-harness/issues/238)
- **Incorporated:** New "Boundary 4 (deferred)" section between B3 and Cross-cutting principles. Scope and non-goals updated to explicitly include "documenting B4" and exclude "implementing B4" in this sprint.
- **Rule:** `governance/groups/<g>.md` `## Members` is canonical for circle composition (who is invited to consent rounds and group-wake); `role.md group_memberships` is canonical for per-wake routing (`scope:group:<g>` label fan-out). The two sources of truth serve different purposes and need not always agree, but disagreement is operationally meaningful and must be surfaced via doctor.
- **Rationale:** During this consent round, three EP agents (cfo-agent, quality-analyst-agent, knowledge-management-agent) posted consent self-identifying as engineering members based on their role.md `group_memberships`, while the formal `governance/groups/engineering.md` `## Members` lists 6 ratified members that do not include them. The drift made the round count ambiguous (3-of-6 formal vs 5-of-N self-identified). Surfacing this is itself a fourth instance of the proposal's pattern. Folding it into the in-flight scope would invalidate consent already given; deferring it preserves consent integrity while putting the boundary on the record under the same pattern.

### A3 — `runtime.allow_zero_signals` must announce itself

- **Proposed by:** security-agent (#25)
- **Filed:** 2026-04-30, [PR #237 review](https://github.com/murmurations-ai/murmurations-harness/pull/237#issuecomment-4353550490)
- **Incorporated:** Cross-cutting principle 3 ("Loud-on-zero") — added the boot-time `WARN` log requirement and the doctor check requirement.
- **Rule:** When `runtime.allow_zero_signals: true` is active, the daemon must log a prominent stderr `WARN` at boot: `SECURITY: Silent signal degradation is enabled via harness.yaml. Operational warnings will be suppressed.` `murmuration doctor` must surface the active suppression as a `warning`-severity finding.
- **Rationale:** The escape hatch is necessary, but a silent escape hatch defeats the entire "loud-on-zero" purpose. Visibility-on-suppression keeps the cost of opting out commensurate with the cost of operating without drift detection.

## Links

- [#232 — signal pipeline silent-degradation warning](https://github.com/murmurations-ai/murmurations-harness/issues/232)
- [#234 — github MCP missing list_issue_comments / search_issues](https://github.com/murmurations-ai/murmurations-harness/issues/234) (sister, different layer; not in scope here)
- [#235 — directive scope labels don't route](https://github.com/murmurations-ai/murmurations-harness/issues/235)
- [#236 — role.md schema validates 'syntactically valid' but not 'operationally complete'](https://github.com/murmurations-ai/murmurations-harness/issues/236)
- [docs/ARCHITECTURE.md § Engineering Standards](../ARCHITECTURE.md) — the standards this proposal operationalizes
- [docs/LINT-DESIGN-GUIDE.md](../LINT-DESIGN-GUIDE.md) — the typing patterns this proposal extends
