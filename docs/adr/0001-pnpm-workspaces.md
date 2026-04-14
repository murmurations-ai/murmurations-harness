# ADR-0001 — Use pnpm workspaces for monorepo management

- **Status:** Accepted
- **Date:** 2026-04-09 (retroactive; decision made during Phase 0 spec interview)
- **Decision-maker(s):** Source (Nori) via spec interview §14.1
- **Consulted:** TypeScript / Runtime Agent #24 (implicit — the spec §14.1 was ratified via #239 with #24 as CONCERN→CONSENT)

## Context

The Murmuration Harness is a TypeScript monorepo that will ship multiple related packages: `@murmurations-ai/core`, `@murmurations-ai/cli`, `@murmurations-ai/github`, `@murmurations-ai/s3-plugin`, `@murmurations-ai/no-gov-plugin`, `@murmurations-ai/dashboard-tui`, `@murmurations-ai/dashboard-web`, `@murmurations-ai/init-skill`, `@murmurations-ai/secrets-dotenv`, and likely more.

The choices for JavaScript monorepo management in 2026 are:

- **pnpm workspaces** — strict node_modules layout, fast, efficient disk use via content-addressed store
- **npm workspaces** — bundled with Node, less strict about hoisting, slower
- **yarn (classic or berry)** — yarn 1 is deprecated; yarn berry (PnP) is powerful but exotic and sometimes breaks tools
- **Bun workspaces** — emerging, fastest, but the ecosystem (especially Node-specific tooling) is not fully aligned
- **Deno** — different runtime entirely, not compatible with the Pi framework dependency

## Decision

Use pnpm workspaces. Declared in `pnpm-workspace.yaml` at the repo root. Packages live under `packages/*`. The root `package.json` pins `packageManager: "pnpm@10.33.0"`.

## Consequences

**Makes easier:**

- Strict node_modules prevents phantom dependencies — a package that uses `@types/node` must declare it, preventing the class of "works locally, breaks in prod" bugs that hoisted npm workspaces create
- Fast installs (content-addressed store, hard links)
- `pnpm --filter <pkg>` gives clean per-package scripting without custom tooling
- `workspace:*` protocol lets internal packages reference each other cleanly; publishing rewrites the protocol to real versions

**Makes harder:**

- Adopters of the harness must install pnpm (npm install -g pnpm), which is one extra setup step. DevOps Agent #26 owns making this painless.
- Some older tools assume hoisted node_modules; occasional workarounds needed

**Reversibility cost:** Low to medium. Migrating to npm or yarn is mechanical (rewrite `pnpm-workspace.yaml` to `"workspaces": [...]` in root package.json, swap `workspace:*` for relative paths or version pins). A few days of work at most.

## Alternatives considered

- **npm workspaces** — rejected because of phantom dependency risk and slower install. The harness will have many packages and the strictness benefit compounds.
- **yarn berry (PnP)** — rejected because the PnP resolution model breaks some tools we may want to use (Vitest has historically had issues, though they are improving).
- **Bun workspaces** — rejected for v0.1 because Pi framework targets Node and Bun compatibility is not guaranteed. May revisit for v1.0.
- **Single-package (no monorepo)** — rejected because the spec explicitly specifies multiple publishable packages with a clean public API boundary (§14.1). One mega-package would muddy the adopter experience.
