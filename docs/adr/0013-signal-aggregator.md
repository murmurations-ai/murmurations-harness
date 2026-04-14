# ADR-0013 — SignalAggregator v0.1, interim trust taxonomy, `@murmurations-ai/signals` package

- **Status:** Accepted (interim trust taxonomy)
- **Date:** 2026-04-09 (landed in commit `1B-d`)
- **Decision-maker(s):** Architecture Agent #23 (authored the design), Engineering Circle
- **Consulted:** Security Agent #25 (interim trust rules pending harness#4), TypeScript / Runtime Agent #24 (GithubClient contract), Performance / Observability Agent #27 (cost integration)
- **Closes:** Phase 1B step B4 from `docs/PHASE-1-PLAN.md`
- **Supersedes:** the Phase 1A stub at `packages/core/src/signals/index.ts`

## Context

Spec §7.1 step 2 describes the wake loop assembling a signal bundle
from "GitHub, pipeline state, inbox, private notes, governance
rounds, and stall alerts" for the agent to reason over. The Phase 1A
daemon hardcoded an empty bundle; the signal aggregator is the
component that fills it.

Two architectural decisions constrained the design:

1. **Topology.** Spec §4.1 calls the aggregator "core, not pluggable."
   We still wanted an interface (for tests, for future alternate
   implementations) but without exposing the source-plugin contract
   before it's been validated.
2. **Dependency direction.** The default aggregator needs
   `@murmurations-ai/github` (for the github-issue source), and
   `@murmurations-ai/github` depends on `@murmurations-ai/core` (for
   `SecretValue`). If the default aggregator lived in `@murmurations-ai/core`
   we'd have a package cycle (`core → github → core`).

## Decision

### Package split

- **`SignalAggregator` interface** + `SignalAggregationContext`,
  `SignalAggregationResult`, `SignalAggregatorError`,
  `SignalAggregatorCapabilities`, `SignalSourceId` live in
  `@murmurations-ai/core/src/signals/index.ts`. The daemon references
  only the interface.
- **`DefaultSignalAggregator`** and `GithubSignalScope`,
  `AggregatorCaps`, and the text-hygiene helpers live in a NEW
  workspace package `@murmurations-ai/signals` that depends on both
  `@murmurations-ai/core` (for the interface and `Signal` types) and
  `@murmurations-ai/github` (for `GithubClient`). **This breaks the
  cycle** without weakening the architectural separation.
- CLI / daemon wiring happens at the composition root
  (`packages/cli/src/boot.ts`). The `Daemon` class only knows about
  the interface.

### Source implementation matrix (1B-d)

| Source             | Status      | Rationale                                                                                                  |
| ------------------ | ----------- | ---------------------------------------------------------------------------------------------------------- |
| `github-issue`     | Implemented | Uses `@murmurations-ai/github`; the only external source live in Phase 1B.                                 |
| `private-note`     | Implemented | On-disk filesystem walk of `agents/<id>/notes/*.md`; trivially trusted; continuity surface from spec §7.1. |
| `inbox-message`    | Implemented | Filesystem walk of `agents/<id>/inbox/*.md`; required by spec §7.1.                                        |
| `pipeline-item`    | Not in 1B-d | Depends on `.pipeline/<issue>/*.yaml` reader — Phase 2 infrastructure.                                     |
| `governance-round` | Not in 1B-d | Depends on Governance Plugin Runtime (harness#2) — Phase 3.                                                |
| `stall-alert`      | Not in 1B-d | Depends on a health checker — not yet scoped.                                                              |

The deferred sources are not stubbed as no-op classes in 1B-d
(scope minimization) — they become additive when their underlying
infrastructure exists.

### Caps, ordering, text hygiene

- **Total cap:** 50 signals per wake.
- **Per-source caps:** 15 github-issue, 10 private-note, 10 inbox-message.
- **Ordering within source:** github by `updatedAt` desc, private-note
  by mtime desc (freshest first), inbox-message by mtime asc (FIFO).
- **Concatenation order:** `[github-issue..., private-note..., inbox-message...]`.
- **Text hygiene:** excerpts (github, inbox) capped at 500 chars;
  summaries (private-note) capped at 300 chars. Control characters
  (C0 range except `\n\r\t`) are stripped from all free-form content
  before emission. This is the minimum defensive scrub against
  adversarial payloads hiding instructions in control chars.

### Interim trust taxonomy

Uses the existing `SignalTrustLevel` values already exported from
`execution/index.ts` (`trusted | semi-trusted | untrusted | unknown`).

| Source                                                 | Default trust  |
| ------------------------------------------------------ | -------------- |
| `github-issue` from a scope marked `trusted`           | `trusted`      |
| `github-issue` from any other scope                    | `semi-trusted` |
| `private-note` at `agents/<self>/notes/` (sandbox ok)  | `trusted`      |
| `inbox-message` (default)                              | `semi-trusted` |
| `inbox-message` from `trustedSenderAgentIds` allowlist | `trusted`      |
| Sandbox-escape or unparsable                           | drop + warn    |

This is an **interim** taxonomy pending Security #25's harness#4
ratification. The `SignalAggregator` interface does not change when
Security #25 ships the authoritative taxonomy — only the rule table.

### Content-trust separation (prompt-injection seam)

**Decision: the aggregator owes the executor a contract; the `Signal`
type is NOT extended with a second trust field.**

Rationale:

- `Signal` already shipped in A1 and is consumed by the executor.
- Adding a required `bodyTrust` field is breaking; an optional one
  invites drift.
- Prompt-injection defense is fundamentally a prompt-framing problem,
  not a signal-shape problem; the real fix lives downstream when the
  executor hands content to an LLM.

The contract, documented in JSDoc on the `SignalAggregator` interface:

> Every signal's top-level `trust` describes its **metadata** only
> (number, title, labels, timestamps, URLs). Free-form user content
> fields (`excerpt`, `summary`) must be treated by downstream
> consumers **one step lower** than metadata trust:
>
> - `trusted` → body is `semi-trusted`
> - `semi-trusted` → body is `untrusted`
> - `untrusted` → body is `untrusted`
> - `unknown` → body is `unknown`

The aggregator enforces its end of this contract by bounding excerpt
length and scrubbing control characters.

### Daemon integration

`DaemonConfig` gains an optional `signalAggregator?: SignalAggregator`
field. `buildSpawnContext` becomes async; if an aggregator is
configured it is awaited and the result threaded into
`AgentSpawnContext.signals`. On aggregator failure the daemon logs
`daemon.wake.aggregator.error` and proceeds with an empty bundle —
an agent with zero signals is still a valid wake.

The Phase 1A no-aggregator code path is preserved verbatim; all
existing daemon tests pass unchanged.

## Consequences

### Positive

- `Signal` type is stable — zero breaking changes.
- Package cycle avoided via the split.
- Interim trust taxonomy is forward-compatible with the authoritative
  one Security #25 will ratify.
- Content/metadata trust separation documented at the interface level
  so downstream consumers (executor, LLM clients) have a clear
  contract.
- Backwards compat: existing tests pass without the aggregator.
- Source-level failures degrade gracefully into warnings; no source
  is a single point of failure for the whole wake.

### Negative

- A new workspace package is a small operational cost (more
  tsconfig references, more publish targets when we get there).
- The `SignalSource` contract is package-private; promoting it to
  public later is a semver-minor when a real need surfaces.
- Interim trust taxonomy will be reworked when harness#4 lands.
  Accepted; the rework touches the mapping table, not the interface.

### Follow-ups

- **CF-signals-A** — Replace interim trust taxonomy with Security
  #25's harness#4 ratified taxonomy.
- **CF-signals-B** — Inbox read-cursor design (no "unread vs read"
  in 1B-d; every wake re-reads the whole inbox capped).
- **CF-signals-C** — `githubScopes` → optional `role.md` frontmatter
  override once an agent needs bespoke repo sets.
- **CF-signals-D** — Real pipeline-item / governance-round /
  stall-alert sources when their underlying infrastructure lands.
- **CF-signals-E** — Multi-page GitHub fetch with cursor pagination.
- **CF-signals-F** — Governance ratification of the inbox filename
  convention (`<from-agent-id>__<iso-timestamp>__<slug>.md`).
- **CF-signals-G** — Promote `SignalSource` to public if adopters
  need to author their own sources.

## Alternatives considered

- **Put `DefaultSignalAggregator` in `@murmurations-ai/core/signals`
  directly.** Rejected: creates a `core → github → core` package
  cycle.
- **Structural typing on `GithubClient` in core to avoid the cycle.**
  Rejected: duplicates the github client's type surface in core and
  invites drift.
- **Add `bodyTrust` to the `Signal` type.** Rejected: breaking
  change to an interface that already shipped; the JSDoc contract is
  sufficient for the prompt-framing responsibility downstream.
- **Implement all six sources in 1B-d.** Rejected: three of them
  depend on Phase 2/3 infrastructure that doesn't exist.
