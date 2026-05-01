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

**Before authoring a new ADR**, an author (human or agent) MUST:

1. Read this index and skim filenames in `docs/adr/` to confirm no
   existing ADR already covers the topic. If one does, propose an
   amendment or a successor that explicitly supersedes it — do not
   start a fresh ADR on the same decision.
2. Pick the next number as `max(existing_number) + 1`. Run
   `ls docs/adr/ | sort | tail -5` if unsure. Never reuse a number.
3. If the topic appears in `UPCOMING.md`, remove that entry as part
   of the same PR.

This rule exists because on 2026-04-26, parallel autonomous wakes of
the same agent independently authored 13 colliding ADRs at numbers
0001–0004 (since deduplicated to 0030–0033). A pre-flight check
costs nothing; a number collision costs a renumber PR.

## Phase 0 → Phase 1 migration note

Per the Architecture Agent #23 carry-forward from Issue #241, Phase 0
architectural decisions recorded as governance decision files at
`xeeban/emergent-praxis:governance/decisions/` migrate to this folder
once the monorepo scaffold lands — preserving numbering. ADRs 0001
through 0007 in this folder are **retroactive** documentation of
decisions made during Phase 0 + Phase 1A, authored during Phase 1B
per the Engineering Lead #22 gate review ([issue #6](https://github.com/murmurations-ai/murmurations-harness/issues/6)).

## Index

| #                                                                         | Title                                                                                                    | Status   |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------- |
| [ADR-0001](./0001-pnpm-workspaces.md)                                     | Use pnpm workspaces for monorepo management                                                              | Accepted |
| [ADR-0002](./0002-typescript-strict-baseline.md)                          | TypeScript strict mode baseline with noUncheckedIndexedAccess and exactOptionalPropertyTypes             | Accepted |
| [ADR-0003](./0003-esm-module-system.md)                                   | ESM module system (`"type": "module"`) across all packages                                               | Accepted |
| [ADR-0004](./0004-monorepo-layout.md)                                     | Monorepo layout: `packages/*` workspace glob, package-per-responsibility                                 | Accepted |
| [ADR-0005](./0005-errors-as-values-executor.md)                           | Errors-as-values at the AgentExecutor boundary                                                           | Accepted |
| [ADR-0006](./0006-branded-primitives.md)                                  | Branded primitive types for identifiers (AgentId, CircleId, WakeId, handles)                             | Accepted |
| [ADR-0007](./0007-phase-1a-stdio-protocol.md)                             | Phase 1A subprocess stdio output protocol (`::wake-summary::`, `::governance::<kind>::`)                 | Accepted |
| [ADR-0008](./0008-test-framework.md)                                      | Test framework: Vitest                                                                                   | Accepted |
| [ADR-0009](./0009-lint-format.md)                                         | Lint + format: ESLint flat config + Prettier                                                             | Accepted |
| [ADR-0010](./0010-secrets-provider-interface.md)                          | SecretsProvider interface and dotenv default provider                                                    | Accepted |
| [ADR-0011](./0011-cost-record-schema.md)                                  | WakeCostRecord schema and cost instrumentation plumbing                                                  | Accepted |
| [ADR-0012](./0012-github-client.md)                                       | @murmurations-ai/github — native fetch, SecretValue auth, per-call cost hook                             | Accepted |
| [ADR-0013](./0013-signal-aggregator.md)                                   | SignalAggregator v0.1 with interim trust taxonomy (pending harness#4)                                    | Accepted |
| [ADR-0014](./0014-llm-client.md)                                          | @murmurations-ai/llm four-provider client (Gemini P0, Anthropic, OpenAI, Ollama)                         | Accepted |
| [ADR-0015](./0015-pricing-catalog.md)                                     | Per-provider LLM pricing catalog populating WakeCostRecord.llm.costMicros                                | Accepted |
| [ADR-0016](./0016-role-template.md)                                       | Extended role.md frontmatter for real agents (provider pin, scopes, budget, prompt ref)                  | Accepted |
| [ADR-0017](./0017-github-mutations.md)                                    | @murmurations-ai/github mutation surface (comment, commit-on-branch, issue) with write-scope enforcement | Accepted |
| [ADR-0018](./0018-cli-tmux-interface.md)                                  | CLI tmux-style interface and parity contract (leader keys, protocol.ts, batch verbs)                     | Proposed |
| [ADR-0019](./0019-persistent-context-agents.md)                           | Persistent context agents (long-running conversation windows across wakes)                               | Proposed |
| [ADR-0020](./0020-vercel-ai-sdk-migration.md)                             | Replace custom LLM adapters with Vercel AI SDK                                                           | Accepted |
| [ADR-0021](./0021-collaboration-provider-abstraction.md)                  | Abstract collaboration layer behind a pluggable provider interface                                       | Accepted |
| [ADR-0022](./0022-langfuse-agent-self-reflection.md)                      | Langfuse-powered agent self-reflection and continuous improvement                                        | Accepted |
| [ADR-0023](./0023-extension-system.md)                                    | Extension system compatible with OpenClaw plugins                                                        | Accepted |
| [ADR-0024](./0024-spirit-of-the-murmuration.md)                           | Spirit of the Murmuration                                                                                | Accepted |
| [ADR-0025](./0025-pluggable-llm-providers.md)                             | Pluggable LLM provider registry                                                                          | Accepted |
| [ADR-0026](./0026-harness-directory-layout.md)                            | Harness directory layout (v0.1 operator repo spec)                                                       | Accepted |
| [ADR-0027](./0027-fallback-identity.md)                                   | Fallback identity for incomplete agent directories                                                       | Accepted |
| [ADR-0028](./0028-eliminate-agent-mjs-requirement.md)                     | Eliminate the `agent.mjs` requirement for standard agents                                                | Accepted |
| [ADR-0029](./0029-agent-persistent-memory.md)                             | Agent persistent memory across wakes                                                                     | Accepted |
| [ADR-0030](./0030-use-madr-for-architectural-decisions.md)                | Use MADR for Architectural Decisions (retroactive)                                                       | Accepted |
| [ADR-0031](./0031-dependency-direction-policy-and-no-cycles-guarantee.md) | Dependency direction policy and "no-cycles" guarantee                                                    | Proposed |
| [ADR-0032](./0032-cross-package-type-management.md)                       | Cross-package type management (`@murmurations-ai/types` extraction)                                      | Proposed |
| [ADR-0033](./0033-github-actions-for-ci.md)                               | GitHub Actions for Continuous Integration (retroactive)                                                  | Accepted |
| [ADR-0034](./0034-subscription-cli-provider-family.md)                    | Subscription-CLI provider family (claude/gemini/codex subprocess providers)                              | Accepted |
| [ADR-0035](./0035-reference-architecture-mapping.md)                      | Reference architecture mapping (9-layer Agentic AI System)                                               | Accepted |
| [ADR-0036](./0036-subscription-cli-permission-mode.md)                    | Subscription-CLI permission mode + Source approval (tension-for-permission)                              | Proposed |
| [ADR-0037](./0037-subscription-cli-binary-integrity.md)                   | Subscription-CLI binary integrity (record + pin + hash-pin)                                              | Proposed |
| [ADR-0038](./0038-spirit-mcp-bridge.md)                                   | Spirit MCP bridge for subscription-CLI tool calls                                                        | Proposed |
