# Facilitator Agent — reference implementation

The facilitator-agent is the harness's **closure-authority agent**: it
reads governance-typed issues across the murmuration, advances their
state via the active `GovernancePlugin`, and closes them when the
plugin reports a terminal state and closure verification passes.

This example is the canonical reference implementation. `murmuration init`
copies it into every new murmuration's `agents/facilitator-agent/`
directory automatically (idempotent — does not overwrite Source-edited
files in existing murmurations).

## Why facilitator-agent ships in the box

A 5-week effectiveness audit of one production murmuration showed 0%
closure on `[*MEETING]` issues, 7% on `[PROPOSAL]`, and a 78% open-issue
rate. Agents commented but never finished. The structural fix is to
designate one agent with closure authority, give it a daily cadence,
and make the closure rule machine-checkable. See
[ADR-0041](../../docs/adr/0041-facilitator-agent-and-plugin-state-machines.md)
and [docs/specs/0001-agent-effectiveness.md](../../docs/specs/0001-agent-effectiveness.md).

## Layout

```
examples/facilitator-agent/
  agents/facilitator-agent/
    role.md                      # accountabilities + done_when blocks
    soul.md                      # role-specific identity
    prompts/
      wake.md                    # the twice-daily wake prompt
    skills/
      s3-governance.md           # full Sociocracy 3.0 logic
      chain-of-command.md        # interface stub
      meritocratic.md            # interface stub
      consensus.md               # interface stub
      parliamentary.md           # interface stub
  governance/
    groups/
      facilitation.md            # the facilitator's home group
  murmuration/
    soul.md                      # generic single-agent soul for the example
```

## How the skills work

Each `skills/<governance-style>.md` describes the closure logic for one
governance plugin. The facilitator's wake prompt loads the skill matching
the active plugin, so the **role.md and soul.md never need to change**
when an operator switches governance models — only the skill changes.

`s3-governance.md` is the only fully-fleshed-out skill in v0.7.0. The
other four (chain-of-command, meritocratic, consensus, parliamentary)
are interface stubs documenting the contract; their plugin counterparts
in `packages/cli/src/governance-plugins/*/` return `null` from
`computeNextState` until the corresponding skill + plugin pair is
filled in.

## Default cadence

Twice daily by default — `cron: "0 7,18 * * *"`:

- **07:00 PT** triages overnight wakes and sets the day's agenda
- **18:00 PT** synthesizes the day's work and surfaces items for Source

Both runs are idle-skip-aware (per ADR-0040 / harness#297) — when no
governance state has changed since the last successful wake, the
facilitator skips immediately.

## What it writes

On disk:

- `governance/decisions/YYYY-MM-DD.md` — daily decision log entry per
  closed proposal/directive
- `governance/agreements/<topic-slug>.md` — durable agreement registry
  entries for every consented agreement

To GitHub:

- Closure comments (one per closed issue, citing structural evidence)
- The daily `[FACILITATOR LOG] YYYY-MM-DD` synthesis issue listing
  every transition + closure with a one-line justification
- `awaiting:source-close` label on directives requiring Source action
- `verification-failed` label on closure attempts that fail verification
  (one retry; second failure escalates with `awaiting:source-close`)

## Tuning

Source can edit `agents/facilitator-agent/role.md` like any other agent —
adjust the cron, swap the skill, change the budget ceiling. The
facilitator's accountabilities (with their `done_when` blocks) are the
contract; everything else is operator preference.

## See also

- ADR-0041 — facilitator role + plugin-extensible state machines
- ADR-0042 — `done_when` schema + priority-tiered signal bundles
- `packages/core/src/governance/closure.ts` — closure rule + verification
- `packages/core/src/done-criteria/index.ts` — `done_when` validators
