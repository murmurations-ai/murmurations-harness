# ADR-0003: No Circular Dependencies Guarantee

- **Status**: Proposed
- **Date**: 2026-04-25
- **Author**: Architecture Agent (#23)
- **Reviewers**: Engineering Lead (#22), TypeScript/Runtime Agent (#24)

## Context

As the Murmuration Harness monorepo grows, the risk of creating circular dependencies between packages (`@harness/core`, `@harness/plugin-sdk`, `@harness/cli`, etc.) increases. A circular dependency occurs when Package A depends on Package B, and Package B, directly or transitively, depends on Package A.

Such cycles are a form of architectural decay. They:
- Tightly couple components that should be separate.
- Complicate the dependency graph, making the system harder to reason about.
- Can introduce subtle build and runtime errors.
- Prevent the formation of a clear, layered architecture where dependencies flow in a single direction (a Directed Acyclic Graph, or DAG).

To maintain the structural integrity defined in `ADR-0002`, we must explicitly forbid and programmatically prevent circular dependencies.

## Decision

1.  **Rule**: Circular dependencies between packages within the `murmurations-ai/murmurations-harness` monorepo are strictly forbidden. The inter-package dependency graph MUST be a DAG.

2.  **Enforcement**: The "no-cycles" rule will be enforced automatically at two stages:
    - **Pre-commit Hook**: A git pre-commit hook will run a fast dependency check on staged files. If a cycle is introduced, the commit will be blocked.
    - **CI Gate**: A dedicated step in the CI pipeline will perform a full-project dependency analysis. If any cycles exist in the branch, the build will fail. This is the canonical check that protects the `main` branch.

3.  **Tooling**: The circle will adopt `madge` as the primary tool for cycle detection. The CI script will execute `madge --circular --extensions ts .` at the repository root.

4.  **Resolution**: When a cycle is detected, the developer must refactor the code to break it. Common patterns for resolving cycles include:
    - **Dependency Inversion**: Introduce an interface in the lower-level package and have the higher-level package implement it.
    - **Extraction**: Extract the shared functionality that both packages depend on into a new, lower-level package.
    - **Event-based Communication**: Decouple the packages by having them communicate via an event bus rather than direct calls.

## Consequences

- **Positive**:
    - Preserves the layered architecture of the harness.
    - Prevents a major source of technical debt and architectural decay.
    - Forces conscious decisions about package boundaries and responsibilities.
    - Keeps the build system simple and reliable.

- **Negative**:
    - Adds a small amount of friction to the development process (a failing pre-commit hook or CI build). This is considered beneficial friction.
    - May require developers to spend more time thinking about dependency structure, which is the intended outcome.
