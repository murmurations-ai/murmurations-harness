# Research Note: Harness Engineering & Execution Contracts

**Date:** 2026-05-06
**Context:** Based on the video "Rethinking AI Agents: The Rise of Harness Engineering"

This video details recent academic findings (including Stanford's Meta Harness and Tsinghua's NLAH) showing that **harness design now drives up to a 6x performance variance compared to model selection.** The video explicitly validates our architectural choices and suggests new directions for the Murmuration Harness.

## 1. The "Operating System" Analogy

**Insight:** A raw LLM is just a CPU. Context is RAM. Databases are Disk. Tools are Device Drivers. The Harness is the OS that coordinates what the CPU sees and when.
**Application:** This perfectly validates our separation of the `AgentExecutor` from the `McpToolLoader` and `SignalAggregator`. We must continue treating the harness as an OS that restricts context (RAM) using `jdocmunch` rather than dumping entire drives into the context window.

## 2. Execution Contracts (Function Signatures for Agents)

**Insight:** Turning fuzzy LLM completions into bounded calls requires "Execution Contracts" with five elements: _Required Inputs, Budgets, Permissions, Completion Conditions, Output Paths._
**Application:**

- We currently have _Budgets_ (`max_cost_micros`) and _Permissions_ (`write_scopes`).
- **Gap:** We lack explicit _Completion Conditions_ and _Output Paths_ at the harness level.
- **Proposed ADR:** Extend the `role.md` schema to include explicit `output_paths` (e.g., `artifacts: ["drafts/*.md"]`) and `completion_conditions` so the `WakeCostBuilder` or `DaemonCommandExecutor` can programmatically verify an agent actually did what it was supposed to do before marking a wake `effectiveness: high`.

## 3. Pruning over Building (A Craft of Subtraction)

**Insight:** "Verifiers actively hurt... Multi-candidate search hurt... More structure is not always better... Mature harness work looks less like building structure up and more like pruning it down. A craft of subtraction as much as addition."
**Application:** We recently added `fact-checking-agent` and `quality-analyst-agent` as downstream verifiers. The research suggests naive verifier agents actively degrade performance.
**Proposed Action:** Instead of adding more QA agents, we should focus on "Artifact-backed completion" (which we already do via `.pipeline/` YAML files) and **narrow attempt loops**. The agent's own attempt loop should stay narrow until a specific failure signal justifies broadening.

## 4. Transferable Assets

**Insight:** "A harness optimized on one model transferred to five others... The reusable asset isn't the model, it's the harness."
**Application:** This is our core value proposition. The `harness.yaml` and `role.md` structures we are building can outlive Gemini 3.1 Pro or Claude Opus. We are building the durable asset.

## Conclusion

Our architecture is on the exact right trajectory (especially regarding file-backed state and discrete roles), but we need to formalize **Execution Contracts** (output paths and completion conditions) and be very careful about adding complex "Verifier" agents which the research shows actively degrade system performance.
