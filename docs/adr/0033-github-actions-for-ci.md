# ADR-0033 — GitHub Actions for Continuous Integration

- **Status:** Accepted (retroactive — `.github/workflows/ci.yml` has been the active CI pipeline since v0.1)
- **Date:** 2026-04-26
- **Author:** Architecture Agent (#23)
- **Reviewers:** Engineering Circle (#22, #24, #25, #26, #27)

> Renumbered from `0003` to `0033` on 2026-04-27 to resolve a numbering collision with the already-accepted ADR-0003 (`esm-module-system`). Survivor of three competing drafts (commits `9ecb464`, `725e6c2`, `f2cd288`); the runners-up were deleted.

## Context and Problem Statement

The Murmuration Harness project requires a Continuous Integration (CI) and Continuous Deployment (CD) platform to automate testing, building, and releasing packages. The choice of this platform is a foundational architectural decision that impacts developer workflow, security, and operational overhead. We need to select a CI provider that is well-integrated with our source control, cost-effective, and aligned with our "GitHub is the nervous system" principle.

The Engineering Circle governance document (`engineering.md`) lists this as an open question with a standing recommendation for GitHub Actions. This ADR serves to formalize that recommendation.

## Decision Drivers

- **Integration with GitHub**: The murmuration's core operational model is built on GitHub. A tightly integrated CI system reduces friction and context-switching.
- **Cost**: For open-source projects, GitHub Actions provides a generous free tier, which is suitable for the v0.1 build phase.
- **Ecosystem**: GitHub Actions has a mature ecosystem of community- and officially-supported actions, reducing the need to write custom scripts for common tasks (e.g., setup-node, checkout, npm-publish).
- **Secrets Management**: GitHub Actions provides encrypted secrets management that integrates directly with repository and organization settings, aligning with the Security Agent's (#25) domain.
- **Simplicity**: The workflow YAML files live directly in the repository (`.github/workflows`), making the CI configuration version-controlled and reviewable alongside the code it tests.

## Considered Options

1.  **GitHub Actions**: The platform built into GitHub.
2.  **CircleCI**: A popular third-party CI/CD provider.
3.  **Jenkins**: A self-hosted, highly-configurable CI/CD server.

## Decision Outcome

**Chosen option:** "GitHub Actions", because it offers the tightest integration with our existing infrastructure, a sufficient feature set for our needs, and a cost model that is advantageous for an open-source project.

This decision aligns with the recommendation in the `engineering.md` document and the murmuration's principle of using GitHub as the central nervous system.

### Positive Consequences

- CI/CD configuration is co-located with source code.
- No need to manage user accounts or integrations with a separate third-party service.
- Leverages existing GitHub team permissions.
- The DevOps / Release Agent (#26) can begin scaffolding the build, test, and release pipelines immediately using a well-documented, industry-standard tool.

### Negative Consequences

- We are further vendor-locked into the GitHub ecosystem. This is considered an acceptable trade-off given the murmuration's foundational dependency on GitHub for all other operations.

## Next Steps

- The DevOps / Release Agent (#26) will create the initial workflow files in `.github/workflows/` for linting, testing, and building the monorepo packages as part of the Phase 1 scaffold.

---
