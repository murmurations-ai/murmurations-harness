# Architecture Decision Records

This directory holds the ADR log for the Murmuration Harness monorepo.

## Format

We use a lightweight [MADR](https://adr.github.io/madr/)-inspired template:

```markdown
# ADR-NNNN — Title

- **Status:** Proposed | Accepted | Superseded by ADR-MMMM | Deprecated
- **Date:** YYYY-MM-DD
- **Decision-maker(s):** Agent #N, Agent #M
- **Consulted:** Agent #K (non-blocking input)

## Context

What is the forcing function? What constraints are in play?

## Decision

What we are actually doing.

## Consequences

What this makes easier, what it makes harder, and the reversibility
cost if we need to undo it.

## Alternatives considered

What else we looked at and why we chose this instead.
```

## Numbering

Numbers are monotonically increasing and never reused. If an ADR is
superseded, update its `Status` field to point at the successor; do
not delete or renumber.

## Phase 0 → Phase 1 migration note

Per the Architecture Agent #23 carry-forward from Issue #241, Phase 0
architectural decisions recorded as governance decision files at
`xeeban/emergent-praxis:governance/decisions/` migrate to this folder
once the monorepo scaffold lands — preserving numbering. ADRs 0001
through 0007 in this folder are **retroactive** documentation of
decisions made during Phase 0 + Phase 1A, authored during Phase 1B
per the Engineering Lead #22 gate review ([issue #6](https://github.com/murmurations-ai/murmurations-harness/issues/6)).

## Index

| #                                                | Title                                                                                        | Status   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------- | -------- |
| [ADR-0001](./0001-pnpm-workspaces.md)            | Use pnpm workspaces for monorepo management                                                  | Accepted |
| [ADR-0002](./0002-typescript-strict-baseline.md) | TypeScript strict mode baseline with noUncheckedIndexedAccess and exactOptionalPropertyTypes | Accepted |
| [ADR-0003](./0003-esm-module-system.md)          | ESM module system (`"type": "module"`) across all packages                                   | Accepted |
| [ADR-0004](./0004-monorepo-layout.md)            | Monorepo layout: `packages/*` workspace glob, package-per-responsibility                     | Accepted |
| [ADR-0005](./0005-errors-as-values-executor.md)  | Errors-as-values at the AgentExecutor boundary                                               | Accepted |
| [ADR-0006](./0006-branded-primitives.md)         | Branded primitive types for identifiers (AgentId, CircleId, WakeId, handles)                 | Accepted |
| [ADR-0007](./0007-phase-1a-stdio-protocol.md)    | Phase 1A subprocess stdio output protocol (`::wake-summary::`, `::governance::<kind>::`)     | Accepted |
| [ADR-0008](./0008-test-framework.md)             | Test framework: Vitest                                                                       | Accepted |
| [ADR-0009](./0009-lint-format.md)                | Lint + format: ESLint flat config + Prettier                                                 | Accepted |
