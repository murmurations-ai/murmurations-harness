---
name: governance-models
description: Governance plugins, state graphs, group meetings, decision records
triggers:
  - governance
  - circle meeting
  - consent round
  - ratify a proposal
  - governance state
  - decision record
  - convene a meeting
  - how governance works
version: 1
---

# Governance models

The harness is governance-model-agnostic. It defines a pluggable boundary — `GovernancePlugin` — that any model can implement. Five reference plugins ship under `examples/governance-*/`: S3 (self-organizing), command, consensus, meritocratic, parliamentary.

## How a plugin fits

Plugins are **decision-makers, not actors**:

- `stateGraphs()` — declares the state machine for each item kind (e.g. S3: tension → deliberating → consent-round → resolved)
- `onEventsEmitted(batch, reader)` — after a wake, plugin sees emitted governance events, returns routing decisions. If the plugin wants an item created, it attaches `create: { kind, payload }` to the decision; the daemon applies it (ADR-0024 §5 — plugins cannot forge `createdBy`)
- `evaluateAction(agentId, action, context, reader)` — go/no-go ruling before a consequential action
- `onTransition?(item, transition)` — optional side-effect-free notification
- `onDaemonStart?(store)` / `onDaemonStop?()` — lifecycle

The `reader` passed to `onEventsEmitted` / `evaluateAction` is a runtime read-only proxy (see `makeGovernanceStateReader` in `packages/core/src/governance/index.ts`). Plugins cannot mutate state from these hooks even via runtime cast.

## Terminology

Governance models use different words for the same concepts. The plugin provides display terms via `GovernanceTerminology`:

| Internal | S3      | Command   | Consensus | Meritocratic | Parliamentary |
| -------- | ------- | --------- | --------- | ------------ | ------------- |
| group    | circle  | unit      | assembly  | guild        | committee     |
| item     | tension | directive | proposal  | flag         | motion        |
| event    | tension | report    | concern   | flag         | motion        |

In code, always use `group` / `item`. In CLI output and meeting minutes, the plugin's terminology appears.

## Group meetings

`murmuration convene --group <id>` convenes a meeting:

- **Operational** (default) — the circle works through its backlog
- **`--governance`** — pending governance items only; emits consent tallies
- **`--retrospective`** — retrospective metrics; no action items
- **`--directive "<msg>"`** — Source gives the agenda; becomes the sole agenda item
- **`--agenda "<title>: <desc>"`** — same as directive but framed as "agenda"

Meeting minutes post as a GitHub issue (or local item when `collaboration.provider: local`) with labels `[group-meeting|governance-meeting, group:<id>]`. If the collaboration provider is down, minutes are saved locally at `.murmuration/runs/group-<id>/<date>/meeting-*.md`.

## State persistence

- `<root>/.murmuration/governance/items.jsonl` — one line per item, rewritten on every mutation. On daemon restart the store `load()`s this file.
- `<root>/.murmuration/governance/decisions/<item-id>.md` — durable record written when an item reaches a terminal state.

## Governance timeouts

Transitions with a `timeoutMs` auto-fire after elapsed time in the `from` state. The daemon re-arms timers on every transition and at boot (for restored items). Timeouts are not persistent across daemon restarts — they reset on boot. This is tracked as issue #35 (future design).

## Running a consent round

From the REPL:

```
:convene <group-id> governance
```

The group meeting agenda is derived from pending governance items. Each member contributes a position (consent / objection / abstain). The facilitator tallies; the daemon transitions items to their terminal state based on the plugin's rules. Decision records are written.

The Spirit can convene meetings via the `convene` tool, but only on operator confirmation — meetings spend the operator's LLM budget.
