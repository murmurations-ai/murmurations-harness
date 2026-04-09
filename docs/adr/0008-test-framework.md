# ADR-0008 — Test framework: Vitest

- **Status:** Accepted
- **Date:** 2026-04-09
- **Decision-maker(s):** TypeScript / Runtime Agent #24 (consulted per Issue #241 carry-forward), DevOps / Release Agent #26
- **Consulted:** Engineering Lead #22 (facilitator)

## Context

Phase 1A shipped without a test framework (an explicit accepted risk in `docs/PHASE-1-PLAN.md` §Risks). Phase 1B must land tests before the Phase 1 → Phase 2 gate. The carry-forward from Issue #241 (Engineering Circle self-ratification) specified that **TypeScript #24 must be consulted on the test framework choice** — this ADR closes that carry-forward.

The options for TypeScript ESM monorepos in 2026:

- **Vitest** — modern, ESM-native, Jest-compatible API, fast parallel runner, built-in TS support via esbuild, excellent watch mode
- **Node built-in test runner (`node --test`)** — zero dependencies, standards-based, but thin on features (no mocking, limited matchers, no watch mode)
- **Jest** — the incumbent, but ESM support is historically painful, transformer config is fiddly, and it is slower than Vitest on a monorepo
- **uvu** — minimal, fast, but no mocking and an eccentric API
- **tap** — opinionated, tap-protocol output, feature-rich, but the API is non-standard

## Decision

**Use Vitest across the monorepo.** Add `vitest` as a root dev dependency; every package gets a `test` script that runs `vitest run` and a `test:watch` script for interactive development. Test files live alongside source as `*.test.ts`.

Configuration: a single `vitest.config.ts` at the repo root that discovers tests across `packages/*/src/**/*.test.ts`. Per-package overrides are possible but should be rare.

## Consequences

**Makes easier:**

- Jest-compatible API (`describe`, `it`, `expect`) — low learning curve for contributors
- Native ESM, no transformer config — works out of the box with our `tsconfig.base.json` (ADR-0002) and ESM module system (ADR-0003)
- Fast parallel runner — scales with package count
- Type-checking mode (`vitest typecheck`) — unifies test and type validation
- Built-in coverage via c8 — one tool covers test + coverage
- Watch mode is genuinely good — essential for TDD on the scheduler and executor

**Makes harder:**

- One more dependency to keep current. Vitest moves fast and occasional breaking changes land in minor versions.
- Contributors coming from Jest may occasionally hit subtle differences (timer mocking, module mocking APIs).

**Reversibility cost:** Medium-low. Switching to another framework later would require rewriting test files (API is mostly `describe`/`it`/`expect`-compatible with Jest) and updating CI config. A few days of work.

## Alternatives considered

- **Node built-in test runner** — tempting for the zero-dependency angle, but the feature gap hurts velocity. No mocking, no watch mode, verbose output. Reconsider if Node's runner matures significantly.
- **Jest** — rejected due to ESM friction. We deliberately picked ESM in ADR-0003, and fighting Jest on that is not worth it. Also, Vitest is materially faster.
- **uvu / tap** — rejected for ecosystem reach. Vitest has the widest community and the most documentation.

## Related

- Issue #241 (Engineering Circle self-ratification) carry-forward — "TypeScript #24 must be consulted on test framework selection"
- PHASE-1-PLAN.md §Phase 1B step B6
- Follow-up work: Phase 1B must land at least one test per production package before the Phase 1 → Phase 2 gate
