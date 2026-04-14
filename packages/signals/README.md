# @murmurations-ai/signals

Default `SignalAggregator` for the Murmuration Harness. Composes three
real sources — `github-issue` (via `@murmurations-ai/github`), `private-note`
(filesystem), `inbox-message` (filesystem) — into a single ordered
`SignalBundle` per wake.

Owned by Architecture Agent #23 with an interim trust taxonomy pending
Security Agent #25's harness#4 ratification.

See `docs/adr/0013-signal-aggregator.md` for the full design.

## Why a separate package?

The `SignalAggregator` interface lives in `@murmurations-ai/core` so the
daemon can reference it without depending on any concrete source
package. The default implementation depends on `@murmurations-ai/github`,
and `@murmurations-ai/github` depends on `@murmurations-ai/core`. Putting the
default implementation in its own package breaks the cycle without
weakening the architectural separation.

## Scope (1B-d)

- **Implemented:** `github-issue`, `private-note`, `inbox-message`
- **Deferred:** `pipeline-item`, `governance-round`, `stall-alert` — these
  depend on Phase 2+ infrastructure (pipeline artifacts, governance
  plugin runtime, stall detector).

## Trust taxonomy (interim)

| Source                                  | Default trust  |
| --------------------------------------- | -------------- |
| `github-issue` from trusted scope       | `trusted`      |
| `github-issue` from public repo         | `semi-trusted` |
| `private-note` at `agents/<id>/notes/`  | `trusted`      |
| `inbox-message` (default)               | `semi-trusted` |
| `inbox-message` from allowlisted sender | `trusted`      |

See `packages/core/src/signals/index.ts` for the content-trust
separation convention (body fields are always one step below
metadata trust).
