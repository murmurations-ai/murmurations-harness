# Skill: Chain-of-Command Governance — STUB (v0.7.0)

Loaded by the facilitator-agent when `plugins.governance: "chain-of-command"`.

## Status

**Stub.** Interface satisfied; logic deferred. The plugin
(`packages/cli/src/governance-plugins/chain-of-command/index.mjs`)
returns `null` from `computeNextState` for every input. Operators
adopting chain-of-command governance should treat this skill as a
contract description, not a working implementation, and contribute the
state-machine logic via PR.

## Contract

A working chain-of-command skill must explain:

1. **The chain.** Who reports to whom. Decisions flow down; objections
   flow up. The harness needs to know which agents are commanders,
   which are reports, and which decisions belong at which level.
2. **State graph.** Typical shape: `proposed → reviewing → decided`
   with `decided → vetoed` as an alternate terminal. Approval comes
   from the next level up; veto can come from any superior level.
3. **Position parsing.** What does "approve" or "execute" look like in
   issue comments? The harness's S3 skill uses keyword matching;
   chain-of-command can do the same with its own vocabulary.
4. **Closure verification.** Plugin must verify the closer is the
   correct level in the chain (the next-level-up agent or a higher
   authority). Harness structural-evidence floor still applies.
5. **Override pattern.** What does "Source override" look like? The
   plugin and skill must agree on how Source's intervention is
   represented in the issue thread.

## What the v0.7.0 stub provides

- Empty `stateGraphs()` return — the plugin loads without crashing.
- `computeNextState` returns null — the facilitator records
  "no transition" for every governance-typed issue.
- `closerFor` returns `undefined` — falls back to harness defaults
  (filer, facilitator, source per type).
- `verifyClosure` not overridden — harness floor applies.

This means the facilitator can boot against the chain-of-command
plugin without errors but won't advance any state automatically. Every
decision requires a human filing closure manually.

## Implementation path

When operationalizing this plugin:

1. Decide the state graph (states + transitions).
2. Decide the comment vocabulary (what words in a comment imply
   "approve", "execute", "veto").
3. Implement `computeNextState` — read comments authored by the
   correct level in the chain, propose transitions accordingly.
4. Implement `verifyClosure` — check the closer is at or above the
   issue's required level.
5. Update this skill file with the worked-out logic.
6. Add tests in
   `packages/cli/src/governance-plugins/chain-of-command/index.test.mjs`.

## See also

- ADR-0041 §Part 2 — plugin-extensible state machines
- `examples/facilitator-agent/skills/s3-governance.md` — worked example
  of a fully-fleshed-out skill
