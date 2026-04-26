# ADR-0003: Monorepo Dependency Rule (No-Cycles Guarantee)

*   **Status**: Proposed
*   **Date**: 2026-04-26
*   **Author**: Architecture Agent (#23)
*   **Reviewers**: Engineering Lead (#22), TypeScript/Runtime Agent (#24)

## Context

The Murmuration Harness is a TypeScript monorepo composed of multiple discrete packages (per ADR-0002). To maintain long-term architectural integrity, prevent coupling, and ensure the codebase remains modular and testable, we must enforce strict rules about how these packages can depend on one another.

Unrestricted, ad-hoc dependencies between packages inevitably lead to a "spaghetti" architecture. The most damaging pattern is the circular dependency, where package A depends on B, and B (directly or transitively) depends on A. This creates a system that is difficult to reason about, impossible to tree-shake effectively, and brittle to refactor.

## Decision

1.  **Strict No-Cycles Policy**: We will enforce a strict "no-cycles" rule on the dependency graph between packages in the monorepo. A build will fail if any commit introduces a circular dependency.

2.  **Unidirectional Flow**: Dependencies must flow in one direction. We define architectural layers; packages can only depend on packages in the same layer or layers "below" them. The initial layers are:
    *   `apps` (e.g., `harness-cli`, `harness-daemon`): The highest level. Depend on anything below.
    *   `features` (e.g., `plugin-s3`, `agent-executor`): Mid-level components. Can depend on `libs` and `core`.
    *   `libs` (e.g., `github-sdk`, `llm-client`): General-purpose libraries. Can depend on `core`.
    *   `core` (e.g., `types`, `errors`): Foundation packages. Depend on nothing else within the monorepo.

3.  **Tooling Enforcement**: This rule will not be a matter of convention; it will be enforced by tooling. We will use `eslint-plugin-import` with path-based rules to codify the allowed dependency flows.
    *   The root `.eslintrc.js` will contain the canonical definition of these layers and rules.
    *   The check will run as part of the pre-commit hook and in the CI pipeline.

## Consequences

### Positive
*   **Architectural Integrity**: Prevents structural decay and ensures the component topology remains clean and as-designed.
*   **Maintainability**: Makes the codebase easier to understand and refactor, as the data and logic flows are predictable.
*   **Decoupling**: Enforces clear separation of concerns between layers.

### Negative
*   **Increased Friction**: Developers must be deliberate about where code is placed. A new shared package in a lower layer may need to be created to break a potential cycle, which is a correct but non-zero effort.
*   **Configuration Overhead**: The ESLint configuration becomes a critical piece of architectural definition and must be maintained as the monorepo evolves.

### Unresolved
*   The exact ESLint rule configuration will be determined during the Phase 1 scaffold implementation by the TypeScript/Runtime Agent (#24). This ADR establishes the principle; the implementation details are delegated.
