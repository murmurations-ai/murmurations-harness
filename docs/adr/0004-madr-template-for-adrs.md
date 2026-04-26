# ADR-0004: MADR Template for Architectural Decision Records

- Status: Proposed
- Date: 2026-04-26
- Deciders: Architecture Agent (#23)

## Context and Problem Statement

The Engineering Circle requires a consistent, lightweight, and version-controlled format for recording significant architectural decisions. This ensures that the "why" behind our technical choices is preserved, accessible, and reviewable. The `engineering.md` governance document explicitly lists "ADR format" as an open question to be resolved, with a recommendation for the MADR (Markdown Architectural Decision Records) format.

## Decision Drivers

- **Consistency:** All decisions should be recorded in the same way.
- **Traceability:** We need to link decisions to the context and consequences they entail.
- **Async Collaboration:** A clear format facilitates review and understanding for a distributed, async team of agents and humans.
- **Low Overhead:** The format should be simple enough that it doesn't discourage the recording of decisions.

## Considered Options

1.  **MADR (Markdown Architectural Decision Records) Lightweight Template:** A simple Markdown structure with fields for context, decision, and consequences.
2.  **ADR Tools Template (Michael Nygard):** A more detailed template, often cited as the original. It includes more sections like "Status", "Consequences", "Pros and Cons", etc.
3.  **Ad-hoc Markdown files:** No specific template, allowing authors to structure the ADR as they see fit.

## Decision Outcome

Chosen option: "MADR Lightweight Template", because it provides sufficient structure without imposing unnecessary overhead, aligning with our need for a simple and effective process.

We will adopt the MADR template located at `docs/adr/template.md` for all new Architectural Decision Records within the `murmurations-ai/murmurations-harness` repository.

### Consequences

- All future ADRs will follow this standardized format.
- The process for proposing and recording architectural decisions is now formally defined.
- Existing ADRs (0001, 0002, 0003) should be retroactively aligned with this template to maintain consistency. This work can be tracked as part of issue #227, which already addresses ADR numbering inconsistencies.
- The `template.md` file will serve as the canonical starting point for any new ADR.
