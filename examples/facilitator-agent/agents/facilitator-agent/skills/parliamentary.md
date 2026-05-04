# Skill: Parliamentary Governance — STUB (v0.7.0)

Loaded by the facilitator-agent when `plugins.governance: "parliamentary"`.

## Status

**Stub.** Interface satisfied; logic deferred. The plugin
(`packages/cli/src/governance-plugins/parliamentary/index.mjs`)
returns `null` from `computeNextState` for every input. Operators
adopting parliamentary governance should treat this skill as a
contract description, not a working implementation, and contribute the
state-machine logic via PR.

## Contract

A working parliamentary skill must explain:

1. **Procedure (Robert's Rules-style).** Motions, seconds, debate,
   amendments, votes. The plugin must encode at minimum the basic
   motion lifecycle.
2. **State graph.** Typical shape:
   `motion-filed → seconded → debating → amended → voting → passed`.
   Alternates: `motion-filed → not-seconded → withdrawn`,
   `voting → defeated`.
3. **Position parsing.** "Aye", "nay", "second", "amend", "table",
   "call the question". The plugin maps comment vocabulary onto
   parliamentary moves.
4. **Vote tally.** Majority, two-thirds, or unanimous depending on
   motion type — operator configures the threshold per motion type.
5. **Closure verification.** Plugin verifies the quorum was present
   (named members positioned, not absent) and the threshold was met.
   Harness structural-evidence floor still applies.

## What the v0.7.0 stub provides

- Empty `stateGraphs()` return.
- `computeNextState` returns null.
- `closerFor` returns `undefined`.
- `verifyClosure` not overridden — harness floor applies.

## Implementation path

When operationalizing:

1. Decide which subset of parliamentary procedure applies (full
   Robert's Rules is overkill for most murmurations; a 4-state
   motion lifecycle usually suffices).
2. Decide threshold per motion type.
3. Implement `computeNextState` — read positions, tally, propose
   transitions.
4. Implement `verifyClosure` — quorum + threshold.
5. Update this skill file.
6. Add tests in
   `packages/cli/src/governance-plugins/parliamentary/index.test.mjs`.

## See also

- ADR-0041 §Part 2 — plugin-extensible state machines
- `examples/facilitator-agent/skills/s3-governance.md` — worked example
