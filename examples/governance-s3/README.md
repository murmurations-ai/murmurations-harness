# Self-Organizing (S3) Governance Plugin

First concrete governance plugin for the Murmuration Harness. Implements [Sociocracy 3.0](https://sociocracy30.org/) patterns.

## Governance model

**Self-Organizing** — distributed authority within circles, consent-based decision-making (no objections = approved), tensions as the universal driver for change.

### State graphs

**Tension:**
```
open → deliberating → consent-round → resolved | withdrawn
```
- 90-day review cadence on resolved tensions
- 7-day timeout on deliberating (escalates to Source)

**Proposal:**
```
drafted → consent-round → ratified | rejected | withdrawn
```
- 90-day review cadence on ratified proposals
- Objections send the proposal back to drafted

### Event kinds

| Kind | Routing |
|---|---|
| `tension` | Source + targeted agent (if any) |
| `proposal-opened` | Source (for consent round initiation) |
| `notify` | Targeted agent (or Source if no target) |
| `autonomous-action` | Source (audit trail) |
| `held` | Source (immediate escalation) |

## Usage

```sh
murmuration start --root ../my-murmuration --governance examples/governance-s3/index.mjs
```

## Phase 1 limitations

- `evaluateAction` allows everything (real consent rounds are Phase 3)
- Governance state store is in-memory (filesystem persistence in #33)
- No timeout enforcement yet (the `timeoutMs` field is declared but the scheduler doesn't auto-fire transitions)
