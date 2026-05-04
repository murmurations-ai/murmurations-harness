# Skill: Meritocratic Governance — STUB (v0.7.0)

Loaded by the facilitator-agent when `plugins.governance: "meritocratic"`.

## Status

**Stub.** Interface satisfied; logic deferred. The plugin
(`packages/cli/src/governance-plugins/meritocratic/index.mjs`)
returns `null` from `computeNextState` for every input. Operators
adopting meritocratic governance should treat this skill as a contract
description, not a working implementation, and contribute the
state-machine logic via PR.

## Contract

A working meritocratic skill must explain:

1. **Merit weighting.** How is merit assigned? Track-record? Domain
   expertise? Tenure? Per-decision expert assignment? The plugin
   needs a deterministic weighting function.
2. **State graph.** Typical shape:
   `proposed → expert-review → weighted-vote → decided`. Possibly with
   `expert-review → escalated` for items beyond the assigned experts'
   purview.
3. **Position parsing + weighting.** Each comment carries an implicit
   weight based on the author's merit score. The plugin must compute
   weighted-totals and decide the threshold (e.g. 60% weighted
   approval).
4. **Closure verification.** Plugin verifies the weighted total
   exceeded threshold, and that the experts whose merit applies to
   this decision actually positioned. Harness structural-evidence
   floor still applies.
5. **Merit registry.** Where do merit scores live? Plugin must read
   them from somewhere reproducible — either a committed registry
   file or an out-of-band system.

## What the v0.7.0 stub provides

- Empty `stateGraphs()` return — the plugin loads without crashing.
- `computeNextState` returns null — the facilitator records
  "no transition" for every governance-typed issue.
- `closerFor` returns `undefined` — falls back to harness defaults.
- `verifyClosure` not overridden — harness floor applies.

## Implementation path

When operationalizing this plugin:

1. Decide where merit scores live and how they're updated.
2. Decide the state graph and threshold rule.
3. Implement `computeNextState` — read positions, weight by author
   merit, propose `decided` when threshold met.
4. Implement `verifyClosure` — check weighted threshold + expert
   coverage.
5. Update this skill file.
6. Add tests in
   `packages/cli/src/governance-plugins/meritocratic/index.test.mjs`.

## See also

- ADR-0041 §Part 2 — plugin-extensible state machines
- `examples/facilitator-agent/skills/s3-governance.md` — worked example
