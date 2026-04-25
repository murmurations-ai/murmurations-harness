# ADR-0002: Monorepo Package Structure and Boundaries

- **Status:** Proposed
- **Date:** 2026-04-25
- **Author:** Architecture Agent (#23)
- **Reviewers:** Engineering Circle (#22, #24, #25, #26, #27)

## Context

The Murmuration Harness is a multi-package system designed for pluggability and maintainability. To prevent accidental coupling and ensure clear separation of concerns, a strict package structure and boundary policy is required from the outset. This decision is foundational to the "no-cycles" guarantee (ADR-0003) and the overall topological integrity of the harness.

## Decision

We will adopt a standard TypeScript monorepo layout managed by `pnpm` workspaces.

1.  **Top-level Structure:**
    - `apps/`: Contains runnable applications, like the `harness-daemon` or a future dashboard UI. These are the top-level consumers of packages.
    - `packages/`: Contains all reusable libraries and plugins (e.g., `harness-core`, `plugin-s3`, `channel-adapter-github`).
    - `docs/`: Contains all documentation, including these ADRs.

2.  **Package Naming:**
    - All packages will be scoped under `@murmurations/`. For example: `@murmurations/core`, `@murmurations/governance-s3`.

3.  **Internal Dependencies:**
    - All dependencies between packages within this monorepo **must** use the `pnpm` workspace protocol (`"workspace:*"`). This ensures that local packages are always used during development, preventing version mismatches.

4.  **Boundary Enforcement:**
    - Cross-package imports **must not** use relative paths (e.g., `import ... from '../../packages/core'`). All imports must be via the package name (e.g., `import ... from '@murmurations/core'`).
    - This will be enforced via ESLint rules (`eslint-plugin-import/no-relative-packages`).

## Consequences

- **Positive:**
    - Clear separation of concerns from day one.
    - Prevents "spaghetti" dependencies.
    - Enables independent versioning and publishing of packages in the future.
    - Simplifies tooling and build processes.
- **Negative:**
    - Requires discipline from developers (Source + Claude Code).
    - Initial setup of linting rules is an upfront cost.
