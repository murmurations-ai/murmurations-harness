# 3. Use Vitest for Unit and Integration Testing

*   **Status:** Proposed
*   **Date:** 2026-04-26
*   **Deciders:** Architecture Agent (#23), Engineering Circle
*   **Technical Story:** Addresses open question in `engineering.md` regarding test framework selection.

## Context and Problem Statement

The Murmuration Harness monorepo requires a unified, efficient, and modern testing framework. The choice of framework impacts developer experience (DX), CI/CD pipeline speed, and the overall quality of the codebase. We need to select a single framework for all packages to ensure consistency and avoid configuration fragmentation.

## Decision Drivers

*   **Developer Experience:** The framework should be fast, with features like hot-reloading, clear error reporting, and minimal configuration.
*   **Performance:** Fast test execution is critical for local development loops and for keeping CI/CD times low.
*   **TypeScript/ESM Native:** The framework must have first-class support for TypeScript and modern ES Modules, as these are the foundation of the harness codebase.
*   **Monorepo Support:** It must integrate seamlessly with `pnpm` workspaces, allowing for isolated package testing and root-level orchestration.
*   **API Compatibility:** A Jest-compatible API is highly desirable to lower the learning curve and leverage existing community knowledge and patterns.

## Considered Options

1.  **Vitest:** A modern test framework designed for Vite projects but usable in any context. It is known for its speed, ESM-native architecture, and Jest-compatible API.
2.  **Jest:** The long-standing incumbent. It is feature-rich and widely used, but can be slower and has historically had issues with ESM and complex TypeScript configurations.
3.  **Node.js built-in test runner:** A new, lightweight option built into Node.js. While promising, it is less mature and lacks the rich feature set and ecosystem of Vitest or Jest.

## Decision Outcome

**Chosen option:** "Vitest", because it best satisfies all decision drivers, particularly speed, DX, and native TypeScript/ESM support. The `engineering.md` governance document explicitly recommends it.

All new packages within the `murmurations-harness` monorepo will use Vitest for unit, integration, and component testing. A shared, reusable Vitest configuration will be placed at the root of the monorepo to be extended by individual packages.

## Consequences

*   **Positive:**
    *   Developers get a fast, modern testing experience.
    *   CI/CD pipelines will run faster compared to older frameworks like Jest.
    *   A single, consistent testing approach is enforced across the entire project.
    *   Excellent integration with the TypeScript toolchain.
*   **Negative:**
    *   Vitest is a younger project than Jest, so its ecosystem, while growing rapidly, may have fewer integrations than Jest's. This is an acceptable trade-off for the significant performance and DX improvements.
