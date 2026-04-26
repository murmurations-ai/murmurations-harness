# ADR-0003: No Circular Dependencies Policy

- **Status**: Proposed
- **Date**: 2026-04-26
- **Author**: Architecture Agent (#23)
- **Reviewers**: Engineering Lead (#22), TypeScript/Runtime Agent (#24)

## Context

[ADR-0002](./0002-package-boundaries-and-dependency-rules.md) establishes a monorepo with a clear, directed dependency graph. The long-term health of this architecture depends on preventing this graph from becoming cyclic.

A circular dependency (or "cycle") occurs when package `A` depends on package `B`, and package `B` directly or indirectly depends back on package `A`. Such cycles create implicit, tight coupling between packages, making the codebase harder to understand, test, and refactor. They can also complicate the build process and lead to difficult-to-diagnose runtime errors.

To maintain a clean, layered architecture, this policy must be enforced automatically.

## Decision

We will enforce a strict **no circular dependencies** policy at the package level within the `murmurations-ai/murmurations-harness` monorepo.

This enforcement will be automated and integrated into the Continuous Integration (CI) pipeline. Any pull request that introduces a package-level circular dependency will fail the CI check and be blocked from merging until the cycle is resolved.

## Implementation Details

- **Tooling**: We will use `dependency-cruiser` to analyze the dependency graph. It is a mature, highly configurable tool for dependency validation in JavaScript/TypeScript projects.
- **Configuration**: A `.dependency-cruiser.js` configuration file will be maintained at the root of the monorepo.
- **CI Gate**: A dedicated step in the CI workflow (e.g., GitHub Actions) will execute `dependency-cruiser` against the codebase. The command will be configured to exit with a non-zero status code if any cycles are detected, thus failing the build.
- **Initial Rule**: The primary rule in the configuration will be to forbid any circular dependencies (`'no-circular'`). Further, more granular rules (e.g., forbidding `core` from depending on `cli`) can be added later as needed.

## Consequences

- **Positive**:
    - Preserves the architectural integrity defined in ADR-0002.
    - Keeps the system loosely coupled and easier to maintain.
    - Simplifies the mental model required to work on the codebase.
    - Prevents a common source of technical debt from accumulating.

- **Negative**:
    - Developers must be conscious of the dependency graph when adding new imports.
    - Resolving a potential cycle may require refactoring, such as extracting shared code into a new or existing lower-level package. This is considered a positive trade-off for architectural health.
