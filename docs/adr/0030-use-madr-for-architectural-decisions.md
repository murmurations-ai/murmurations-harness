# ADR-0030 — Use MADR for Architectural Decisions

- **Status:** Accepted (retroactive — MADR-style template has been in use since ADR-0001)
- **Date:** 2026-04-25
- **Deciders:** Architecture Agent (#23), Engineering Circle
- **Technical Story:** [murmurations-ai/murmurations-harness#6](https://github.com/murmurations-ai/murmurations-harness/issues/6)

> Renumbered from `0001` to `0030` on 2026-04-27 to resolve a numbering collision with the already-accepted ADR-0001 (`pnpm-workspaces`). Original commit: `4344c65`.

## Context and Problem Statement

The Engineering Circle needs a consistent, lightweight, and version-controlled process for recording significant architectural decisions. Without a defined format and location, decisions risk being lost in chat logs, issue comments, or individual memory. This leads to architectural drift, repeated debates, and difficulty onboarding new contributors. We need to decide on a standard format for Architectural Decision Records (ADRs).

## Decision Drivers

- **Clarity:** The chosen format must be easy to read and understand.
- **Lightweight:** The process should not be overly bureaucratic. A simple template is preferred.
- **Version Control:** Decisions must live in the Git repository alongside the code they affect.
- **Discoverability:** It should be easy to find and browse past decisions.
- **Tool-Friendliness:** A plain text format like Markdown is ideal.

## Considered Options

1.  **MADR (Markdown Architectural Decision Records):** A lightweight format using Markdown files with a simple template (Title, Status, Date, Context, Decision, Consequences). It is widely adopted and has good tooling support.
2.  **Y-Statements (Michael Nygard's ADRs):** The original format, structured as "In the context of <C>, facing <F>, we decided for <O> and accept <D>." It is effective but can be less intuitive for complex decisions.
3.  **Ad-hoc Markdown files:** No specific template. This offers maximum flexibility but risks inconsistency and makes automated processing difficult.
4.  **Wiki-based records (e.g., Confluence):** Keeps records outside the repository, decoupling them from the code's history. This makes it harder to understand the architecture at a specific point in time.

## Decision Outcome

**Chosen option:** "MADR", because it best satisfies the decision drivers. It is a well-defined, lightweight, Markdown-based format that is stored with the source code. The Engineering Circle governance document already recommends it.

We will use the MADR format for all subsequent architectural decisions. ADRs will be stored in the `docs/adr` directory, with filenames like `NNNN-title-with-hyphens.md`, where `NNNN` is a zero-padded sequence number.

The status of an ADR can be "Proposed", "Accepted", "Rejected", or "Superseded". An ADR is considered active ("Accepted") once it is merged into the `main` branch.

## Consequences

- **Positive:**
  - All architectural decisions will have a consistent, discoverable home.
  - The project's architectural history will be clear and auditable.
  - The process for proposing and ratifying decisions is standardized.
- **Negative:**
  - There is a small amount of overhead in creating an ADR file versus making a decision informally. This is an accepted trade-off for clarity and longevity.

## Links

- [MADR Project](https://github.com/adr/madr)
- [Original ADR concept by Michael Nygard](http://thinkrelevance.com/blog/2011/11/15/documenting-architecture-decisions)
