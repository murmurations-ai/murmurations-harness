# Research Note: Applying Lessons from Hermes Agent's Architecture

**Date:** 2026-05-07
**Context:** Based on NousResearch/hermes-agent (GitHub, 103k+ stars), hermes-agent.nousresearch.com/docs,
arXiv ICLR 2026 Oral (GEPA), and multiple independent architectural reviews (Hugging Face Forum, Medium/Kisztof, DEV Community).

Hermes Agent is an open-source autonomous agent built by Nous Research (released February 2026).
It is the first major framework explicitly built around a **closed learning loop** — the agent writes
skills from its own experience and improves them via GEPA (Genetic-Pareto optimization). Unlike
OpenClaw (interactive assistant), Hermes is positioned for long-running asynchronous agents. Its
closest architectural analogue to Murmurations is the scheduled, persistence-first execution model —
but with a self-improvement layer that has no equivalent in Proposal 07 yet.

---

## 1. Skill Poisoning — The Named Threat Proposal 07's Trust Model Already Solves

**The Insight:** Hermes's security review identifies **skill poisoning** as a critical unresolved vulnerability:

> "Single-turn prompt injection becomes persistent. A compromised session generates a skill file that
> loads as trusted context on future runs. No signed provenance or review workflow currently exists."

The attack chain:

1. Attacker crafts a message that causes the agent to complete a 5+ tool-call workflow
2. The post-task GEPA loop extracts a "skill" from the trajectory
3. The malicious skill file is written to disk and loads as context on every subsequent wake
4. The compromise is now self-reinforcing across all future sessions

Hermes has no mitigation beyond blocking obvious injection patterns at the session boundary (`tools/approval.py`). Skills are `trusted` by default; there is no formal trust classification.

**Harness Application:**

- **This is the most architecturally significant finding.** It names exactly the attack that Proposal 07's trust model is designed to prevent.
- In Proposal 07, memory and skills segments are classified `semi-trusted` — they are agent-curated, but sourced from prior wakes and external interactions. They cannot grant tools, alter policy, request secrets, override completion criteria, or authorize mutation.
- **For consent round #352:** Add "skill poisoning" as a named threat in ADR-0045 (Prompt Boundary). The `semi-trusted` classification for `memory` and `skills` segments directly mitigates this attack. The propagation rule — untrusted/semi-trusted text cannot grant tools or alter policy — is the defense.
- **Signed provenance:** Hermes currently has no skill signing. For Murmurations, `ToolCallReceipts` and `RunLedger` hash-chaining already provide a provenance trail for agent-written artifacts. When skills are eventually agent-generated (Phase 6), the ledger should record which wake produced which skill file and what signals it was derived from.

---

## 2. Three-Tier Memory (Validates P07 Direction, Adds USER.md Pattern)

**The Insight:** Hermes implements:

- **MEMORY.md** (~800 tokens, 2,200 char limit): agent's learned facts, project conventions, workarounds
- **USER.md** (~500 tokens, 1,375 char limit): user profile — stack preferences, communication style, terminology
- **External provider** (optional): Honcho, Mem0, Hindsight — one active at a time, for extended persistence
- **SQLite FTS5 session index**: keyword search for "find the session where I solved this problem before"

Critical design decisions:

- **Frozen snapshot pattern**: both files load at session start as immutable prefix-cached blocks — they cannot be modified mid-session
- **Character limits enforce discipline**: when >80% full, agent consolidates — merges related facts, removes outdated entries. This forces selectivity.
- **Security scan before write**: blocks prompt injection, credentials, and suspicious Unicode
- **Write triggers**: explicit corrections, discovered environment facts, patterns from repeated behavior, 5+ tool-call workflows

**Harness Application:**

- Proposal 07's two-tier memory (Phase 6) is validated. The frozen snapshot + prefix cache pattern aligns with the `cacheAnchorIndex` principle added from OpenClaw.
- **New input:** Hermes's character-limit consolidation discipline is worth encoding in the `curate_memory` built-in. The trigger "when >80% full, consolidate" is concrete and operator-configurable. Proposal 07's Phase 6 should define the curation trigger as a role.md field (e.g., `memory.consolidate_threshold: 0.8`), not leave it to agent discretion.
- **New input:** The **USER.md pattern** (persistent user profile, separate from agent memory) has a Murmurations analogue in `Source.md` — but Source context is static, not dynamically updated from interactions. Post-Phase 6, consider whether a `source-profile.md` that agents update based on Source's stated preferences (in directives, consent responses, etc.) would improve orientation. This is not a Phase 6 item — it is a future direction.
- The FTS5 keyword session search (not vector) is a deliberate architecture choice with a strong rationale: "find the session where I solved this exact problem" is better served by keyword precision than semantic similarity. Murmurations uses GitHub issues + jdocmunch. Different surface, same practical need.

---

## 3. GEPA Self-Improvement Loop — A Future Capability Murmurations Lacks

**The Insight:** GEPA (Genetic-Pareto, ICLR 2026 Oral) is Hermes's differentiating capability:

1. Agent completes a complex task (5+ tool calls)
2. GEPA analyzes the full execution record: error messages, performance profiling, reasoning chains
3. An LLM recommends targeted improvements to prompts and procedures
4. A skill file is written capturing: execution steps, decision points, failure modes, validation logic
5. On future similar tasks, the skill is injected as context — agent solves faster
6. Performance feeds back into the GEPA loop for refinement

Result: agents with 20+ self-generated skills run 40% faster on repeated tasks in the same domain (ICLR 2026 benchmark). The 118 bundled skills ship pre-reviewed.

**Comparison to Proposal 07's Langfuse self-reflection (Phase 5):**

|            | Hermes GEPA                                                | Murmurations Phase 5                                             |
| ---------- | ---------------------------------------------------------- | ---------------------------------------------------------------- |
| Input      | Full execution trace (errors, profiling, reasoning chains) | WakeHealthActuals + Langfuse metrics                             |
| Analysis   | External LLM call on trajectory                            | Agent self-reports effectiveness; harness derives health metrics |
| Output     | Skill file (reusable procedure)                            | Governance proposal → consent round                              |
| Loop       | Automatic, per-task                                        | Per-wake, governance-gated                                       |
| Governance | None — autonomous                                          | GovernancePlugin — S3 consent required for structural changes    |

GEPA and the Langfuse loop are **complementary, not competing**. GEPA optimizes task-level procedures; the Langfuse loop feeds architectural improvement through governance. For Murmurations, GEPA-style trace analysis is a future direction for Phase 6/post-6 — the execution record built by `ToolCallReceipts` + `RunLedgerEntry` is already the right substrate for a GEPA-equivalent loop.

**For ADR-0047 (Execution Contracts):** The GEPA loop confirms that complete, machine-readable execution traces (not just cost records) are required for any self-improvement mechanism. `RunLedgerEntry` with `toolReceipts`, `actionReceipts`, `validation`, and `health` is the correct design — it is the data that GEPA-equivalent analysis would need.

---

## 4. Tool Registry — Validates Auto-Discovery, Flags MCP Supply-Chain Gap

**The Insight:** Hermes's tool registry (`tools/registry.py`):

- **61 tools, 52 toolsets** — self-register at import time via `registry.register()`
- No manual import list needed; file presence drives availability
- Dangerous command detection via `tools/approval.py` — allowlist-based pre-execution filtering
- 7 terminal backends: local, Docker, SSH, Daytona, Modal, Singularity, Vercel
- **MCP supply-chain warning (from security review):** "no signing, no sandbox, and the discovery surface is the same surface that made npm a decade-long supply chain problem"

**Harness Application:**

- Proposal 07's `ToolRegistry` with `ToolDescriptor`, deny-by-default, and per-agent allowlists is architecturally more secure than Hermes's auto-discovery model. Hermes's model is convenient; Proposal 07's is safer for autonomous headless operation.
- **The MCP supply-chain warning is directly relevant.** Proposal 07 Phase 3 specifies that MCP server commands/configs should be allowlisted or pinned and recorded by hash. Hermes's security review provides an explicit production warning that confirms this requirement is not theoretical — it is the same npm-style supply-chain risk already identified.
- Hermes's `tools/approval.py` allowlist pattern for dangerous commands is a lightweight analogue to `ApprovalPolicy` in Proposal 07's `ToolDescriptor`. Both recognize that some tools need pre-execution human approval. The Hermes implementation is simpler (pattern matching); Proposal 07's is typed (`required` / `conditional` modes, `requiredFor` permissions).

---

## 5. Context Compression — Informs Token Budget Design

**The Insight:** Hermes uses `context_compressor.py` to summarize middle turns when context exceeds thresholds. This keeps the effective context window lean without truncating recent turns. Compression is a plugin-swappable component (`context_engine` plugin type).

**Harness Application:**

- Murmurations agents don't have multi-turn interactive transcripts — each wake is a fresh context. Context compression is not directly applicable.
- **However:** The pattern of middle-turn compression (summarize the middle, keep beginning and end) is relevant for G9 (two-tier memory). When episodic digests accumulate, the `curate_memory` tool should summarize the middle chronologically rather than truncating oldest-first. This preserves the agent's founding context while reclaiming token budget.

---

## 6. Profile Isolation — Validates AgentId Isolation Model

**The Insight:** Each Hermes profile gets a fully isolated `HERMES_HOME` — separate config, memory, sessions, gateway PID. This prevents cross-agent contamination and enables running multiple personas from one installation.

**Harness Application:**

- Murmurations already isolates by `agentId` in GitHub (per-agent file paths, per-agent label routing) and in the filesystem (`agents/<id>/`). The `EnvironmentSpec` in Proposal 07 extends this to runtime: each agent's env vars, writable paths, and secret grants are scoped.
- The profile isolation model confirms that `agentId`-keyed isolation is the correct primitive. No new input for Proposal 07.

---

## Summary: What Proposal 07 Should Add

| Finding                                       | Where to apply                                                                                           |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Skill poisoning as named threat               | ADR-0045 (Prompt Boundary) — document the threat, name `semi-trusted` classification as the mitigation   |
| Memory consolidation trigger                  | Phase 6 spec — `memory.consolidate_threshold: 0.8` in role.md schema; encode in `curate_memory` built-in |
| Signed provenance for agent-written artifacts | RunLedger Phase 6 — record wake + signals source for any agent-generated skill/knowledge file            |
| MCP supply-chain warning                      | Phase 3 spec / ADR — confirm allowlist+pin requirement with Hermes as production evidence                |
| RunLedger as GEPA substrate                   | ADR-0047 (Execution Contracts) — full execution trace is required for any future self-improvement loop   |

## What Proposal 07 Need Not Change

- ExecutionContract design — Hermes has no equivalent. Absence is the vulnerability, not the feature.
- PromptTrust levels — Hermes lacks these; skill poisoning is the consequence. Confirmed required.
- RunLedger (hash-chained) — Hermes has SQLite session logs with no hash chain. Confirmed required for audit.
- GovernancePlugin — Hermes has no governance layer. Agent improvement is fully autonomous. For sociocratic orgs, governance-gated improvement is intentional, not a limitation.
- WakeHealthActuals + Langfuse loop — Hermes's GEPA is a different loop serving a different purpose. Both should exist in a mature system; Phase 5 comes first.
