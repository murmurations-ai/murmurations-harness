# ADR-0003: Enforce No Circular Dependencies

- **Status:** Proposed
- **Date:** 2026-04-25
- **Author:** Architecture Agent (#23)
- **Reviewers:** Engineering Circle (#22, #24, #25, #26, #27)

## Context

[ADR-0002](./0002-package-boundaries-and-dependency-rules.md) established a clear, directed dependency flow between packages in the `murmurations-harness` monorepo. A core principle of this architecture is that dependencies should form a Directed Acyclic Graph (DAG).

However, without automated enforcement, it is easy for developers (or agents) to accidentally introduce a circular dependency (e.g., package `A` depends on `B`, and `B` is later modified to depend on `A`). These cycles break the architectural model, lead to tightly coupled code that is difficult to test and maintain, and can cause complex build and type-checking issues.

## Decision

We will use an automated tool to statically analyze the dependency graph of the monorepo and fail the build if any circular dependencies between packages are detected.

This check will be integrated into the Continuous Integration (CI) pipeline, making it a mandatory gate for all code changes.

## Rationale

- **Architectural Integrity:** Proactively prevents architectural decay by enforcing the DAG principle defined in ADR-0002.
- **Maintainability:** Keeps packages loosely coupled, making them easier to understand, refactor, and test in isolation.
- **Build Reliability:** Avoids complex and often unpredictable build failures that can arise from cyclic dependencies.
- **Cost-Effectiveness:** It is significantly cheaper and faster to prevent cycles from being introduced than to discover and refactor them later in the project's lifecycle.

### Chosen Tool: `dependency-cruiser`

We will use `dependency-cruiser` for this task.

- It is highly configurable, allowing us to define rules at the package, folder, and even file level.
- It provides clear, actionable output when a violation is found.
- It integrates well with modern TypeScript/JavaScript tooling and CI environments.

A base `.dependency-cruiser.js` configuration file will be created at the root of the monorepo, and a corresponding `lint:deps` script will be added to the root `package.json`.

## Consequences

- **Positive:**
    - The architectural principle of a DAG is guaranteed by the build process.
    - Developers receive immediate feedback if they introduce a problematic dependency.
- **Negative:**
    - Adds a small amount of time to the CI build process.
    - May require developers to think more carefully about where to place new code, which is a desired friction.
- **Neutral:**
    - Introduces a new development dependency (`dependency-cruiser`) to the project.
