# Skill: Consensus Governance — STUB (v0.7.0)

Loaded by the facilitator-agent when `plugins.governance: "consensus"`.

## Status

**Stub.** Interface satisfied; logic deferred. The plugin
(`packages/cli/src/governance-plugins/consensus/index.mjs`) returns
`null` from `computeNextState` for every input. Operators adopting
consensus governance should treat this skill as a contract description,
not a working implementation, and contribute the state-machine logic
via PR.

## Contract

A working consensus skill must explain:

1. **Consensus rule.** Strict consensus requires every named member
   to consent. Modified consensus allows fall-back to supermajority
   after N rounds. The plugin must encode the operator's chosen rule.
2. **State graph.** Typical shape:
   `proposed → discussing → block-check → consented` with
   `block-check → discussing` on any block.
3. **Position parsing.** Block, stand-aside, consent, modify. Position
   strength matters — a stand-aside is permission to proceed; a block
   stops the round.
4. **Round counter.** If the operator chose modified consensus,
   plugin tracks rounds-attempted on each issue.
5. **Closure verification.** Plugin verifies every named member
   positioned (strict) or that supermajority + round threshold met
   (modified). Harness structural-evidence floor still applies.

## Difference from S3

S3's "no paramount objection" rule is a relaxation of strict consensus.
Strict consensus blocks on any reasoned objection; S3 also requires
the objector to integrate the objection back as an amended proposal
or withdraw. Consensus governance, in its strictest form, simply
returns the proposal to discussion when blocked — no obligation to
integrate.

## What the v0.7.0 stub provides

- Empty `stateGraphs()` return.
- `computeNextState` returns null.
- `closerFor` returns `undefined`.
- `verifyClosure` not overridden — harness floor applies.

## Implementation path

When operationalizing:

1. Decide strict vs. modified consensus + the round threshold.
2. Decide the state graph.
3. Implement `computeNextState` — read positions, check coverage,
   propose transitions.
4. Implement `verifyClosure` — coverage + round threshold.
5. Update this skill file.
6. Add tests in
   `packages/cli/src/governance-plugins/consensus/index.test.mjs`.

## See also

- ADR-0041 §Part 2 — plugin-extensible state machines
- `examples/facilitator-agent/skills/s3-governance.md` — worked example
