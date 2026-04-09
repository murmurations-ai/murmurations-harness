# Murmuration Harness

Coordination and agent runtime layer for human-agent murmurations with pluggable governance.

> **Status:** Phase 1 scaffold. Not yet usable. Spec at [`xeeban/emergent-praxis:docs/MURMURATION-HARNESS-SPEC.md`](https://github.com/xeeban/emergent-praxis/blob/main/docs/MURMURATION-HARNESS-SPEC.md).

## What this is

The Murmuration Harness is a TypeScript monorepo that provides the substrate for running long-lived multi-agent murmurations: scheduling agent wakes, coordinating via GitHub Issues, running governance rounds, and observing the whole pipeline. Emergent Praxis is the reference implementation.

Design principles (ratified via [Issue #207](https://github.com/xeeban/emergent-praxis/issues/207)):

1. **Pluggable UI** — composable front-end, not a monolith
2. **Pluggable governance** — Sociocracy 3.0 is the default; other models can be swapped in
3. **GitHub-first** — GitHub Issues/Projects are the async coordination layer; the harness reads and writes them
4. **LLM-agnostic** — bring your own API keys and models
5. **Built on [Pi framework](https://github.com/badlogic/pi-mono)** — unified LLM API, agent runtime, TUI + web UI primitives
6. **Identity is inherited** — murmuration soul → agent soul → role; governance and operations are separate concerns
7. **Agents wake and figure out what to do** — they are not woken with task-specific prompts; they read signals and decide
8. **Shared = GitHub, private = repo files** — if it matters to the murmuration, it's in GitHub; if it's an agent's own continuity, it's a file in its workspace

Full principles, scope, architecture, build plan, and carry-forwards: [`MURMURATION-HARNESS-SPEC.md`](https://github.com/xeeban/emergent-praxis/blob/main/docs/MURMURATION-HARNESS-SPEC.md).

## Repository layout

```
murmurations-harness/
├── packages/
│   └── core/              # @murmuration/core — scheduler, signal aggregator, plugin registry
├── docs/
│   └── adr/               # Architecture Decision Records (coming)
├── tsconfig.base.json     # shared strict TypeScript config
├── pnpm-workspace.yaml    # pnpm workspace definition
└── package.json           # monorepo root
```

Additional packages (planned per spec §14.1):

- `@murmuration/github` — typed GitHub client
- `@murmuration/s3-plugin` — Sociocracy 3.0 governance plugin (default)
- `@murmuration/no-gov-plugin` — stub plugin, proves the governance interface
- `@murmuration/cli` — `murmuration` CLI
- `@murmuration/dashboard-tui` — TUI dashboard (pi-tui)
- `@murmuration/dashboard-web` — web dashboard (pi-web-ui)
- `@murmuration/init-skill` — `/init-murmuration` bootstrap skill
- `@murmuration/secrets-dotenv` — default secrets provider

## Development

Requires Node 20+ and pnpm 9+.

```bash
# Install dependencies
pnpm install

# Type-check all packages
pnpm typecheck

# Build all packages
pnpm build

# Clean all build artifacts
pnpm clean
```

## Governance

This project is built by the Engineering Circle of the Emergent Praxis murmuration, ratified via [Issue #240](https://github.com/xeeban/emergent-praxis/issues/240) and self-ratified via [Issue #241](https://github.com/xeeban/emergent-praxis/issues/241).

The circle operates under **Sociocracy 3.0 consent governance**. Architectural decisions are recorded as ADRs in [`docs/adr/`](./docs/adr/). Consent rounds happen on GitHub Issues at [`xeeban/emergent-praxis`](https://github.com/xeeban/emergent-praxis).

### Active open design tensions

| #                                                                      | Title                                | Owner              | Blocks            |
| ---------------------------------------------------------------------- | ------------------------------------ | ------------------ | ----------------- |
| [#1](https://github.com/murmurations-ai/murmurations-harness/issues/1) | Multi-circle routing validation      | Architecture (#23) | Phase 3/4         |
| [#2](https://github.com/murmurations-ai/murmurations-harness/issues/2) | GovernancePlugin interface hardening | TypeScript (#24)   | Phase 3           |
| [#3](https://github.com/murmurations-ai/murmurations-harness/issues/3) | AgentExecutor interface explicit     | TypeScript (#24)   | Phase 2 end       |
| [#4](https://github.com/murmurations-ai/murmurations-harness/issues/4) | Plugin trust + prompt injection      | Security (#25)     | Phase 3 + Phase 7 |
| [#5](https://github.com/murmurations-ai/murmurations-harness/issues/5) | Cost instrumentation gates           | Performance (#27)  | Phase 4           |

## License

MIT — see [LICENSE](./LICENSE).

## Provenance

Built in public by the [Emergent Praxis](https://github.com/xeeban/emergent-praxis) murmuration. The harness is the substrate EP runs on and the Level 5 product EP is building. EP is the reference implementation; this is the infrastructure.

Source: Nori Nishigaya (@xeeban). Builder: Source + Claude Code as a two-member murmuration, with the Engineering Circle as reviewer and gate-keeper.
