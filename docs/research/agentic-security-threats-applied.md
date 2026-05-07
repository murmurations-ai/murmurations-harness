# Research Note: Applying the Agentic Security Threat Taxonomy

**Date:** 2026-05-07
**Context:** Based on "From Secure Agentic AI to Secure Agentic Web: Challenges, Threats, and Future Directions"
(arXiv 2603.01564, March 2026) and "Agentic AI Security: Threats, Defenses, Evaluation, and Open Challenges"
(arXiv 2510.23883, October 2025). These are the most comprehensive formal threat taxonomies for autonomous
AI agents published to date.

---

## 1. The Six-Category Threat Taxonomy — Named Threats for ADR-003X

The taxonomy identifies six attack categories. All six are relevant to Murmurations. Each has a direct
mapping to a Proposal 07 component.

| Threat Category           | Attack Pattern                                                                                        | P07 Component Targeted                                   | Current Mitigation                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Prompt Abuse**          | Directive overrides, jailbreak prompts, instruction hierarchy bypass                                  | PromptBundle trust levels                                | `trusted / semi-trusted / untrusted` classification, propagation rules                         |
| **Environment Injection** | Malicious content in retrieved documents, indirect injection via summarization                        | SignalBundle (GitHub issue bodies)                       | `untrusted` classification for signals, sanitizer/renderer                                     |
| **Memory Attacks**        | Memory poisoning, sensitive data disclosure, cross-session persistence of malicious facts             | Tier 2 memory (MEMORY.md), agent-written skills          | `semi-trusted` for memory segments, security scan before write, signed provenance in RunLedger |
| **Toolchain Abuse**       | Improper tool invocation, dangerous tool compositions, MCP supply-chain, trust-authorization mismatch | ToolRegistry, EnvironmentSpec                            | Deny-by-default, ToolGrant allowlists, MCP allowlist+pin, ApprovalPolicy                       |
| **Model Tampering**       | Backdoor triggers, dormant activation, RL poisoning                                                   | ResolvedModel                                            | Outside harness scope (model selection hygiene); note in ARCHITECTURE.md                       |
| **Agent Network Attacks** | LLM-to-LLM propagation, routing inversion, cross-agent directive injection                            | SignalBundle routing (harness#353/354), GovernancePlugin | Per-agent routing filter (harness#353 fix), effectiveness scoring fix (harness#354 fix)        |

**Harness Application:**

- **ADR-003X (Prompt Boundary)** should open with this taxonomy as the threat model section. It names the specific attacks the trust classification defends against. Without a named threat model, the trust classification reads as defensive engineering preference; with it, it reads as a necessary response to known production threats.
- **Environment Injection is the most underweighted threat in current P07 language.** GitHub issue bodies are external, adversarial content by default. The paper states: "the web is an untrusted and adversarial environment by default." GitHub is not the web, but contributor-authored issue content has the same trust posture as web content. The `untrusted` signal classification is correct, but the rationale — environment injection, not just prompt hygiene — should be stated.
- **Agent Network Attacks directly names the harness#353/354 bug class.** The routing inversion bug (one agent receiving another's directives) and the effectiveness scoring bug (out-of-scope directives penalizing the agent) are both instances of "cross-agent directive injection." The field evidence from CW agents (Proposal 07 gap G1/G6 field validation) now has a formal threat category. Cite this in ADR-003X and the consent round issue.

---

## 2. Three System-Level Security Primitives — The Architecture Must Name These

The paper identifies three primitives required for secure agentic systems:

1. **Interoperable Identity & Authorization** — explicit delegation constraints addressing trust-authorization mismatch
2. **Provenance & Traceability** — metadata on requests, intermediate artifacts, and tool outputs; auditable blame
3. **Ecosystem-Level Response** — quarantine, revocation, and recovery mechanisms to limit blast radius

**Harness Application:**

- **Primitive 1 (Identity & Authorization)** maps to: `AgentId`-keyed isolation, `GovernancePlugin`, `ToolGrant.allowedAgentIds`, `EnvironmentSpec.secretGrants`. The ToolGrant model (which agents can call which tools) and the EnvironmentSpec model (which secrets go to which tools for which agents) together implement delegation constraints. Name these as the harness's Identity & Authorization implementation in ARCHITECTURE.md.
- **Primitive 2 (Provenance & Traceability)** maps to: `RunLedger` (hash-chained, append-only), `ToolCallReceipts` (policy decision, input/output hashes, approval metadata), `artifactRefs` in `RunLedgerEntry`, and — from Hermes research — signed provenance for agent-written skill/knowledge files. The RunLedger IS the provenance and traceability implementation. Name it as such.
- **Primitive 3 (Ecosystem Response)** maps to: `HealthState` circuit breaker (pause on repeated idle/low-effectiveness wakes), `GovernancePlugin` tension protocol, and the manual Source-intervention path. Post-Phase 5, the health metrics feed into automated escalation. This is Murmurations' blast-radius containment mechanism.

---

## 3. Toolchain Abuse — Dangerous Tool Compositions Are a Named Threat

**The Insight:** The paper specifically warns about "dangerous chains of innocent tools" — situations where individual tool calls each appear benign but their composition causes harm. Example: `read_file` + `send_email` individually are fine; chained together without explicit review they exfiltrate data.

**Harness Application:**

- **`ToolDescriptor.requiresVerification`** in Proposal 07 is the correct defense: high-risk tool combinations require explicit verification before execution. But the composition risk means verification should be triggered not only by individual tool permissions but by _combinations_ of tools within a single wake.
- **`ExecutionContract.allowedSideEffects`** should be evaluated against the entire tool call sequence, not per-call. If the contract allows `read` and `network` side effects separately, but the combination of both in the same wake creates an exfiltration path, the validator should flag it.
- **Phase 3 addition:** `ToolInvocationRecorder` should track which tools were called in what order within a wake. Post-wake analysis (or real-time analysis during Evaluate) can detect dangerous compositions. Add this as a Phase 3 enhancement item.

---

## 4. Memory Attacks — Formal Confirmation of Skill Poisoning + Shared Knowledge Base Risk

**The Insight:** The taxonomy explicitly names memory poisoning as an attack category: "deliberate corruption of persistent agent memory and knowledge bases to influence future reasoning." For shared organizational knowledge bases, "a single poisoning can persist and be reused many times, affecting numerous future tasks."

**Harness Application:**

- **This formally confirms the skill poisoning threat** identified in the Hermes research. The taxonomy adds a second concern: **shared memory across agents**. In Murmurations, multiple agents read from the same GitHub repository (shared signal channel). A poisoned directive committed to the repo could affect all agents that consume it. This is a multi-agent variant of the memory attack.
- **Defense required:** The harness already addresses single-agent memory poisoning via `semi-trusted` classification. The multi-agent variant requires the per-agent routing filter (harness#353) to be understood not just as a correctness fix but as a security primitive — cross-agent directive isolation is a memory attack defense.
- **RunLedger provenance** (which wake wrote which artifact, from which signals) is the forensic mechanism that enables identifying and revoking poisoned memory. This strengthens the argument for Phase 6 signed artifact provenance.

---

## 5. Defense Priority Matrix — For ADR-003X and Consent Round

From the paper's defense recommendations, mapped to Proposal 07 phases:

| Defense                                                 | Mechanism                                       | Phase                    |
| ------------------------------------------------------- | ----------------------------------------------- | ------------------------ |
| Prompt hardening — separate instruction from content    | PromptSegment trust levels, sanitizer/renderer  | Phase 2 (ADR-003X)       |
| Tool control — least privilege + delegation constraints | ToolGrant + EnvironmentSpec.secretGrants        | Phase 3                  |
| Provenance tracking                                     | RunLedger hash-chaining + ToolCallReceipts      | Phase 4+                 |
| Runtime monitoring                                      | WakeHealthActuals + HealthState circuit breaker | Phase 5                  |
| Cross-agent isolation                                   | Per-agent routing filter (harness#353)          | Already shipped (v0.7.2) |
| Human approval gates                                    | ApprovalPolicy + INTERRUPT/RESUME pattern       | Phase 7                  |
| Memory provenance                                       | Signed artifact refs in RunLedger               | Phase 6                  |

---

## Summary: What Proposal 07 Should Add

| Finding                                              | Where to apply                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Six-category threat taxonomy                         | ADR-003X opening section — named threat model for trust classification                     |
| Environment injection naming for GitHub signals      | ADR-003X — rationale for `untrusted` signal classification                                 |
| Agent Network Attacks = harness#353/354 threat class | Proposal 07 §Gap Analysis G1/G6 + consent round issue — cite taxonomy                      |
| Three system-level security primitives               | ARCHITECTURE.md — name Identity/Authorization, Provenance/Traceability, Ecosystem Response |
| Dangerous tool composition detection                 | Phase 3 spec — `ToolInvocationRecorder` tracks call sequence; Evaluate checks composition  |
| Shared-memory multi-agent poisoning                  | ARCHITECTURE.md + ADR-003X — routing isolation as security primitive, not just correctness |
