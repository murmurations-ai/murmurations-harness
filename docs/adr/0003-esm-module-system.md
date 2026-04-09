# ADR-0003 — ESM module system across all packages

- **Status:** Accepted
- **Date:** 2026-04-09 (retroactive)
- **Decision-maker(s):** TypeScript / Runtime Agent #24, DevOps / Release Agent #26
- **Consulted:** Architecture Agent #23

## Context

Node.js supports both CommonJS (CJS) and ECMAScript Modules (ESM). ESM is the standards-based module system and the direction the ecosystem is moving. As of Node 22+, ESM is fully supported and CJS is increasingly constrained (top-level await, dynamic imports, etc., are ESM-only or awkward in CJS).

Mixing CJS and ESM within a package is possible but fragile. Mixing across packages in a monorepo creates interop friction.

## Decision

Every package in the monorepo declares `"type": "module"` and ships ESM only. The TypeScript compiler emits ESM (`"module": "ESNext"`, `"moduleResolution": "Bundler"` in `tsconfig.base.json`). Import specifiers use `.js` extensions for intra-package references (per the Node ESM resolver requirement).

The Pi framework (`pi-mono`) is our primary runtime dependency and is ESM. This decision is consistent with that.

## Consequences

**Makes easier:**

- Single module system across the codebase — no dual-publishing pain
- Top-level await is available, simplifying async initialization in the CLI and daemon boot paths
- Aligns with modern Node ecosystem direction
- Pi framework integration is natural (both are ESM)

**Makes harder:**

- Some legacy dependencies only ship CJS. We consume them via Node's ESM-to-CJS interop, which works but has sharp edges for default imports
- Cannot use `require()` directly; need `createRequire` if needed for specific CJS-only scenarios
- Jest has historically had ESM friction (which is part of why we chose Vitest in [ADR-0008](./0008-test-framework.md))

**Reversibility cost:** High. Converting from ESM to CJS after code is written requires touching every import specifier, removing top-level awaits, and rewriting dynamic imports. A significant refactor.

## Alternatives considered

- **CommonJS only** — rejected. CJS is a legacy direction and Pi framework is ESM.
- **Dual-publish (CJS + ESM)** — rejected for v0.1 because it doubles build complexity and we do not have non-ESM consumers. Can revisit if an adopter needs CJS support.
- **Wait and see** — rejected because picking a direction later would invalidate all the import specifier work already done.
