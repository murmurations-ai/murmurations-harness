# ADR-0042 — Done-criteria block in role.md + priority-tiered signal bundles

- **Status:** Proposed
- **Date:** 2026-05-04
- **Decision-maker(s):** Source (Nori), Engineering Circle
- **Driver:** 2026-05-04 effectiveness audit — 334 narrative-only-claim hits across 267 wakes in one production murmuration; 41% wake-failure rate from 9-min timeout; agents reprocess full backlog every wake. Two structural harness-side causes: agents have no machine-checkable definition of "done" and signal bundles are flat with no priority. See `docs/specs/0001-agent-effectiveness.md`.
- **Related:** ADR-0013 (signal aggregator), ADR-0029 (self-digest tail-cap), ADR-0040 (wake event stream), ADR-0041 (facilitator-agent), harness#298 (differential signal bundles — subsumed).

## Context

The wake-effort distribution today:

```
agent wakes → reads full backlog (15-cap) → comments on each in turn
          → reflects "EFFECTIVENESS: high"
          → harness validator: narrative-only-claim across N
          → next wake: same backlog still open, same comments again
```

Two compounding problems:

1. **No machine-checkable done definition.** `role.md` lists accountabilities as verbs ("post weekly digest", "comment on tensions"). The agent self-reports `EFFECTIVENESS: high` whenever it's done _something_. The harness has no way to validate; Boundary 5 detection catches _negative_ signals (claimed-without-acting) but not _positive_ completion. Result: 78% open-issue rate even when agents wake regularly.

2. **Flat signal bundles, no priority.** Aggregator returns up to 15 most-recent issues. A 9-minute wake budget gets spent on whatever happened to be at the top, regardless of urgency. New `[PROPOSAL]` filings (like #787) lose to old `[TENSION]` re-discussions. The agent has no way to "work top-down within budget" — the budget framing isn't even in the prompt.

These are linked: a working priority bundle needs a way to know which items are _done_ (so they fall out automatically), which requires machine-checkable done conditions.

## Decision (proposed)

### Part 1 — `done_when` schema in role.md

Each accountability gains a `done_when` block listing **structural** conditions the harness can verify. The harness validates these against current state at wake-end and at wake-start (so completed items fall out of the next bundle).

**Schema:**

```yaml
accountabilities:
  - id: weekly-digest # stable slug, used in telemetry
    cadence: weekly # informational; affects priority bumping
    description: "Synthesize the week's events" # human prose; for the prompt
    done_when: # ALL must be true; AND-semantics
      - kind: file-committed
        path: "chronicles/digests/{period}.md" # {period} = current ISO week
      - kind: issue-closed-or-blocker-filed
        triggering-issue: "${this.assigned-issue}"
      - kind: comment-posted
        on-issue: "*announce-channel-issue"
        contains-link-to: "${this.committed-file}"

  - id: tension-resolution
    cadence: continuous
    description: "Close tensions you filed once they're resolved"
    done_when:
      - kind: issue-closed
        filter:
          author: "${self.agent-id}"
          type: "[TENSION]"
          state: resolved-by-evidence
```

**Condition kinds (the harness's allowlist; plugins extend):**

| `kind`                          | Validator checks                                                  |
| ------------------------------- | ----------------------------------------------------------------- |
| `file-committed`                | Git ref exists with the named path; commit timestamp ≥ wake start |
| `issue-closed`                  | GitHub issue is `state: CLOSED`, optionally with required label   |
| `issue-closed-or-blocker-filed` | Issue closed OR a successor `[TENSION]` exists naming the blocker |
| `comment-posted`                | Comment exists on issue, optionally containing a link/regex       |
| `label-applied`                 | Issue has the named label                                         |
| `agreement-registered`          | `governance/agreements/<slug>.md` exists with content             |

**Variable interpolation** keeps the schema declarative: `${self.agent-id}`, `${this.<accountability-context-field>}`, `{period}` for cadence-derived placeholders.

**Validation pass at wake-end** replaces self-reported effectiveness:

```
effectiveness: 4/6 met (1 partial, 1 unmet)
unmet:
  - weekly-digest: "comment-posted condition failed — no announce-channel comment"
```

Self-reported `EFFECTIVENESS: high` is preserved for the LLM's qualitative reflection but is no longer load-bearing. The number that ships into telemetry is the structural one.

### Part 2 — Priority-tiered signal bundles

The signal aggregator changes from "15 most-recent" to "tiered by priority, total cap 15."

**Tiers:**

| Tier       | Sources                                                                                                                                              |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `critical` | Issues with label `priority:critical`; `source-directive` + `tier:consent` filed in last 24h; `awaiting:source-close` for facilitator only           |
| `high`     | Active consent rounds the agent is named in; `[DIRECTIVE]` with `assigned:<self>` filed in last 7d; `[*MEETING]` issues with the agent on the agenda |
| `normal`   | Standard backlog: `assigned:<self>` issues, `[TENSION]` filed by self, work in flight                                                                |
| `low`      | Open >14d with no recent activity; `priority:low` labeled; informational                                                                             |

**Bundle composition** (within the 15-signal total cap):

```
critical: take all (cap 5)
high: take all up to remaining budget (cap 6)
normal: take most-recent up to remaining (cap 4)
low: take ONLY if budget remains (typical: 0–2)
```

**Wake prompt** explicitly states the budget and tier counts:

```markdown
## Your wake budget

~9 minutes. You have:

- 2 critical items (must address)
- 4 high items (address as budget permits)
- 4 normal items (only if you finish above)
- 0 low items (intentionally excluded — see priority rules)

Work top-down. Address each item to its done_when conditions.
If you run out of budget, list what's left in your reflection — those items
will be priority-bumped on your next wake.
```

**Done-criteria interlock:** when an issue's `done_when` is satisfied at wake-start, it's excluded from the bundle entirely (whether closed or not). This subsumes harness#298 — agents don't see items they've already completed; new state automatically becomes the next priority.

**Priority bumping:** if an item appears in a bundle but the agent didn't address it (no comment, no tool call, no done-check posted), its priority floor is raised one tier on the next wake. After two skips at `critical`, the facilitator is notified and the item gets a `verification-failed` or stale escalation.

### Part 3 — Wake reflection becomes structured

Today's free-form `## Self-Reflection` block is supplemented with a structured `## Done-check` block that the harness validates:

```markdown
## Done-check

- weekly-digest: met ✓
  - file-committed: chronicles/digests/2026-W18.md (commit a1b2c3d)
  - issue-closed-or-blocker-filed: closed #647
  - comment-posted: #general-issue#42 with link
- tension-resolution: 0/1 unmet
  - issue-closed: tension #659 still open — no resolution evidence yet, will revisit next wake
```

The agent writes this; the harness validates each line against state. Discrepancies between agent claim and validator finding become a new telemetry event: `wake.done_check.discrepancy`.

## Considered Options

1. **Schema-less done criteria, agent self-reports.** Today's pattern.
   _Rejected: this is what gave us 334 narrative-only-claims. The data is conclusive._

2. **`done_when` block + flat bundle (no priority).** Add machine-checkable done but keep bundle as-is.
   _Rejected: closes the verification loop but doesn't fix the wake-budget waste. Agents still spend 9 minutes on the wrong things._

3. **Priority bundle + free-form done.** Fix budget but not verification.
   _Rejected: priority without verification means agents claim "high effectiveness" on the right items but still don't actually finish them. Same theater, better-prioritized theater._

4. **`done_when` schema + priority bundle** (chosen). The two reinforce each other — done items fall out of priority bundles, priority drives what gets done.

## Consequences

**Easier:**

- Boundary 5 (narrative-only-claim) becomes the negative case of a positive-verification system. Both directions checked.
- Median wake stops re-processing the same backlog — items fall out as `done_when` is satisfied.
- Wake budget framed in the prompt — agents stop trying to "do everything" and instead address top-tier first. Lower tiers naturally land in next wake's bundle when there's budget.
- harness#298 (differential signal bundles) is subsumed: differential = "items not yet done", which is exactly what the priority bundle filters in.
- Effectiveness telemetry becomes addressable per accountability: `weekly-digest` met-rate over time, `tension-resolution` met-rate over time. Source can see exactly which accountabilities are healthy.

**Harder:**

- Adopting operators must translate existing accountabilities into `done_when` blocks across their agent fleet. Real but bounded operator-side work; opt-in (omitting `done_when` falls back to today's behavior).
- The condition kinds form an allowlist; new kinds (e.g. "PR-merged", "metric-threshold-crossed") need harness-side validators. Expected to grow but starts minimal.
- Variable interpolation has a small DSL (`${self.X}`, `${this.Y}`, `{period}`). Documented in `docs/CONFIGURATION.md`; small but real.
- Priority bumping logic needs a state field on each agent's open items: skip-count, last-tier. Stored in `.murmuration/agents/state.json` (extends ADR-0029 record).

**Reversibility:** High. `done_when` block is optional in role.md (agents without it fall back to today's behavior). Priority bundle can be feature-flagged at the aggregator level. Both are additive.

## Risks

- **R1: Variable-interpolation overreach.** Operators may try to write Turing-complete `done_when` blocks. Mitigation: allowlist kinds only, no expressions, no logic; if it gets complicated, file an issue and the harness adds a kind.
- **R2: Priority misclassification.** A genuinely critical item lands in `normal` and never gets done because budget runs out at `high`. Mitigation: the priority-bumping mechanism + facilitator's stale escalation provide two safety nets.
- **R3: Aggregator cost.** Computing tier classifications + done_when status on every wake requires more GitHub queries. Mitigation: cache `done_when` results per (agent, accountability, last-checked-state) hash; only re-validate on state change.
- **R4: Condition-kind drift between harness versions.** If a role.md uses a kind that's been removed in a newer harness, the aggregator should fail loudly with a named missing kind rather than silently skipping. Mitigation: validator emits typed error.

## Definition of done

- [ ] `done_when` schema validated by Zod in identity loader
- [ ] Condition-kind validators in `packages/core/src/done-criteria/` (one file per kind)
- [ ] Aggregator gains tiered classifier with the rule table above
- [ ] Wake prompt template includes budget + tier counts
- [ ] Structured `## Done-check` block parsed at wake-end
- [ ] `wake.done_check.discrepancy` event when agent claim ≠ validator finding
- [ ] Priority-bumping state added to agent state record
- [ ] Telemetry: per-accountability met-rate over time
- [ ] Tests covering: each condition kind, variable interpolation, tier classification, priority bumping, discrepancy detection
- [ ] Documentation in `docs/CONFIGURATION.md` § Done-criteria and `docs/ARCHITECTURE.md` § Signal bundles
