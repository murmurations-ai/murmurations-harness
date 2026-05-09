# Research Note: Applying Lessons from OpenClaw's Architecture

**Date:** 2026-05-07
**Context:** Based on openclaw/openclaw (GitHub, 250k+ stars), docs.openclaw.ai, arXiv 2603.10165 (OpenClaw-RL), and the YouTube video "Your AI Agent Is Locked To One Model. OpenClaw Just Killed That." (https://www.youtube.com/watch?v=85Q9htV2CBE).

OpenClaw is a local-first, personal AI assistant runtime — "an operating system for AI agents" — with 20+ messaging platform adapters, a hub-and-spoke Gateway, and a pluggable provider/model/runtime tripartite. It is not an autonomous scheduled agent harness, but its internal architecture independently converged on several patterns we are building in Proposal 07, and diverged in ways that confirm our design choices for headless operation.

---

## 1. Prompt Cache Boundary (New — not in prior research)

**The Insight:** OpenClaw uses a concept called `SYSTEM_PROMPT_CACHE_BOUNDARY` — an explicit delimiter separating stable workspace context (identity, AGENTS.md, SOUL.md, IDENTITY.md) from volatile session state (signals, memory search results, tool definitions for this turn). This boundary is intentional: it maximizes Anthropic's prompt KV cache reuse. Stable content before the boundary is cached across turns; volatile content after is not.

**Harness Application:**

- **Current State:** Proposal 07's PromptAssembler (Phase 2) will naturally create this split because identity/role/contract segments are stable while signals/health/memory are volatile. But the boundary is implicit — an accidental property of segment ordering.
- **Proposed Addition to Phase 2:** Introduce `PromptBundle.cacheAnchor` — an explicit marker in the assembled prompt buffer after the last stable segment, before the first volatile segment. This should be a named concept in ADR-0045 (Prompt Boundary), not left to implementation convention.
- **Why this matters:** With wakes at 23:00 PT nightly, identical stable segments across all agents are prime cache candidates. Each cache miss on stable content is wasted cost. The boundary makes the optimization explicit and auditable via the `promptHash`.

---

## 2. Field Validation for the Subtraction Principle

**The Insight:** OpenClaw reached 250,000 GitHub stars without any internal verifier agents. Its architecture is: agent calls tool → tool executes → result returned → agent continues. The Command Queue (serialized one-message-at-a-time per session) enforces ordering without adding a verification layer.

**Harness Application:**

- This is the strongest independent field validation of Proposal 07's Subtraction Principle. OpenClaw is not an academic benchmark — it is a widely deployed production system. It chose not to add verifier agents. The Stanford/Tsinghua benchmarks (−0.8 to −8.4 with verifiers) now have a large-scale production counterpart that confirms the same conclusion.
- **For consent round #352:** The subtraction principle is not a preference — it is convergently validated across academic benchmarks, a 27-domain production experiment (Minerva), and now a 250k-star open source runtime (OpenClaw). Add this to the architectural principles evidence base.

---

## 3. Tool Policy Precedence Ladder (Reference for Phase 7)

**The Insight:** OpenClaw's sandbox configuration follows an explicit precedence chain:

```
Tool Profile → Provider Profile → Global → Provider → Agent → Group → Sandbox
```

Later levels override earlier ones. This makes policy inheritance predictable and auditable. MCP subprocesses receive only the declared subset of env vars for their session type.

**Harness Application:**

- **Current State:** Proposal 07's Phase 7 (`EnvironmentSpec` + `ContainerExecutor`) declares the intent for least-privilege sandboxing but does not yet specify a precedence model for how per-role policy overrides global defaults.
- **Proposed Addition:** ADR-0047 (Execution Contracts) or the Phase 7 spec should define a precedence ladder analogous to OpenClaw's. A candidate for Murmurations:
  ```
  Harness Default → Group Policy → Role Policy → Wake Override
  ```
  Each level narrows or restricts, never expands beyond its parent. The EnvironmentSpec assembled for a wake is the intersection of all applicable layers, and is recorded by hash in the ledger.
- This also applies to MCP env grants: the `EnvironmentSpec.secretGrants` field should enforce that the most restrictive applicable policy wins.

---

## 4. Model-Agnostic Runtime (Confirms Harness-as-IP, Adds nothing new)

**The Insight:** OpenClaw's headline claim is Provider + Model + Runtime separation — swap the model or backend without changing the agent identity. Sessions are bound to their initial runtime; users must `/new` to switch.

**Harness Application:**

- Proposal 07 already treats this as solved via `ResolvedModel` in `AgentRuntime` and the harness-as-IP principle. OpenClaw's framing confirms the direction; no new architectural input.
- The session-binding pattern (no hot-switching mid-transcript) has a Murmurations analogue: an agent's role.md and soul.md should not change mid-run. The daemon already enforces this by loading identity at spawn, not mid-wake.

---

## 5. Two-Tier Memory with Hybrid Search (Future Reference)

**The Insight:** OpenClaw implements MEMORY.md (stable curated facts) + daily rolling logs (episodic), with a SQLite backend providing vector embedding + BM25 hybrid search across the episodic store. Memory flush before session compaction promotes important details to MEMORY.md.

**Harness Application:**

- **Current State:** Proposal 07 Phase 6 adds the `curate_memory` built-in tool and the two-tier convention. The episodic tier is GitHub digests + JSONL logs. No vector search.
- **This research does not change Phase 6.** The current plan (agent-curated MEMORY.md, no vector retrieval) is correct for the current scale.
- **Future reference (post-Phase 6):** If agent knowledge bases grow to the point where MEMORY.md becomes unwieldy, OpenClaw's hybrid approach (vector + BM25 on SQLite) is the proven next tier. Their embedding provider priority (local → OpenAI → Gemini → disabled) is a clean fallback chain worth reusing.

---

## 6. Prompt Trust Levels — What OpenClaw Is Missing (Confirms P07 Direction)

**The Insight:** OpenClaw defends against prompt injection through context isolation (source metadata distinguishes user messages from system instructions), structured tool result wrapping, and layered access controls. But there is no formal trust propagation rule. OpenClaw has no equivalent of: "untrusted text cannot grant tools, alter policy, request secrets, override completion criteria, or authorize mutation."

**Harness Application:**

- For an interactive assistant, this is acceptable — the human is always in the loop and can catch a malformed tool call.
- For Murmurations, where GitHub issue bodies (written by external contributors or agents-as-commenters) are injected into the signal bundle and processed headlessly, the absence of formal trust propagation is a real attack surface.
- **This confirms Proposal 07's trust model is not over-engineering.** The `trusted / semi-trusted / untrusted` PromptSegment classification and the propagation rules (untrusted text cannot grant tools, alter policy, etc.) are required for safe headless operation, not optional hardening.
- **Practical note:** The signals segment is `untrusted` because issue bodies are external contributor content. The identity and role segments are `trusted`. The governance segment is `trusted`. Memory is `semi-trusted` (curated by the agent but sourced from prior wakes). These classifications should be encoded in ADR-0045, not left to convention.

---

## Summary: What Proposal 07 Should Add

| Finding                                         | Where to apply                                                                      |
| ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| Cache boundary (`SYSTEM_PROMPT_CACHE_BOUNDARY`) | ADR-0045 (Prompt Boundary) — add `PromptBundle.cacheAnchor`                         |
| Subtraction Principle field validation          | Proposal 07 §Architectural Principles — add OpenClaw to evidence base               |
| Tool policy precedence ladder                   | Phase 7 spec / ADR-0047 — add precedence model for EnvironmentSpec                  |
| Trust level formalization for headless agents   | ADR-0045 (Prompt Boundary) — encode trusted/semi-trusted/untrusted per segment kind |

## What Proposal 07 Need Not Change

- ExecutionContract design — OpenClaw has no equivalent and doesn't need one (interactive model). Murmurations does. Confirmed correct.
- GovernancePlugin — OpenClaw has no governance layer. Confirmed correct for sociocratic orgs.
- RunLedger (hash-chained) — OpenClaw has append-only session logs. Confirmed that the ledger is uniquely necessary for headless audit.
- WakeHealthActuals + Langfuse self-improvement loop — No OpenClaw equivalent. Confirmed differentiating capability.
