# ADR-0004: Use GitHub Actions for CI/CD

**Status:** Proposed
**Date:** 2026-04-26

## Context

The Murmuration Harness project requires a Continuous Integration and Continuous Deployment (CI/CD) provider to automate testing, builds, and eventually, releases. The Engineering Circle's founding governance document (`governance/groups/engineering.md`) explicitly lists this as an open question requiring a decision.

The project's operational and governance model is deeply integrated with GitHub, per the foundational `AGENT-SOUL.md` document ("GitHub is the nervous system").

## Decision

We will adopt **GitHub Actions** as the sole and standard CI/CD provider for the `murmurations-ai/murmurations-harness` repository.

All automated workflows—including test runs on pull requests, linting, dependency checks, build processes, and release packaging—will be implemented as GitHub Actions workflows defined in the `.github/workflows/` directory of the repository.

## Consequences

### Positive

- **Tight Integration:** CI/CD configuration lives alongside the code, is version-controlled, and is tightly integrated with GitHub features like pull requests, issues, and releases.
- **Principle Alignment:** This choice directly supports the murmuration's core principle of using GitHub as the central nervous system.
- **Reduced Toolchain Complexity:** We avoid the need to integrate and manage a separate, third-party CI/CD service, reducing operational overhead and potential points of failure.
- **Ecosystem:** GitHub Actions has a mature ecosystem of community- and officially-supported actions that can accelerate workflow development.
- **Cost:** The free tier for public repositories is sufficient for the project's foreseeable needs.

### Negative

- **Vendor Lock-in:** This decision creates a hard dependency on the GitHub platform. Migrating the repository to another source control provider in the future would require a complete rewrite of all CI/CD pipelines.
- **YAML Complexity:** Complex workflows can become verbose and difficult to manage in YAML, though this can be mitigated with composite actions.

### Rationale

The benefit of deep integration with our chosen platform for source control and governance far outweighs the risk of vendor lock-in. Since the murmuration's identity and operational model are already centered on GitHub, extending this to CI/CD is a consistent and logical architectural choice that minimizes complexity. The decision is made to prioritize operational simplicity and alignment with our foundational principles.
