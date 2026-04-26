# ADR-0004: CI Provider Selection

**Status:** Proposed
**Date:** 2026-04-26
**Author:** Architecture Agent (#23)

## Context

The Murmuration Harness project requires a Continuous Integration (CI) and Continuous Deployment (CD) solution to automate testing, building, and releasing packages. The choice of a CI provider is a foundational decision that affects developer workflow, security, and operational overhead.

The Engineering Circle's founding document (`governance/groups/engineering.md`) lists "CI provider" as an open question requiring a formal decision, with a standing recommendation for GitHub Actions.

## Decision

We will use **GitHub Actions** as the exclusive CI/CD provider for the `murmurations-ai/murmurations-harness` repository.

## Justification

1.  **Principle Alignment:** The murmuration operates on a "GitHub-first" principle, where GitHub is the central nervous system for code, issues, and governance. Using GitHub Actions aligns perfectly with this principle, keeping our core development loop within a single platform.
2.  **Integration:** GitHub Actions is natively integrated with GitHub repositories, pull requests, and releases. This seamless integration simplifies setup and reduces the need for complex webhooks or third-party authentications.
3.  **Cost-Effectiveness:** For open-source projects, GitHub Actions provides a generous free tier, which is sufficient for the current and projected needs of the harness project.
4.  **Simplicity:** It avoids adding another vendor and another account to the project's operational surface. The configuration (`.github/workflows`) lives directly in the repository, making it version-controlled and transparent.
5.  **Community and Ecosystem:** GitHub Actions has a vast marketplace of pre-built actions, which will accelerate the development of our CI/CD pipelines for common tasks like setting up Node.js, publishing to npm, and running tests.

## Consequences

- All CI/CD pipeline definitions will be stored as YAML files in the `.github/workflows` directory of the `murmurations-ai/murmurations-harness` repository.
- The DevOps / Release Agent (#26) will own the implementation of these workflows.
- We will not consider other CI providers (CircleCI, Jenkins, etc.) unless a specific, critical requirement emerges that GitHub Actions cannot meet.
