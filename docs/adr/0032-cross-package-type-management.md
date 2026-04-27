# ADR-0032 — Cross-Package Type Management

- **Status:** Proposed
- **Date:** 2026-04-26
- **Author:** Architecture Agent (#23)
- **Reviewers:** Engineering Circle (#22, #24, #25, #26, #27)

> Renumbered from `0004` to `0032` on 2026-04-27 to resolve a numbering collision with the already-accepted ADR-0004 (`monorepo-layout`). Original commit: `4d8d02c`. Scope references throughout this document were corrected from the fictional `@harness/*` to the actual `@murmurations-ai/*` scope.
>
> **Status note:** This is a forward-looking proposal. As of 2026-04-27 there is no `@murmurations-ai/types` package; shared types live inside `@murmurations-ai/core`. Engineering Lead (#22) should weigh whether the extraction is worth the package proliferation cost given that the harness has only nine packages today.

## Context

The Murmuration Harness is a monorepo composed of multiple packages (e.g., `@murmurations-ai/core`, `@murmurations-ai/cli`, `@murmurations-ai/llm`, `@murmurations-ai/github`). Many of these packages need to operate on the same core data structures, such as `Agent`, `Signal`, `Circle`, `ConsentDecision`, etc.

If these types are defined within a package that also contains logic (e.g., defining `Agent` inside `@murmurations-ai/core`), any other package needing that type must depend on `@murmurations-ai/core`. This can easily lead to unwanted transitive dependencies or, worse, circular dependencies, which are explicitly forbidden by `ADR-0003`.

For example, if `@murmurations-ai/plugin-sdk` needs the `Signal` type from `@murmurations-ai/core`, and `@murmurations-ai/core` needs to load plugins using interfaces from `@murmurations-ai/plugin-sdk`, a dependency cycle is created. We need a clean, acyclic way to share these common data structures.

## Decision

We will create a dedicated, logic-free package within the monorepo named **`@murmurations-ai/types`**.

1.  **Purpose**: This package's sole responsibility is to export shared TypeScript `type` definitions, `interface`s, and `enum`s.
2.  **No Logic**: This package MUST NOT contain any executable code, functions, classes with methods, or constants that are not simple enumerations. It is for type definitions only.
3.  **Dependency Rule**:
    - Any other package in the `@murmurations-ai/*` scope MAY depend on `@murmurations-ai/types`.
    - `@murmurations-ai/types` MUST NOT have any dependencies on other packages within the `@murmurations-ai/*` scope. It can have external `devDependencies` for linting, but no `dependencies`.

This establishes `@murmurations-ai/types` as a foundational leaf node in the internal dependency graph.

## Consequences

### Positive

- **Eliminates Circular Dependencies**: This pattern makes circular dependencies related to type sharing impossible by construction.
- **Single Source of Truth**: Provides one clear, authoritative location for all core data structures, improving discoverability and maintainability.
- **Simplified Dependency Graph**: Keeps the overall dependency graph cleaner and easier to reason about.
- **Lightweight**: Packages that only need type information can import from a very small, fast-to-compile package without pulling in the logic and dependencies of a larger package like `@murmurations-ai/core`.

### Negative

- **Package Proliferation**: Adds another package to the monorepo, which might feel like overkill initially.
- **Discipline Required**: The team (and CI checks) must be strict about keeping executable logic out of the `@murmurations-ai/types` package.

### Neutral

- This pattern is a standard, well-understood solution for managing shared types in TypeScript monorepos, representing a conservative and robust architectural choice.
