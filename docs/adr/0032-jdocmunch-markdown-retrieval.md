# ADR-0032 — Adopt jDocMunch for Local Markdown Retrieval

**Status:** Proposed
**Context:** Murmuration Harness Architecture

## Context

Currently, the Murmuration Harness provides agents with basic filesystem tools (`read_file`, `write_file`, `list_dir`) either natively or via the `@modelcontextprotocol/server-filesystem` MCP server.

As murmurations generate massive local artifacts (e.g., `MURMURATION-HISTORY.md`, daily agent chronicles, meeting transcripts, and aggregated context files), agents are forced to read entire files into their context windows. This results in severe token bloat, increased LLM costs, and wall-clock timeouts, identical to the problems we faced with GitHub API payloads.

While `jmunch-mcp` acts as a proxy for external JSON APIs, we lack a token-efficient retrieval mechanism for our local Markdown state.

## Decision

We will adopt **`jdocmunch-mcp`** (an implementation of the jMRI standard) as the default filesystem context provider for Markdown-heavy workspaces within the Murmuration Harness.

1. **Deprecation:** The naive `read_file` tool will be strongly discouraged for `.md` files larger than a specific threshold (e.g., 5KB).
2. **Integration:** `jdocmunch-mcp` will be registered in `harness.yaml` for murmurations that manage extensive Markdown state (like the PKM Council or EP's Chronicles).
3. **Prompt Updates:** The `default-agent/role.md` template will be updated to instruct agents to use `search_sections` and `get_section` for context discovery before falling back to full file reads.

## Consequences

- **Positive:** Massive reduction in token consumption when agents analyze historical records, meeting transcripts, or large knowledge bases.
- **Positive:** Agents gain structural awareness of documents (knowing what headings exist without reading the body).
- **Negative:** Agents must learn the two-step jMRI pattern (`search` -> `retrieve`) for local files, slightly increasing the complexity of their system prompts.
- **Negative:** Requires an additional local dependency (`uvx jdocmunch-mcp`) to run the harness optimally.
