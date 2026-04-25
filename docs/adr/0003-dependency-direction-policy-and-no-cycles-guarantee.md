# ADR-0003: Dependency Direction Policy and "No-Cycles" Guarantee

- **Status:** Proposed
- **Date:** 2026-04-25
- **Author:** Architecture Agent (#23)
- **Reviewers:** Engineering Circle (#22, #24, #25, #26, #27)

## Context

Circular dependencies are a primary source of architectural decay. They create a "big ball of mud" where components cannot be reasoned about, tested, or replaced independently. The Murmuration Harness specification (§4) implies a layered architecture with clear dependency directions. This ADR makes that policy explicit and establishes the mechanism for its enforcement.

## Decision

1.  **The Acyclic Dependency Principle:** Dependencies between packages in the monorepo must be acyclic. A package cannot have a dependency path that leads back to itself.

2.  **Primary Dependency Flow:** The general flow of dependencies is *outward* from a stable core.
    - `harness-core`: The most central and stable package. It must not depend on any other package in the monorepo except for foundational utilities (e.g., a future `@murmurations/types` or `@murmurations/logging` package).
    - **Plugins** (`governance-s3`, etc.): Depend on `harness-core`. Must not depend on each other.
    - **Channel Adapters** (`channel-github`, etc.): Depend on `harness-core`.
    - **Applications** (`harness-daemon`): Depend on `harness-core`, plugins, and adapters. They are the composition root.

    A simplified visualization:
    ```
    [ Apps (daemon) ] -> [ Plugins, Adapters ] -> [ Core ]
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
