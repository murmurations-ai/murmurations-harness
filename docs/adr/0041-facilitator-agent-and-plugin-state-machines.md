# ADR-0041 — Facilitator-agent role and plugin-extensible governance state machines

- **Status:** Proposed
- **Date:** 2026-05-04
- **Decision-maker(s):** Source (Nori), Engineering Circle
- **Driver:** 2026-05-04 effectiveness audit of a production murmuration — over 5 weeks of operation, 0% of `[*MEETING]` issues closed, 7% of `[PROPOSAL]` issues closed, 78% of all issues open, median age 12d. Agents comment but never finish. The pattern is structural to the harness, not specific to any operator. See `docs/specs/0001-agent-effectiveness.md` for the data.
- **Related:** ADR-0009 (governance plugin interface), ADR-0011 (cost record schema), ADR-0029 (self-digest tail-cap), ADR-0040 (wake event stream).

## Context

Today the harness has the machinery for governance state — `GovernanceStateStore`, `GovernanceStateGraph`, `GovernancePlugin` interface — but no agent operationalizes it. State transitions happen passively as side effects of agent comments; **nothing closes issues, nothing detects quorum, nothing writes the decision log, nothing surfaces "this is awaiting Source close"**. Every consent round runs forever. Meetings open and never end. The accountability for "wrap up the round" sits on circle leads who have no time.

Two distinct gaps need addressing in one ADR because they're load-bearing on each other:

1. **No agent runs the state machine.** Without an operator of the state machine, the data model exists but nothing acts on it.
2. **The state machine itself is hardcoded around the harness's expectations of what "governance state" means.** Today's `GovernanceStateGraph` enumerates states like `open`, `closed`, `consenting` — implicitly biasing toward S3-style consent. A meritocratic plugin that wants states like `weighted-vote-open`, `expert-review`, `decided-by-majority` has no place to put them. We need to ship facilitator-agent in a way that doesn't bake the S3 bias into the harness core.

## Decision (proposed)

We introduce a **facilitator-agent role** with closure authority, and we make the **governance state machine fully plugin-owned**.

### Part 1 — Facilitator-agent role

A new agent role (reference impl in `examples/facilitator-agent/`, copied as default into every murmuration via `murmuration init`) responsible for the procedural close-out of governance and operational work.

**Accountabilities:**

- Read all `[PROPOSAL]`, `[DIRECTIVE]`, `[TENSION]`, `[*MEETING]` issues each wake
- Advance each issue's state via `GovernancePlugin` based on observable conditions (named participants having positioned, quorum reached, objections integrated, named blockers resolved)
- **Close issues** when the plugin's state machine reports a terminal state AND closure verification passes (see ADR-0042 §closure rules)
- Apply `awaiting:source-close` label to issues where a Source-only closure is required (`[DIRECTIVE]` is the canonical case)
- Write decision log entries to `governance/decisions/YYYY-MM-DD.md` for each closed proposal/directive
- Write/update agreement registry entries to `governance/agreements/<topic-slug>.md` for each consented agreement
- File the daily synthesis: `[FACILITATOR LOG] YYYY-MM-DD` summarizing transitions, closures, and items needing Source attention
- Set agendas for circle meetings by querying the state machine and listing items at each state per circle

**Authority surface:**

- Read all governance-tagged issues across the murmuration
- Comment on any issue with structured close/transition messages
- Apply/remove labels (close-related: `awaiting:source-close`, `closed-stale`, `closed-superseded`, `closed-resolved`, `verification-failed`)
- Close issues per closure rules (ADR-0042)
- Write under `governance/decisions/`, `governance/agreements/`, and one rolling log file
- Queue notifications to other agents via `assigned:` label additions on follow-up issues it files

**Wake schedule:** twice daily by default — `cron: "0 7,18 * * *"` (07:00 to triage overnight wakes + set day's agenda; 18:00 to synthesize the day and surface items for Source). Both runs may be skipped by the idle-skip path (ADR-0040 / harness#297) when state hasn't changed.

**Default in every murmuration:** `murmuration init` copies `examples/facilitator-agent/` into `agents/facilitator-agent/`. Source can edit role.md, but facilitator-agent is always present. This makes the closure-authority guarantee universal: every murmuration ships with a working facilitator out of the box.

### Part 2 — Plugin-owned state machines

The governance state machine becomes **fully plugin-owned**. The harness core defines the _interface_ (state names are opaque strings, transitions defined by the plugin); plugins contribute their own state graphs, transition logic, and closure conditions.

**Interface extensions to `GovernancePlugin`:**

```typescript
export interface GovernancePlugin {
  // existing surface...

  /**
   * The plugin's state graph. Returns the full set of valid states
   * and transition rules. State names are arbitrary strings; the
   * harness does not interpret them. Plugins MUST include at least
   * one terminal state (where canClose returns true).
   */
  stateGraph(): GovernanceStateGraph;

  /**
   * Compute the next state for a governance item given its current
   * state, the issue's comment thread, and the circle's named
   * member list. Returns null when no transition applies.
   *
   * This is the workhorse the facilitator calls on every wake.
   */
  computeNextState(input: {
    readonly currentState: string;
    readonly issue: IssueSnapshot;
    readonly circleMembers: readonly AgentId[];
  }): Promise<{ next: string; reason: string } | null>;

  /**
   * Whether a given state is terminal (closeable). Plugin-defined.
   * S3: { resolved: true, withdrawn: true }
   * Chain-of-Command: { decided: true, vetoed: true }
   * Meritocratic: { weighted-vote-decided: true }
   */
  isTerminal(state: string): boolean;

  /**
   * Optional: produce the human-readable agenda block for a circle
   * meeting given the current state machine snapshot. Plugins can
   * specialize this; if absent, the harness produces a generic list.
   */
  buildAgenda?(input: {
    readonly circleId: string;
    readonly openItems: readonly { issue: IssueSnapshot; state: string }[];
  }): string;

  /**
   * Optional: closure verification logic specific to the governance
   * style. The harness always requires structural change evidence
   * (commit ref / linked closed issue / confirming comment / agreement
   * entry); plugins can add additional checks (e.g. consent quorum
   * threshold, expert weighting, majority vote tally).
   */
  verifyClosure?(input: {
    readonly issue: IssueSnapshot;
    readonly state: string;
    readonly evidence: ClosureEvidence;
  }): { ok: true } | { ok: false; reason: string };
}
```

**`GovernanceStateGraph` becomes plugin-defined:**

```typescript
export interface GovernanceStateGraph {
  /** All valid states. First entry is the initial state for new items. */
  readonly states: readonly string[];
  /** Allowed transitions: (from, to) pairs. */
  readonly transitions: readonly { from: string; to: string }[];
  /** Display order for agendas, dashboards. */
  readonly displayOrder?: readonly string[];
}
```

**v0.7.0 ships only the S3 plugin's state graph fully implemented.** Stubs for chain-of-command, meritocratic, consensus, parliamentary go in `examples/governance-plugins/` with the interface satisfied but `computeNextState` returning null pending design work. Future plugins implement to the same interface; the facilitator-agent code never changes.

**S3 plugin state graph (for reference, this is what ships):**

```
filed → routed → in_round → quorum_check
                          → consenting (terminal)
                          → amended (terminal)
                          → objected (back to in_round with integration tasks)
                          → withdrawn (terminal)
                          → stale (terminal — facilitator escalates to Source)
```

State names live entirely in the S3 plugin. The harness sees only opaque strings.

### Part 3 — Closure rule table (governance-agnostic core)

The harness defines who can close what; the rule set is read from the `GovernancePlugin` so plugins can override. Default rules:

| Issue type              | Default closer                                         | Closure path                                                                                             |
| ----------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `[TENSION]`             | Original filer-agent                                   | When filer comments closure with verification evidence; facilitator confirms and closes if filer doesn't |
| `[PROPOSAL]`            | Facilitator-agent                                      | After plugin reports terminal state + closure verification passes                                        |
| `[*MEETING]`            | Facilitator-agent                                      | After all agenda items advance state                                                                     |
| `[DIRECTIVE]`           | Source                                                 | Facilitator labels `awaiting:source-close`, Source closes via Spirit/CLI                                 |
| `[other]` (operational) | Primary-responsible agent (named in `assigned:` label) | When agent posts a "done check" comment with verification                                                |

Plugins can override the default closer via `GovernancePlugin.closerFor(issueType): "facilitator" | "source" | "filer" | "responsible"`.

## Considered Options

1. **Single hardcoded state machine + facilitator-agent.** Ship S3-state names in the harness core. Faster.
   _Rejected: violates ADR-0009's governance-agnostic-core principle. We'd have to refactor when the next plugin lands. The audit driver explicitly named this risk._

2. **Facilitator-agent only, no state machine refactor.** Operationalize the existing `GovernanceStateStore` as-is.
   _Rejected: the existing store already bakes S3-shaped states into the harness core. Operationalizing it deepens the entanglement._

3. **Plugin-owned state machine, no facilitator-agent.** Make the interface flexible but expect each murmuration to write its own facilitator.
   _Rejected: the audit data shows EP went 5 weeks without writing one. Defaults matter; facilitator-agent must ship in the box._

4. **Single facilitator + plugin-owned state machine** (chosen).

## Consequences

**Easier:**

- Closure rate ceiling goes from ~10% to >50% (within 14d of filing) for any adopting murmuration.
- Source's manual close burden drops to genuine `[DIRECTIVE]` review only — everything else closes itself when state and evidence agree.
- Decision log + agreement registry give Source a durable, addressable record without writing each one by hand.
- Operationally untangles the harness from S3 — meritocratic / chain-of-command / etc. plugins can ship without harness changes.
- Future facilitator skills (`skills/<governance-style>.md`) become the unit of governance-style adoption. Source picks a plugin, the matching skill loads, the facilitator role.md doesn't change.

**Harder:**

- Adopting operators must add `done_when` blocks to existing role.md files (handled in ADR-0042). Real but bounded operator-side work; opt-in (default fallback preserves today's behavior).
- Closure authority is a real shift. We add a `awaiting:source-close` label + Spirit query so Source has a clear surface, but agents-closing-issues is new and will have edge cases.
- Plugin interface is now larger. Each governance plugin must implement `stateGraph`, `computeNextState`, `isTerminal`. Existing S3 plugin needs to absorb closure logic from the harness core.
- Operators carrying a pre-v0.7.0 backlog need their own cleanup pass before the facilitator's first wake (otherwise the daily `[FACILITATOR LOG]` floods with stale escalations). Operator-side work, tracked in operator repos.

**Reversibility:** Medium. The facilitator-agent role can be disabled by removing `agents/facilitator-agent/` (then no closures happen automatically). Plugin interface changes are breaking for any out-of-tree plugin (none exist as of 2026-05-04).

## Risks

- **R1: Closure-without-change.** Facilitator closes an issue but nothing actually changed. Mitigation: closure verification rule (must cite commit ref / linked closed issue / confirming comment / agreement entry). `verification-failed` label re-opens.
- **R2: Source surprise.** Source comes back from a weekend and finds the facilitator closed 30 things. Mitigation: daily `[FACILITATOR LOG]` issue lists every closure with one-line justification. Source can re-open any closure.
- **R3: Plugin interface drift.** The `GovernancePlugin` surface grows; each new method risks breaking existing plugins. Mitigation: all new methods optional with sensible defaults in the harness; only `stateGraph` + `computeNextState` + `isTerminal` are required.
- **R4: Stale escalation flood on first run.** Operators with a long-lived pre-v0.7.0 backlog will see the facilitator's first wake flag dozens of items as stale. Mitigation: documented operator-side prerequisite — clean up backlog before enabling facilitator. The harness ships the rule; operators sequence the rollout.

## Definition of done

- [ ] `examples/facilitator-agent/` reference implementation with role.md + skills/s3-governance.md
- [ ] `skills/chain-of-command.md`, `meritocratic.md`, `consensus.md`, `parliamentary.md` stubs (interface satisfied, logic deferred)
- [ ] `GovernancePlugin` interface extended with `stateGraph`, `computeNextState`, `isTerminal`, optional `buildAgenda` + `verifyClosure` + `closerFor`
- [ ] S3 plugin updated to satisfy the new interface fully
- [ ] Existing `GovernanceStateStore` refactored to read state names from the plugin (no S3-specific names in harness core)
- [ ] Facilitator default-included by `murmuration init`
- [ ] `awaiting:source-close` label semantics + Spirit query tool
- [ ] `governance/decisions/` and `governance/agreements/` writers
- [ ] `[FACILITATOR LOG]` daily synthesis issue
- [ ] Tests covering: state transitions, closure verification, plugin interface conformance, stub plugins return null without crashing
- [ ] Documentation updated in `docs/ARCHITECTURE.md` § Governance, `docs/CONFIGURATION.md` § agents.facilitator
