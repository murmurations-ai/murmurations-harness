# ADR-0031 — Dependency Direction Policy and "No-Cycles" Guarantee

- **Status:** Proposed
- **Date:** 2026-04-25
- **Author:** Architecture Agent (#23)
- **Reviewers:** Engineering Circle (#22, #24, #25, #26, #27)

> Renumbered from `0003` to `0031` on 2026-04-27 to resolve a numbering collision with the already-accepted ADR-0003 (`esm-module-system`). This ADR is the consolidated survivor of five competing drafts (commits `a7f8365`, `14222ba`, `823286a`, `8956f76`, `71f8297`) authored by parallel wakes of Architecture Agent #23. The four runners-up were deleted; their decision content is fully captured here.

## Context

Circular dependencies are a primary source of architectural decay. They create a "big ball of mud" where components cannot be reasoned about, tested, or replaced independently. The Murmuration Harness specification (§4) implies a layered architecture with clear dependency directions. This ADR makes that policy explicit and establishes the mechanism for its enforcement.

## Decision

1.  **The Acyclic Dependency Principle:** Dependencies between packages in the monorepo must be acyclic. A package cannot have a dependency path that leads back to itself.

2.  **Primary Dependency Flow:** The general flow of dependencies is _outward_ from a stable core. As of 2026-04-27 the harness has these packages (under the `@murmurations-ai/*` scope):
    - `@murmurations-ai/core` — daemon, executor, scheduler, identity, governance, groups, agents. Must not depend on any other harness package.
    - **Service packages** — `@murmurations-ai/llm`, `@murmurations-ai/github`, `@murmurations-ai/signals`, `@murmurations-ai/secrets-dotenv`. Depend on `core`. Must not depend on each other except where the dependency is explicit and documented in this ADR.
    - **Composition root** — `@murmurations-ai/cli`, `@murmurations-ai/dashboard-tui`. Depend on `core` plus any service packages they wire. They are the only packages that perform composition.

    A simplified visualization:

    ```
    [ cli, dashboard-tui ] -> [ llm, github, signals, secrets-dotenv ] -> [ core ]
    ```

    Arrows indicate the direction of dependency.

3.  **Enforcement:**
    - The "no-cycles" guarantee will be enforced automatically in CI.
    - We will use a tool like `madge --circular` or `eslint-plugin-import/no-cycle` to fail any pull request that introduces a circular dependency between packages.

## Consequences

- **Positive:**
  - Guarantees architectural integrity at the package level.
  - Makes the system easier to understand and maintain.
  - Enables independent development and testing of components.
  - Prevents a major category of bugs related to module resolution order.
- **Negative:**
  - Can feel restrictive during initial development if a developer is not thinking about dependency flow.
  - Requires careful design to avoid situations where a "core" package might need information from a "plugin" (this usually indicates a need for inversion of control, which is the correct pattern).
