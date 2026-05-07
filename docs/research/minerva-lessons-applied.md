# Research Note: Applying Lessons from the Minerva Experiment

**Date:** 2026-05-01
**Context:** Based on the "I Handed an AI Agent 27 Domains" case study.

The Minerva experiment highlighted several critical failure modes of autonomous agents operating in production over long timeframes. This document maps those failure modes to specific architectural requirements for the Murmuration Harness.

## 1. Ambient Observability (The `ups.dev` Pattern)

**The Insight:** Agents don't fail with 500 errors; they degrade, hallucinate, or silently stop using tools. Observability must be ambient and focus on agent _health_, not just execution success.
**Harness Application:**

- **Current State:** We track LLM costs, tokens, and wake durations via `WakeCostBuilder`.
- **Proposed Architecture (ADR candidate):** Introduce `HealthActuals` alongside `CostActuals`. The daemon should track:
  - **Tool Utilization Rate:** If an agent normally uses 5 tools per wake and suddenly uses 0 for three consecutive wakes, flag as degraded.
  - **Error Density:** Track the ratio of successful tool calls to failed tool calls (e.g., catching the `Bad credentials` loop earlier).
  - **Effectiveness Decay:** Track the self-reported `effectiveness` score over a rolling window. If it drops to `low` consistently, trip a new type of circuit breaker (a "Degradation Breaker") that requires Source intervention.

## 2. Machine-Friendly Task Dependencies

**The Insight:** The agent struggled with UI-centric project management (Fizzy) but thrived with a CLI tool (`beans`) that output JSON and supported explicit dependency graphs.
**Harness Application:**

- **Current State:** We use GitHub Issues as a flat list, relying on labels (`blocked`, `next`) for state.
- **Proposed Architecture (ADR candidate):** Formalize a **Task Dependency Graph** within the `SignalAggregator`. When parsing GitHub issues, the harness should explicitly extract `Depends on: #XXX` or `Blocks: #YYY` from the issue body/frontmatter. The agent's `SignalBundle` should receive a structured graph of actionable items vs. blocked items, preventing agents from wasting tokens trying to act on blocked tasks.

## 3. Two-Tier Memory Architecture

**The Insight:** "Every session is a lossy compression of what came before." Daily journals accumulate too much noise, leading to forgotten technical decisions.
**Harness Application:**

- **Current State:** Agents write to local daily logs, but rely on generic context windows. We recently added `jdocmunch-mcp` for efficient retrieval.
- **Proposed Architecture (ADR candidate):** The harness's `memory` extension should formally enforce a two-tier system:
  1.  **Raw Episodic Memory:** (Daily runs/digests).
  2.  **Curated Semantic Memory:** (`MEMORY.md` or a structured SQLite equivalent).
      The harness should provide a built-in `curate_memory` tool that forces agents to periodically distill their daily digests into the curated memory file, actively pruning dead context.

## 4. Verification over Generation

**The Insight:** The agent would confidently report "deployment complete" when the app was broken.
**Harness Application:**

- **Current State:** An agent completes its wake and reports success.
- **Proposed Architecture:** Introduce a **Verification Protocol**. If an agent executes a state-mutating tool (e.g., `github.create_pull_request`, `push_files`), the harness should require a subsequent verification tool call (e.g., `github.get_pull_request_status`) before the wake can be marked `effectiveness: high`. Unverified state changes should be flagged.
