# ADR-0002 — TypeScript strict mode baseline

- **Status:** Accepted
- **Date:** 2026-04-09 (retroactive; decision made during Phase 1A scaffold)
- **Decision-maker(s):** TypeScript / Runtime Agent #24
- **Consulted:** Architecture Agent #23, Engineering Lead #22

## Context

The harness is an open-source infrastructure project that adopters will install and run in production. Type errors that escape into runtime are expensive to debug in a daemon process and catastrophic in governance plugins that touch consent rounds.

TypeScript offers many strictness flags beyond the basic `strict: true` umbrella. Some of them (notably `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`) add real friction but catch real bugs. The decision is whether to take the friction up front or let it leak.

## Decision

Enable every strict flag in `tsconfig.base.json`, including the high-friction ones:

```json
{
  "strict": true,
  "noImplicitAny": true,
  "strictNullChecks": true,
  "strictFunctionTypes": true,
  "strictBindCallApply": true,
  "strictPropertyInitialization": true,
  "alwaysStrict": true,
  "noUnusedLocals": true,
  "noUnusedParameters": true,
  "noImplicitReturns": true,
  "noFallthroughCasesInSwitch": true,
  "noUncheckedIndexedAccess": true,
  "noImplicitOverride": true,
  "exactOptionalPropertyTypes": true,
  "verbatimModuleSyntax": true
}
```

This is the baseline for every package in the monorepo. Packages extend `tsconfig.base.json` and may tighten (but not relax) these flags.

## Consequences

**Makes easier:**

- Bugs caught at compile time that would otherwise slip to runtime:
  - `arr[i]` is `T | undefined`, forcing callers to handle the out-of-bounds case
  - `{ foo?: string }` is distinct from `{ foo: string | undefined }`, preventing the "did you mean to pass undefined or omit the key" class of bugs
  - `verbatimModuleSyntax` forces explicit `import type` for type-only imports, making the ESM/CJS interop boundary legible
- Exported APIs are self-documenting — signatures express intent precisely
- Refactors are safer — the compiler catches reach-through invariant violations

**Makes harder:**

- Writing new code takes marginally longer (you have to `?.` or narrow before accessing indexed values)
- Some library types (especially older `@types/*` packages) are not written to these standards and require workarounds
- Learning curve for contributors who haven't worked in strict TypeScript before

**Reversibility cost:** Extremely high. Relaxing a strict flag after code is written in strict mode exposes latent bugs; the reverse (tightening) is exactly what we're doing here. Once we establish the baseline and write code to it, reverting would break the type-level contract that downstream consumers rely on. Essentially one-way.

## Alternatives considered

- **`strict: true` only, without the additional flags** — rejected because `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` catch the highest-impact bug classes in a monorepo that deals with records of structured data (signals, governance events, cost actuals).
- **Relaxed strictness for internal packages, strict for public API** — rejected because the internal/public boundary is porous in a monorepo; internal code often leaks into public surface over time.
- **`strict: false`** — rejected because the harness handles governance-critical data; type safety is a first-order concern, not a dev-experience preference.

## Related

- Engineering Circle identity doc for TypeScript / Runtime Agent #24 (`governance/agents/24-typescript-runtime-agent.md`) — describes the "no `any` in public API" stance this ADR operationalizes
- Carry-forward #2 (GovernancePlugin interface hardening) — will consume this baseline
