# Research Note: Applying "Beyond Task Completion" Assessment Framework

**Date:** 2026-05-07
**Context:** Based on "Beyond Task Completion: An Assessment Framework for Evaluating Agentic AI Systems"
(arXiv 2512.12791, March 2026). This paper independently derives a 4-pillar agent decomposition and
provides the strongest academic argument for why completion contracts must encode _how_ tasks execute,
not just _whether_ they finish.

---

## 1. The 4-Pillar Framework — Independent Derivation of AgentRuntime

**The Insight:** The paper proposes evaluating agentic systems across four pillars:

| Pillar          | Covers                                                         | Maps to AgentRuntime                          |
| --------------- | -------------------------------------------------------------- | --------------------------------------------- |
| **LLM**         | Instruction following, safety/alignment, policy adherence      | Model layer                                   |
| **Memory**      | Storage accuracy, retrieval accuracy, multi-hop reasoning      | Prompt layer (memory segment) + Tier 2 memory |
| **Tools**       | Selection, parameter mapping, sequencing, error interpretation | Toolset layer                                 |
| **Environment** | Workflows, configurability, guardrails, access controls        | Environment layer + ExecutionContract         |

This is an independent academic derivation of the same four-layer decomposition as AgentRuntime.
The correspondence is not incidental — it reflects the actual structure of the problem.

**Harness Application:**

- **Cite this paper in Proposal 07's Consent Framing section.** The `AgentRuntime = Model + Prompt + Toolset + Environment + ExecutionContract + Ledger` decomposition now has three independent derivations: Anthropic/Barry Zhang (practitioner), Tsinghua NLAH (academic), and arXiv 2512.12791 (evaluation framework). Three independent convergences on the same structure is strong validation for the consent round.
- The paper's three **evaluation modes** (static analysis, dynamic execution monitoring, LLM-as-Judge) map to Proposal 07's three validation surfaces: `WakeValidationResult` (structured evidence, static), `WakeHealthActuals` (dynamic, rolling window), and the Langfuse self-reflection signal (LLM-as-Judge equivalent). The harness is building the correct evaluation substrate.

---

## 2. The Critical Finding: Completion ≠ Correctness — The Central Argument for ExecutionContract

**The Insight:** In their CloudOps experiments, agents achieved:

- **100% task completion rate** (conventional metric)
- **33% policy adherence** (behavioral metric)
- **13.1% memory recall** (memory metric)

An agent can complete every task while doing two-thirds of them incorrectly from a policy standpoint and failing to recall nearly 90% of relevant memory. Conventional outcome metrics are blind to these failures.

The paper's conclusion: **completion contracts must encode _how_ tasks execute (behavioral correctness), not just _whether_ they finish (outcome).** Specifically, agents must be evaluated on:

- Intermediate state validation (tool invocations during execution, not just final output)
- Policy compliance across execution path (not just at the result)
- Memory utilization during execution (did the agent use relevant recalled context)

**Harness Application:**

- **This is the strongest academic argument for the ExecutionContract and WakeValidator.** The paper provides empirical evidence that a harness without execution contracts will produce agents that appear to complete work while routinely violating policy and ignoring memory. This is exactly the failure mode Proposal 07's G2 (no completion conditions) describes.
- **For consent round #352:** Add this finding directly to the Consent Framing section. The question "why do we need ExecutionContract?" now has a quantified answer: without it, agents will achieve 100% apparent completion with 33% actual policy compliance. The 67-point gap is the cost of not having contracts.
- **WakeValidator must validate intermediate state, not just final output.** The current design validates post-wake: did the required outputs exist? The paper's finding suggests that intermediate validation (were policy-compliant tool calls made during the wake?) is also required. This is the distinction between:
  - _Outcome validation_: required artifacts exist ✓
  - _Behavioral validation_: tool calls during the wake were policy-compliant ✓
    Both are needed. `ToolCallReceipts` is the mechanism for behavioral validation — the ledger records every tool call with its policy decision, enabling post-wake replay analysis.
- **Memory recall validation:** The 13.1% recall finding is alarming for Murmurations. Agents that fail to use their MEMORY.md context despite it being present produce output that ignores their own prior learning. Phase 6's `curate_memory` built-in and the memory `semi-trusted` segment are necessary but not sufficient — the harness should also track whether memory content was referenced in the wake's LLM trace. This is a Phase 5/6 enhancement: add `memorySegmentReferenced: boolean` to `WakeHealthActuals`.

---

## 3. Tool Sequencing — Validates Dependency Graph (G6)

**The Insight:** The paper's Tools pillar includes "Tool Sequencing" as a distinct evaluation dimension: respecting dependencies and "diagnostic-before-action ordering." Agents that skip diagnostic tool calls before taking mutating actions are evaluated as failing on sequencing, even if the final outcome appears correct.

**Harness Application:**

- **This directly validates Proposal 07's G6 (dependency-aware signal graph).** The `actionItemGraph` (actionable vs. blocked items) ensures agents don't attempt to act on blocked tasks — but the sequencing concern also applies within a single task's tool call sequence. An agent should call read/diagnostic tools before write/mutating tools. `ToolDescriptor.mutability` (read-only vs. mutating) already captures this; the WakeValidator should check that mutating tool calls are preceded by relevant read calls (or that the contract explicitly allows direct mutation).
- **`ToolCallReceipts` ordered by timestamp** enables sequencing validation. Post-wake, the sequence of tool calls can be checked against expected diagnostic-before-action ordering for known task types. This is a Phase 4/5 enhancement.

---

## 4. Three Evaluation Modes — Harness Already Builds All Three

**The Insight:** The framework identifies three complementary evaluation modes:

1. **Static analysis** — keyword verification, policy check (deterministic, fast)
2. **Dynamic execution monitoring** — action stream oversight, intermediate state tracking
3. **LLM-as-Judge** — qualitative reasoning, safety, memory utilization scoring

**Harness Application:**

- **The harness already builds the infrastructure for all three:**
  - Static → `WakeValidationResult` (did required outputs exist? are ToolCallReceipts compliant?)
  - Dynamic → `WakeHealthActuals` (rolling window health, effectiveness decay, tool error density)
  - LLM-as-Judge → Langfuse self-reflection skill (Phase 5)
- This confirms the Phase ordering in Proposal 07: static validation (Phase 4) before health metrics (Phase 5) before LLM self-reflection (Phase 5/6). The assessment framework independently validates this sequence.

---

## Summary: What Proposal 07 Should Add

| Finding                                                               | Where to apply                                                                               |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 100%/33%/13.1% finding — completion ≠ correctness                     | Consent Framing — quantified argument for ExecutionContract                                  |
| 4-pillar = 3rd independent derivation of AgentRuntime                 | Consent Framing — cite as convergent validation alongside Barry Zhang + NLAH                 |
| Behavioral validation (tool calls during wake) vs. outcome validation | Phase 4 spec — `ToolCallReceipts` enables behavioral replay; WakeValidator should check both |
| Memory recall validation                                              | Phase 5/6 — add `memorySegmentReferenced` to `WakeHealthActuals`                             |
| Tool sequencing validation                                            | Phase 4/5 — ordered `ToolCallReceipts` enable diagnostic-before-action sequencing check      |
