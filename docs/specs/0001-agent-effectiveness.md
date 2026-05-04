# Spec 0001 — Agent Effectiveness Release (v0.7.0)

- **Status:** Draft
- **Owner:** Source (Nori) + Engineering Circle
- **Target release:** Murmuration Harness v0.7.0
- **Driver date:** 2026-05-04
- **References:** ADR-0041 (facilitator-agent + plugin state machines), ADR-0042 (done-criteria + priority bundles), tracking issues TBD (filed alongside this spec)

---

## 1. Executive summary

A 5-week effectiveness audit of one production murmuration revealed a 78% open-issue rate, 0% closure on meeting issues, 7% closure on proposals, and a 41% wake-failure rate. Agents post comments but do not finish work. The pattern is **structural to the harness today**, not the operator's fault: there is no agent role with closure authority, no machine-checkable definition of "done," and no priority on what wakes spend their budget on. Any operator running the harness today inherits the same ceiling.

This spec defines a coordinated set of changes — shipping together as **harness v0.7.0 "Agent Effectiveness"** — that turn agents from comment-producers into work-finishers, **for any murmuration**:

1. A **facilitator-agent** role with closure authority, default in every murmuration
2. A **plugin-owned governance state machine** that lets governance models (S3, chain-of-command, meritocratic, etc.) define their own state graphs
3. A **`done_when` schema** in role.md that makes agent completion machine-checkable
4. **Priority-tiered signal bundles** so wake budget goes to the highest-leverage work
5. A **closure rule table** with verification (no silent closes; structural evidence required)
6. A **decision log + agreement registry** so consented work becomes durable record
7. An **effectiveness metrics surface** so the targets below are observable, not aspirational

This is the v0.7.0 release marker. ADR-0041 and ADR-0042 contain the architectural decisions; this spec is the implementation plan.

---

## 2. Problem statement (data)

From the 2026-05-04 audit. The murmuration sampled is one operator's production deployment; figures are illustrative of structural-issue magnitude, not a target the harness validates against.

**Issue-closure rates** (created since 2026-04-01, n=500):

| Type                       | Open | Closed | Closure % |
| -------------------------- | ---: | -----: | --------: |
| `[DIRECTIVE]` (Source-led) |   12 |     48 |       80% |
| `[DRIVER]`                 |    3 |      2 |       40% |
| `[TENSION]`                |   62 |     28 |       31% |
| `[PROPOSAL]`               |   13 |      1 |    **7%** |
| `[OPERATIONAL MEETING]`    |   19 |      0 |    **0%** |
| `[GOVERNANCE MEETING]`     |   15 |      0 |    **0%** |
| `[other]`                  |  260 |     29 |       10% |

**Open-issue age:** median 12d, 211/391 (54%) >7d, 149/391 (38%) >14d.

**Wake telemetry** (267 wakes across ~3 weeks):

- 109 (41%) wrote placeholder digests (LLM never returned)
- 89 (33%) `outcome: failed`
- 334 narrative-only-claim hits (Boundary 5 — agent claimed action without tool call)
- $94 shadow API cost ($0 marginal via subscription-cli)

**The diagnostic:** anything Source closes by hand has 80% closure; anything left for agents is 0–10%. Murmurations file faster than they finish. Agents reprocess the same backlog every wake because nothing tells them "this is done; move on." The fixes below are for the harness itself — operator outcomes follow from removing the structural ceiling.

---

## 3. Goals and non-goals

### Goals

- Closure rate (non-`[DIRECTIVE]`) > 50% within 14d of filing
- Median open-issue age < 7d
- Boundary 5 hits per wake < 0.2 (down from 1.25)
- Wake completion rate > 90% (up from 59%)
- Cost per closed issue < $1 (down from ~$3.40)
- Every closed proposal has a `governance/decisions/` entry
- Every consented agreement has a `governance/agreements/` entry

### Non-goals (explicitly out of scope for v0.7.0)

- Live wake observability (ADR-0040 — separate workstream, may overlap)
- Spirit + daemon session resume (harness#293 — separate)
- Full Langfuse self-reflection wiring (ADR-0022 — depends on this release for `done_when` data)
- Migration of subscription-CLI telemetry parsing (harness#302 — runs alongside ADR-0040)
- New governance plugins (chain-of-command etc.) — interface ready, plugins are stubs

---

## 4. Architecture

### 4.1 System diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                    harness core (governance-agnostic)            │
│                                                                   │
│  ┌──────────────────┐     ┌──────────────────────────────────┐  │
│  │ GovernancePlugin │ ←── │ facilitator-agent (default role) │  │
│  │   interface      │     │  - reads state via plugin         │  │
│  │  - stateGraph    │     │  - applies transitions            │  │
│  │  - computeNext   │     │  - closes issues per rule table   │  │
│  │  - isTerminal    │     │  - writes decisions/agreements    │  │
│  │  - buildAgenda?  │     │  - files daily [FACILITATOR LOG]  │  │
│  │  - verifyClosure?│     └──────────────────────────────────┘  │
│  └──────────────────┘                                             │
│                                                                   │
│  ┌──────────────────┐     ┌──────────────────────────────────┐  │
│  │ Identity loader  │ ←── │ done_when schema (per             │  │
│  │  validates       │     │   accountability, machine-checked) │  │
│  │  done_when       │     └──────────────────────────────────┘  │
│  └──────────────────┘                                             │
│                                                                   │
│  ┌──────────────────┐     ┌──────────────────────────────────┐  │
│  │ Signal aggregator│ ←── │ Priority-tiered bundle            │  │
│  │  classifies      │     │   critical / high / normal / low  │  │
│  │  open items      │     │   done items fall out             │  │
│  └──────────────────┘     └──────────────────────────────────┘  │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
                                  ↓
┌─────────────────────────────────────────────────────────────────┐
│        S3 governance plugin (state names + logic)                │
│  states: filed → routed → in_round → quorum_check               │
│         → consenting (T) | amended (T) | objected | withdrawn   │
│  computeNext: parses positions from issue comments              │
│  verifyClosure: requires consent quorum + named blocker absent  │
└─────────────────────────────────────────────────────────────────┘
                                  ↓
┌─────────────────────────────────────────────────────────────────┐
│  Stub plugins (interface satisfied, logic deferred)              │
│  - chain-of-command  - meritocratic  - consensus  - parliamentary│
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 Key contracts

**`GovernancePlugin` (extended) — see ADR-0041 §Part 2 for full interface.** Adds `stateGraph()`, `computeNextState()`, `isTerminal()`, optional `buildAgenda()`, `verifyClosure()`, `closerFor()`. State names are arbitrary plugin-defined strings; the harness does not interpret them.

**`done_when` schema — see ADR-0042 §Part 1 for full schema.** Allowlist of condition kinds:
`file-committed`, `issue-closed`, `issue-closed-or-blocker-filed`, `comment-posted`, `label-applied`, `agreement-registered`. Plugins extend the allowlist.

**Closure rule table — see ADR-0041 §Part 3.** Default closer per issue type, overridable per-plugin.

**Priority bundle classifier — see ADR-0042 §Part 2.** 4-tier classification; total cap 15; done items excluded.

**Spirit MCP tool extensions:**

```typescript
// Added to packages/cli/src/spirit/tools.ts
- list_awaiting_source_close: () => Issue[]   // Source query for "what needs my attention"
- close_issue: (issueNumber, reason) => void  // Source-side close from REPL
- get_facilitator_log: (date?) => string      // Today's [FACILITATOR LOG] body
- get_agreement: (slug) => string             // Read agreement registry entry
```

### 4.3 Data model additions

**`AgentRecord`** (extends ADR-0029 + ADR-0040 record):

```typescript
readonly accountabilityState?: Record<string, {
  readonly lastValidatedAt: string;       // ISO
  readonly metAtLastWake: boolean;
  readonly skipCount: number;             // for priority bumping
}>;
readonly priorityFloors?: Record<string, "critical" | "high" | "normal" | "low">;
//                                ^ issueId
```

**`GovernanceItem`** (extends existing):

```typescript
readonly currentState: string;            // plugin-defined, opaque to harness
readonly stateHistory: readonly { from: string; to: string; at: string; reason: string }[];
readonly lastFacilitatorRunAt?: string;
readonly closureEvidence?: ClosureEvidence;
```

**On-disk paths added:**

```
governance/
  decisions/
    YYYY-MM-DD.md                    # daily decision log
  agreements/
    <topic-slug>.md                  # one per topic, addressable
.murmuration/
  facilitator/
    log/
      YYYY-MM-DD.jsonl               # facilitator wake events
    state.json                       # state machine snapshot
```

---

## 5. Workstream breakdown

Seven landable workstreams (A–G). Internal phases for development; final release is one bundled `v0.7.0` tag.

### Workstream A — Facilitator-agent reference implementation

**Goal:** A working facilitator-agent in `examples/`, copied as default by `murmuration init`.

**Deliverables:**

- `examples/facilitator-agent/role.md` (governance-agnostic accountabilities)
- `examples/facilitator-agent/skills/s3-governance.md` — full S3 logic (consent rounds, quorum, position parsing, objection integration, closure verification)
- `examples/facilitator-agent/skills/chain-of-command.md` — interface stub, design notes
- `examples/facilitator-agent/skills/meritocratic.md` — interface stub
- `examples/facilitator-agent/skills/consensus.md` — interface stub
- `examples/facilitator-agent/skills/parliamentary.md` — interface stub
- `murmuration init` copies `examples/facilitator-agent/` into target `agents/facilitator-agent/` automatically (idempotent — does not overwrite if Source has edited it)
- Default `wake_schedule: { cron: "0 7,18 * * *" }`

**Dependencies:** Workstream B (state machine plugin interface).

**Acceptance:**

- Skill loads correctly per harness governance plugin
- Facilitator dry-run on EP shows correct state-machine transitions across 5+ active proposals
- `murmuration init` in a fresh directory produces a working facilitator

### Workstream B — Plugin-owned governance state machine

**Goal:** State names and transitions are 100% plugin-defined; harness core treats them as opaque strings.

**Deliverables:**

- `GovernancePlugin` interface extended (ADR-0041 §Part 2)
- `GovernanceStateGraph` becomes plugin-returned, not core-defined
- `GovernanceStateStore` refactored to read state names via plugin (no S3-specific names in `packages/core/`)
- S3 plugin updated to fully satisfy the new interface
- Stub plugins (`packages/cli/src/governance-plugins/{chain-of-command,meritocratic,consensus,parliamentary}/index.mjs`) — return valid `stateGraph()` shells, `computeNextState()` returns null
- Backwards-compat shim removed (no out-of-tree plugins exist; clean break)

**Dependencies:** None — foundational.

**Acceptance:**

- All existing S3 tests pass against the new interface
- Stub plugins load without crashing
- A trivial test plugin with 2 states (`open` / `done`) works end-to-end with the facilitator

### Workstream C — Closure rules + verification logic

**Goal:** No silent closes. Every close cites structural evidence.

**Deliverables:**

- Closure rule table from ADR-0041 §Part 3 implemented in `packages/core/src/governance/closure.ts`
- `closerFor(issueType)` plugin method (default in core; pluggable)
- `verifyClosure()` plugin method (default in core; pluggable)
- Default verification requires at least one of:
  - linked closed issue
  - commit ref to a file change
  - confirmation comment from another named circle member
  - entry written to `governance/agreements/`
- `verification-failed` label re-opens issues that fail verification (with one re-attempt; second failure escalates to Source)
- Boundary 5 validator extended: positive closure verification, not just negative narrative-claim detection

**Dependencies:** Workstream B.

**Acceptance:**

- Test: facilitator closes an issue with each verification path; each succeeds
- Test: facilitator attempts close without evidence; issue re-opens with `verification-failed`
- Test: second `verification-failed` escalates (label + facilitator log entry)

### Workstream D — `done_when` schema in role.md

**Goal:** Machine-checkable agent completion.

**Deliverables:**

- Schema extension in `packages/cli/src/identity/agent-frontmatter.ts` (Zod)
- Per-kind validators in `packages/core/src/done-criteria/{file-committed,issue-closed,...}.ts`
- Variable interpolation: `${self.X}`, `${this.X}`, `{period}` (ISO week / month derived from `cadence`)
- Wake-end validator runs after agent reflection; emits `wake.done_check.discrepancy` event when agent claim ≠ validator finding
- Wake-start aggregator filter excludes accountability items where `done_when` is satisfied
- Per-accountability telemetry: met-rate, last-met-at, partial-met flags

**Dependencies:** Workstream E (aggregator integration).

**Acceptance:**

- All 6 condition kinds have unit tests
- Variable interpolation tested for each variable
- Discrepancy event fires on a mock agent that claims completion incorrectly
- A real EP agent role.md migrated and passes validation

### Workstream E — Priority-tiered signal bundles

**Goal:** Wake budget goes to the right items.

**Deliverables:**

- Tier classifier in `packages/signals/src/priority.ts` (rule table from ADR-0042 §Part 2)
- Bundle composition: critical (cap 5) → high (cap 6) → normal (cap 4) → low (only if budget)
- Wake-start filter: items with satisfied `done_when` excluded
- Priority-bumping: skip-count tracked per agent per item; floor raises by one tier per skip; 2 skips at critical → escalation
- Wake prompt template surfaces budget + tier counts (replaces today's flat "here are 15 issues")
- Subsumes harness#298 (differential bundles) — close issue with cross-reference

**Dependencies:** Workstream D (done_when used by filter).

**Acceptance:**

- Test: classifier returns expected tier for each rule's input
- Test: bundle composition respects caps and budget
- Test: priority bumping applied after a skip; escalation after 2 skips
- Test: completed accountability items excluded from bundle
- A real EP agent's bundle (mocked GitHub state) reflects expected priorities

### Workstream F — Effectiveness metrics surface

**Goal:** Make the targets in §3 observable for any murmuration adopting v0.7.0.

**Deliverables:**

- New dashboard tab in `packages/dashboard-tui/`: per-agent and per-circle closure rate, age distribution, narrative-only-claim trend, cost-per-closed-issue, met-rate per accountability
- Spirit query tools (per fork #3): `list_awaiting_source_close`, `get_facilitator_log`, `get_agreement(slug)`, `close_issue(num, reason)`
- Export: `murmuration metrics --json` for piping into Langfuse/external tools (see ADR-0022)
- Acceptance gate fixture: a synthetic murmuration corpus exercising the metrics path (so the harness can be tagged without depending on any operator's repo state)

**Dependencies:** All other workstreams (metrics consume their outputs).

**Acceptance:**

- Dashboard tab renders the metrics for the synthetic-corpus fixture
- Spirit tool calls return correct data on the fixture
- All metric queries documented in `docs/CONFIGURATION.md` § Metrics

---

## 6. Sequencing

```
Week 1
  ┌── Workstream B (state machine plugin interface) ──── load-bearing prereq ──┐
  │                                                                              │
  └── Workstream D (done_when schema + validators) ─── parallel; foundational ─┘

Week 2
  ┌── Workstream A (facilitator-agent reference impl) ─── depends on B ──────┐
  │                                                                            │
  ├── Workstream C (closure rules + verification) ─── depends on B ──────────┤
  │                                                                            │
  └── Workstream E (priority bundle) ─── depends on D ───────────────────────┘

Week 3
  └── Workstream F (metrics surface) ─── depends on all above ───────────────┘

Week 3-4
  └── End-to-end fixture verification + tag v0.7.0 ───────────────────────────┘
```

Total wall-clock: ~3 weeks of focused harness work.

**Operator-side rollout** (e.g. EP migration, one-time backlog cleanup, per-agent role.md migration) is tracked in operator repos, runs independently, and may begin as soon as Workstreams A–E land on the harness release branch. The harness release does not block on any operator's adoption.

---

## 7. Migration plan (harness only)

- Single PR per workstream A–F, all merged on `feat/v0.7.0-agent-effectiveness` branch
- Branch is the v0.7.0 release candidate; tag from there after fixture verification passes
- No backwards-compatibility shims for the `GovernancePlugin` interface — clean break (per Source decision 2026-05-04). No out-of-tree plugins exist as of writing.
- `done_when` block is **optional in role.md**; agents without it fall back to today's behavior, so existing operator role.md files don't break on harness upgrade.
- `examples/facilitator-agent/` is new; `murmuration init` copies it idempotently — does not overwrite Source-edited files in existing murmurations.

**Operator migration** (separate work, separate repos, separate PRs):

- Adopting operators run their own backlog triage and role.md `done_when` migration in their own repo
- Cleanup of any pre-v0.7.0 issues + label drift is operator-side concern
- Facilitator-agent's first wake should run after backlog is sane, otherwise the daily `[FACILITATOR LOG]` will flood with stale escalations

---

## 8. Success metrics + acceptance

The data baseline below comes from the 2026-05-04 effectiveness audit, captured against one running murmuration. The targets are **what the harness enables for any murmuration adopting v0.7.0** — not a guarantee any individual operator will hit them, but the structural ceiling rises.

| Metric                                                   | Audit baseline | v0.7.0 target (when adopted) |
| -------------------------------------------------------- | -------------- | ---------------------------- |
| Issue-closure rate (non-DIRECTIVE, within 14d of filing) | ~10%           | >50%                         |
| Median open-issue age                                    | 12d            | <7d                          |
| Boundary 5 (narrative-only-claim) per wake               | 1.25           | <0.2                         |
| Wake completion rate                                     | 59%            | >90%                         |
| Cost per closed issue                                    | ~$3.40         | <$1                          |
| `governance/decisions/` entries per closed proposal      | 0              | 1                            |
| `governance/agreements/` registry coverage               | 0              | every active agreement       |
| `[*MEETING]` issue closure rate                          | 0%             | >80% within 7d               |

**Tag-blocking acceptance** (harness side only):

- All 786 existing tests pass; no regressions
- New unit tests per workstream Acceptance sections pass
- Synthetic-corpus fixture (Workstream F) exercises end-to-end facilitator flow with all metrics computed correctly
- A trivial test plugin with 2 states works against the facilitator (proves plugin interface flexibility)

The tag does not block on any specific operator's measured outcomes — those are operator-side observations to track in their own repos.

---

## 9. Testing strategy

- **Unit tests** per workstream as listed in the per-workstream Acceptance sections
- **Integration tests:**
  - Facilitator dry-run against a fixture murmuration with 5 proposals at various states
  - End-to-end "filed → quorum → closed" path with the S3 plugin
  - End-to-end "done_when satisfied → item drops out of bundle" path
- **Live verification fixture:**
  - Synthetic murmuration corpus (test fixture committed to the harness repo) that exercises the full facilitator flow: filed → routed → quorum → closed → decision-logged → agreement-registered
  - Trivial test plugin with 2 states proves plugin interface flexibility
- **Regression:** all 786 existing tests must pass; no regressions in cost record schema or wake event flow

---

## 10. Risks + mitigations

(Synthesized from ADR-0041 §Risks and ADR-0042 §Risks; not duplicated here. See those ADRs.)

Cross-cutting risk: **scope creep into ADR-0040 (live observability) territory.** Mitigation: explicitly out-of-scope in §3; Workstream G builds on whatever telemetry exists today, not a new wake event stream.

Cross-cutting risk: **"big release" cadence loses iterative learning.** Mitigation: each workstream has its own PR, merged to the release branch as it lands; the release tag is the synthesis, not the development unit. Source-visible progress weekly via `[FACILITATOR LOG]` even pre-release.

---

## 11. Tracking issues (harness only)

| Issue       | Workstream | Title                                                        |
| ----------- | ---------- | ------------------------------------------------------------ |
| harness#305 | A          | Facilitator-agent reference implementation in `examples/`    |
| harness#306 | B          | Plugin-owned governance state machine (interface extension)  |
| harness#310 | C          | Closure rules + verification logic                           |
| harness#307 | D          | `done_when` schema in role.md + per-kind validators          |
| harness#308 | E          | Priority-tiered signal bundles (subsumes harness#298)        |
| harness#309 | F          | Effectiveness metrics surface (dashboard tab + Spirit tools) |

**Sister spec — Spec 0002 (Spirit Meta-Agent)** ships in the same v0.7.0 release as workstreams **N–S**: Spirit cross-attach context, memory, murmuration overview, reporting surfaces, per-murmuration skill installation, joint acceptance fixture. Tracked in harness#312–#317. Both specs tag together.

Operator-side adoption work (e.g. backlog cleanup, per-agent role.md migration) is tracked in operator repos and runs in parallel; not blocking the harness release.

---

## 12. Open questions

(Resolved per fork decisions on 2026-05-04 — recorded here for posterity.)

1. **State names in v0.7.0:** Path A short-term (S3 names hardcoded in S3 plugin), Path B long-term (interface flexible enough for any plugin). Resolved: ship S3 only, but interface is fully plugin-owned from day one — see ADR-0041.
2. **Daily facilitator cron:** twice daily (07:00 + 18:00 PT). Morning catches overnight wakes + sets day's agenda; evening synthesizes day's work + surfaces awaiting-Source items.
3. **Source close surface:** `awaiting:source-close` label + Spirit query tool `list_awaiting_source_close`. No separate inbox file.
4. **Agreement registry shape:** per-topic file at `governance/agreements/<topic-slug>.md`.
5. **Closure verification:** structural evidence required — at least one of {linked closed issue, commit ref, confirmation comment, agreement entry}.
6. **EP cleanup batching:** type-batched (`[*MEETING]` → `[PROPOSAL]` → `[TENSION]` → `[other]`).
7. **Metrics surface location:** dashboard tab; later mirrored in TUI / web interface.

---

## 13. Out-of-scope follow-ups (harness)

- Mature versions of stub governance plugins (chain-of-command, meritocratic, consensus, parliamentary) — separate ADRs each
- Wake event stream Layer 2 + 3 (ADR-0040)
- Subscription-CLI streaming output parsing (harness#302) — runs in parallel, non-blocking
- Spirit + daemon session resume (harness#293)
- Langfuse self-reflection wiring (ADR-0022) — depends on this release for `done_when` data feed
- TUI live-wake pane (ADR-0040 Layer 3)
- Web-interface metrics dashboard (mirrors §F surface)

**Operator-side work** (tracked in operator repos, NOT this harness release):

- Per-operator backlog cleanup before facilitator first-run
- Per-agent role.md migration to add `done_when` blocks
- Per-operator metric tracking against the targets in §8
