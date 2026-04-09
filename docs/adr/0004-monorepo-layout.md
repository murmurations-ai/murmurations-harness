# ADR-0004 — Monorepo layout

- **Status:** Accepted
- **Date:** 2026-04-09 (retroactive)
- **Decision-maker(s):** Architecture Agent #23, TypeScript / Runtime Agent #24
- **Consulted:** Engineering Lead #22

## Context

The spec §14.1 prescribes a monorepo with `packages/*` workspace layout and a separate template repo for adopters. Within that guidance, concrete layout questions remain:

- How granular should packages be?
- Where do cross-package types live?
- Where do example agents live?
- Where do docs (ADRs, spec, runbooks) live?
- How do composite TypeScript project references work with our layout?

## Decision

### Top-level layout

```
murmurations-harness/
├── packages/
│   ├── core/              # @murmuration/core — runtime, interfaces, scheduler, executor, daemon
│   ├── cli/               # @murmuration/cli — command-line interface
│   ├── github/            # @murmuration/github — (Phase 1B) typed GitHub client
│   ├── secrets-dotenv/    # @murmuration/secrets-dotenv — (Phase 1B) .env secrets
│   ├── s3-plugin/         # @murmuration/s3-plugin — (Phase 3) S3 governance plugin
│   ├── no-gov-plugin/     # @murmuration/no-gov-plugin — (Phase 3) stub plugin
│   ├── dashboard-tui/     # @murmuration/dashboard-tui — (Phase 5) TUI dashboard
│   └── dashboard-web/     # @murmuration/dashboard-web — (Phase 5) web dashboard
├── examples/
│   └── hello-world-agent/ # Example agents (not published to npm)
├── docs/
│   ├── PHASE-1-PLAN.md
│   ├── adr/               # Architecture Decision Records
│   └── (other build docs)
├── .github/               # (Phase 1B) CI workflows
├── tsconfig.base.json     # Strict baseline (extended by every package)
├── pnpm-workspace.yaml
└── package.json           # Workspace root
```

### Package granularity rule

**One package per pluggable boundary plus one per structural concern.** Concretely:

- `@murmuration/core` holds non-pluggable components (scheduler, signal aggregator, daemon, plugin loader) and the pluggable interfaces (`AgentExecutor`, `GovernancePlugin`, `SecretsProvider`, `ChannelAdapter`).
- Pluggable implementations each live in their own package (`@murmuration/s3-plugin`, `@murmuration/no-gov-plugin`, `@murmuration/secrets-dotenv`, etc.) so adopters can install only what they need and the pluggability claim is real.
- Cross-cutting code (`@murmuration/cli`) is its own package and depends on `@murmuration/core` via `workspace:*`.

### Types live with their owner

Shared types (like `AgentExecutor`, `GovernancePlugin`, the governance event taxonomy) live in `@murmuration/core` and are exported via the `exports` map. Plugins import types from `@murmuration/core` — not from a separate `@murmuration/types` package.

Rationale: a separate types package creates a circular-ish dependency (plugin → types, core → types, core depends on plugin interfaces) and adds a versioning surface we do not need. Types live with the package that owns the interface.

### Examples live outside `packages/`

Example agents (like `hello-world-agent`) live in `examples/` and are **not published to npm**. They are reference material, not installable packages. They have their own loose structure — no `package.json` required.

### Docs

All project docs live in `docs/`. ADRs live in `docs/adr/`. Runbooks (Phase 1B+) live in `docs/runbooks/`. The spec itself lives in the emergent-praxis repo and is referenced via URL (not copied) to avoid drift.

### TypeScript composite projects

Every package has a `tsconfig.json` that extends `tsconfig.base.json` and declares `composite: true`. Packages that depend on other workspace packages use TypeScript project references in their `tsconfig.json`:

```json
{
  "references": [{ "path": "../core" }]
}
```

`pnpm build` runs `tsc --build` recursively, which respects these references and builds in topological order.

## Consequences

**Makes easier:**

- Clean public API surface per package
- Adopters install only the plugins they use
- Cross-package refactors are safe (pnpm + TS project references catch breakage at build time)
- Composite builds are fast (only changed projects rebuild)

**Makes harder:**

- More package.json files to maintain
- More exports maps to keep in sync
- Must remember to update `references` in tsconfig when adding cross-package imports

**Reversibility cost:** Low. Merging packages is mechanical (move files, update imports, update package.json exports). Splitting one is harder but still doable.

## Alternatives considered

- **Single mega-package** — rejected; contradicts the pluggability claim in spec §14.1 and would muddy the adopter install experience.
- **Separate `@murmuration/types` package** — rejected; creates unnecessary versioning surface and does not buy us anything in a private-by-default monorepo.
- **Examples inside `packages/`** — rejected because examples should not appear in `pnpm -r` operations (test, build, publish) — they are reference material, not part of the product.
