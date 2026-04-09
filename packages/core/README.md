# @murmuration/core

Core runtime for the Murmuration Harness.

> **Status:** Phase 1 scaffold. Interfaces are stubs. Not yet usable.

## What lives here

Per [spec §4.1](https://github.com/xeeban/emergent-praxis/blob/main/docs/MURMURATION-HARNESS-SPEC.md), the core package owns:

| Component | Purpose | Pluggable? |
|---|---|---|
| **Scheduler** | Fires agent wakes on cron + events | No (core) |
| **Signal Aggregator** | On wake, builds the signal bundle for the agent | No (core) |
| **Agent Executor** (interface) | Pluggable boundary for how agent sessions are spawned | **Yes** — default: subprocess |
| **Governance Plugin Runtime** | Loads the governance plugin and routes lifecycle events | **Yes** — default: S3 |
| **Plugin Registry** | Loads plugins, enforces capability declarations | No (core) |

## Open design tensions owned by this package

These block Phase 2 / Phase 3 and must be closed before the corresponding phase transitions. Owned by TypeScript / Runtime Agent (#24) and Architecture Agent (#23):

- [#2 — GovernancePlugin interface hardening](https://github.com/murmurations-ai/murmurations-harness/issues/2)
- [#3 — AgentExecutor interface explicit](https://github.com/murmurations-ai/murmurations-harness/issues/3)
- [#4 — Plugin trust boundary + prompt injection](https://github.com/murmurations-ai/murmurations-harness/issues/4)

Do not stabilize the types in `src/execution/` or `src/governance/` until #2 and #3 are resolved.

## Public API surface

The package exports four sub-entry-points via the `exports` map:

- `@murmuration/core` — top-level barrel
- `@murmuration/core/execution` — `AgentExecutor` and related types (STUB — will change per #3)
- `@murmuration/core/governance` — `GovernancePlugin` and event types (STUB — will change per #2)
- `@murmuration/core/scheduler` — `Scheduler` (STUB)
- `@murmuration/core/signals` — `SignalAggregator` (STUB)

All exports marked STUB will change before v0.1. Do not depend on their stability.

## Development

```bash
# From the monorepo root
pnpm --filter @murmuration/core build
pnpm --filter @murmuration/core typecheck
```
