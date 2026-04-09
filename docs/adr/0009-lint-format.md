# ADR-0009 — Lint + format: ESLint flat config + Prettier

- **Status:** Accepted
- **Date:** 2026-04-09
- **Decision-maker(s):** DevOps / Release Agent #26
- **Consulted:** TypeScript / Runtime Agent #24

## Context

Phase 1A shipped without lint or format tooling. Phase 1B must add both before CI lands. The decisions to make are:

1. Which linter? ESLint vs Biome vs oxc
2. Which formatter? Prettier vs Biome vs dprint
3. Which ESLint config style? Legacy `.eslintrc.*` vs flat `eslint.config.js`
4. Which TypeScript ESLint ruleset? `typescript-eslint` recommended, strict, or custom

## Decision

- **Linter:** ESLint with flat config (`eslint.config.js`)
- **TypeScript rules:** `@typescript-eslint/eslint-plugin` recommended-type-checked + strict-type-checked rulesets
- **Formatter:** Prettier (default config, no arguments about tabs vs spaces)
- **Format-on-lint integration:** `eslint-config-prettier` to disable ESLint rules that conflict with Prettier; Prettier runs separately for formatting

**Applied at the monorepo root.** A single `eslint.config.js` and `.prettierrc.json` at the root apply to every package. Per-package overrides are possible but should be rare.

## Consequences

**Makes easier:**

- ESLint is the ecosystem standard — every IDE has native support, every contributor knows it
- Flat config is the future direction (v9+) and has cleaner semantics than the legacy RC format
- typescript-eslint's "strict-type-checked" ruleset catches high-value bugs (unsafe any, misused promises, unused expressions) that TypeScript's own flags miss
- Prettier eliminates all "where does the brace go" debates; every file is formatted the same way
- Separation of concerns: ESLint catches bugs, Prettier handles formatting — neither one has to do both jobs badly

**Makes harder:**

- Two tools to maintain instead of one (Biome would do both)
- Typed linting (`recommended-type-checked`) is slower than untyped linting — adds a few seconds to `pnpm lint` as the monorepo grows. Acceptable.
- Contributors coming from Go or Rust may find the TypeScript lint surface noisy compared to their native tooling

**Reversibility cost:** Low. Switching to Biome later would require moving ESLint rule config to Biome equivalents (many map 1:1) and removing Prettier. A day of work.

## Alternatives considered

- **Biome** — tempting because it bundles lint + format in one Rust-native tool and is fast. Rejected for v0.1 because its TypeScript-specific rule coverage is still behind typescript-eslint, and the type-aware rules we want (`no-unsafe-argument`, `no-misused-promises`, etc.) are not yet at parity. Revisit for v1.0.
- **oxc** — similar story to Biome — fast, promising, not yet at rule parity. Revisit later.
- **ESLint legacy `.eslintrc.json`** — rejected because flat config is the direction ESLint itself is moving and there is no reason to start on legacy.
- **No linter, rely on TS strict mode alone** — rejected because TS strict catches type bugs but not stylistic or semantic issues (dead code, misused promises, inconsistent async handling). Linting is complementary, not redundant.
- **dprint as formatter** — rejected; Prettier is the ecosystem default and contributors expect it.

## Scope

This ADR covers the tooling choice. The actual rule set (which rules to enable, which to downgrade to warning, which to disable) is a separate decision tracked in the root `eslint.config.js`. Changes to the rule set are Autonomous-tier for DevOps #26 but should be noted in commit messages.

## Related

- ADR-0002 (TypeScript strict baseline) — lint rules complement the strict TS flags, they do not replace them
- PHASE-1-PLAN.md §Phase 1B step B7
- Follow-up: CI (Phase 1B B9) must run `pnpm lint` and `pnpm format:check` on every PR
