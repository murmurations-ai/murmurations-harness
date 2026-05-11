# ADR-0047 — Execution Contracts: obligation/permission split + dual validation surfaces

- **Status:** Proposed
- **Date:** 2026-05-08
- **Decision-maker(s):** Source (Nori), Engineering Circle
- **Consulted:** Architecture review of Proposal 07; arXiv 2512.12791 ("Beyond Task Completion"); Tsinghua NLAH execution-contract framework
- **Supersedes:** None
- **Gates:** Proposal 07 Phase 4 implementation
- **Originally referenced as "ADR-003Y"** in earlier drafts of `docs/proposals/07-harness-engineering-target-architecture.md` §5 and §Migration Plan. Numbered 0047 here per the monotonic-numbering rule (ADR README §Numbering); proposal references have been updated.

## Context

Proposal 07 (the harness target architecture) declares `ExecutionContract` as one of the six elements of `AgentRuntime` and identifies the contract layer as a **P0 correctness gap** (Gap G2). The Tsinghua NLAH research enumerates five contract elements; three are present in the harness today (Required Inputs, Budgets, Permissions) and two are missing (Completion Conditions, Output Paths). Without those two, the harness cannot tell what a successful wake looks like — it can only count artifacts produced, which is the shallow `idleWakes` heuristic in `AgentStateStore`.

Three forces converge on the need for a formal contract:

1. **Completion ≠ correctness.** arXiv 2512.12791 measured production CloudOps agents at **100% task completion / 33% policy adherence / 13.1% memory recall**. An agent can complete every task while doing two-thirds incorrectly from a policy standpoint. Outcome metrics alone are blind to a 67-point compliance gap. A validator that checks only "did the agent produce artifacts?" lets two-thirds of misbehavior pass.

2. **Obligation and permission collapse without an explicit boundary.** The current `WakeAction` validation enforces write scopes (a permission concern) and the post-wake validator counts artifacts (an obligation concern), but neither knows about the other. When a wake fails, there is no way to say _which sub-contract_ it violated — was the agent permitted to do what it tried to do, or did it fail to produce what was required? Conflating the two obscures every diagnosis.

3. **The scaffolding already exists; the wiring is missing.** Proposal 07 Phase 0 landed types-only definitions of `ExecutionContract`, `ToolCallReceipt`, `ToolDescriptor`, `ToolPermission`, `ApprovalPolicy`, `CompletionCondition`, and `VerificationStep`. The `RunLedgerEntry` already has fields for `toolReceipts`, `contractHash`, and `validation`. None of it is populated by the runtime. A consent round on the enforcement semantics is the next gate before turning the scaffolds on.

This ADR establishes those enforcement semantics so Phase 4 implementation can begin.

## Decision

### 1. Five-element execution contract

`ExecutionContract` (defined in `packages/core/src/runtime/execution-contract.ts`) is the canonical per-wake contract. It consists of:

| Element                   | Field(s)                                                                         | Source                                                                              |
| ------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **Required Inputs**       | `signals` (in `AgentSpawnContext`)                                               | `role.md` `signals.sources` + signal aggregator                                     |
| **Budgets**               | `budget: CostBudget`                                                             | `role.md` `budget.*`, daemon ceiling                                                |
| **Permissions**           | `allowedSideEffects: readonly ToolPermission[]`                                  | `role.md` `github_scopes`, declared tool grants                                     |
| **Completion Conditions** | `requiredOutputs[]`, `completionConditions[]`, `verification[]`, `actionItems[]` | `role.md` `contract.done_when`, `contract.committed_artifacts`, signal action items |
| **Output Paths**          | `requiredOutputs[].path`, `requiredOutputs[].kind`                               | `role.md` `contract.committed_artifacts`, `contract.runtime_artifacts`              |

The five elements are not flat: they cluster into two distinct sub-contracts with distinct enforcement points. That clustering is the second decision below.

### 2. Obligation / permission split

The contract contains two sub-contracts with distinct lifecycles:

**Obligation sub-contract** — what the agent _must produce_ to be considered done.

- Fields: `requiredOutputs`, `actionItems`, `completionConditions`, `verification`
- **Enforced post-wake** by `WakeValidator`
- A wake that passes the model loop but fails any required obligation is recorded as `valid: false` and increments `idleWakes`, not `successfulWakes`
- A wake whose `requiredOutputs` cannot be partially-met (e.g., "summary OR commit") declares the disjunction explicitly — see _Disjunction & exemption_ below

**Permission sub-contract** — what the agent _is allowed to do_ during the wake.

- Fields: `allowedSideEffects`, `budget`, `approval`
- **Enforced pre-action** by the policy layer (existing write-scope check, tool grant check, `ApprovalPolicy` evaluation)
- A pre-action denial does not fail the wake; it returns a `denied` `ToolCallReceipt.outcome` and the model continues. The receipt is the audit trail
- A budget overrun terminates the wake with `policyDecision: "denied"` on the offending call

**Derivation rule for `allowedSideEffects` (revised 2026-05-11 per architecture review):** the harness already has three permission axes — `findReservedLabels()` enforces label write-scope; `ToolGrant.allowedAgentIds` deny-by-default authorizes tool access; `ApprovalPolicy.mode` gates approval-required tools. `ExecutionContract.allowedSideEffects` is **a coarse ceiling derived from**, not parallel to, those mechanisms:

> `allowedSideEffects` ⊆ (union of `ToolDescriptor.permissions` for tools granted to this agent via `ToolGrant.allowedAgentIds`)

The contract field cannot _grant_ permissions beyond what the existing layer has authorized; it can only declare a tighter ceiling than the union (e.g., a wake that's allowed `read | write | network` by grant might declare `allowedSideEffects: ["read", "write"]` to forbid network calls this wake). If the contract's ceiling is wider than the granted union, the wider claims are dropped during contract assembly and a `daemon.contract.permission.narrowed` log event is emitted. This keeps `ToolGrant` as the single authoritative source of capability; `allowedSideEffects` is a per-wake refinement, not a grant.

A failed wake's diagnostic surface (in `RunArtifactIndexEntry.validationStatus`) names which sub-contract was violated. "Failed obligation" and "failed permission" are not interchangeable.

### 3. Dual validation surfaces

`WakeValidator` runs **both** of the following after every wake. Each surface produces a typed result; the wake is `valid` only if both pass.

**A. Outcome validation** — `validateOutcomes(contract, runRecord) → OutcomeValidationResult`

- For each entry in `contract.requiredOutputs`: confirm an artifact of the declared `kind` exists at the declared `path` (or matches the path glob)
- For each entry in `contract.completionConditions`: evaluate the testable condition against the run record (existence checks today; pluggable evaluators in a future ADR)
- For each entry in `contract.verification` with `required: true`: confirm the verification step ran and passed
- For each entry in `contract.actionItems`: confirm the linked GitHub issue saw a mutation in this wake (comment, label, close)

**B. Behavioral validation** — `validateBehavior(contract, toolReceipts) → BehaviorValidationResult`

- The full `ToolCallReceipts` sequence (ordered by `startedAt`) is checked against `contract.allowedSideEffects` as a **composite permission set**, not per-call. Individual innocent calls can compose into harmful chains (e.g., `read` + `network` = data exfiltration without either permission being individually flagged). See `docs/research/agentic-security-threats-applied.md` §3.
- Diagnostic-before-action sequencing: when a known task type declares an expected ordering (e.g., `read_file` before `commit_file` for the same path), the validator flags out-of-order sequences. The full sequencing rules belong in a follow-up ADR; this ADR establishes that the surface exists and the receipt sequence is the substrate.
- A `denied` receipt is not a behavioral failure — it is the policy layer working as intended. A `failure` receipt is not a behavioral failure either — it is a tool-side error. A behavioral failure is a **valid sequence of permitted calls that violates contract intent** (e.g., the composite permission case above).

Both surfaces produce results stored in `RunArtifactIndexEntry.validationStatus` so post-hoc analysis can distinguish "agent completed but misbehaved" (outcome ✓ behavior ✗) from "agent failed correctly" (outcome ✗ behavior ✓) from "agent failed and misbehaved" (outcome ✗ behavior ✗).

### 4. `role.md` operator surface

Operators declare contract elements in `role.md` frontmatter:

```yaml
contract:
  done_when:
    - "At least one file committed to agents/<id>/knowledge/ or agents/<id>/digests/"
    - "OR at least one GitHub issue labelled, commented, or closed"
  committed_artifacts:
    - "agents/<id>/digests/*.md"
    - "agents/<id>/knowledge/*.md"
  runtime_artifacts:
    - ".murmuration/runs/<id>/*.md"
  verification_required_for:
    - "github.create_pull_request"
    - "github.push_files"
  approval_required_for:
    - "admin"
    - "ambient_network"
```

The mapping from this YAML into `ExecutionContract` happens in `buildSpawnContext`:

- `done_when[]` → `completionConditions[]` (each entry gets a stable `id` derived from a hash of the description)
- `committed_artifacts[]` → `requiredOutputs[]` with `kind: "committed-artifact"` and `path` = the glob
- `runtime_artifacts[]` → `requiredOutputs[]` with `kind: "runtime-artifact"`
- `verification_required_for[]` → `verification[]` with `required: true`
- `approval_required_for[]` → `approval.requiredFor` on the wake-level `ApprovalPolicy`
- Action items in the `SignalBundle` are mapped 1:1 into `actionItems[]` (signal id + source ref)

When `role.md` omits the `contract:` block entirely, `buildSpawnContext` synthesizes a minimal default:

- `requiredOutputs: [{ kind: "summary", description: "wake summary" }]`
- `completionConditions: []`
- `verification: []`
- `actionItems: <from signal bundle>`
- All permission fields fall back to today's behavior (write scopes from `github_scopes`, budget from `role.md` `budget`, `approval.mode: "none"`)

This makes the contract additive: existing roles continue to work; new roles opt into stricter validation by adding the `contract:` block.

### 5. Dual lifecycle — prompt injection at spawn, validation post-wake

The contract is used twice:

1. **At spawn time:** injected into the prompt as a `trusted` segment (per ADR-0045 trust classification) so the model knows what it must produce and what it is allowed to do. The injection is rendered text, not the raw object.
2. **Post-wake:** used as the validation frame by `WakeValidator`. The original `ExecutionContract` (with all fields) is hashed (SHA-256) and the hash is stored in `RunLedgerEntry.contractHash` for audit replay.

These two uses are **not redundant**. The first encodes intent for the model; the second checks what actually happened. A contract that is injected but not validated is a wishful prompt; a contract that is validated but not injected is a trap.

### 6. Disjunction & exemption

`completionConditions[]` is by default conjunctive (all must hold). Disjunction is expressed at the YAML level by joining clauses with `"OR"`-prefixed continuation lines, which `buildSpawnContext` parses into a single condition node with `kind: "any"` semantics. Exemption (a wake type that legitimately produces nothing — e.g., a noop poll) is expressed by an empty `requiredOutputs[]` _and_ an empty `completionConditions[]`; in that case `validateOutcomes` returns `{ ok: true, reason: "no obligations declared" }`. The pattern is explicit so a missing contract section is not silently equivalent to "anything is fine" — see decision §4.

### 7. ToolCallReceipt collection

`ToolCallReceipt` (defined in `packages/core/src/tools/receipts.ts`) is the immutable record of one tool invocation. The runtime collects receipts via a new `ToolInvocationRecorder` injected into the executor. Each receipt is appended to an in-memory list during the wake; on wake completion, the list is:

1. Persisted in `RunLedgerEntry.toolReceipts` (already declared in `runtime/run-ledger.ts`)
2. Passed to `WakeValidator.validateBehavior(contract, receipts)`
3. Available to a future GEPA-equivalent self-improvement loop (Hermes Agent §3, ICLR 2026 Oral)

Receipts never contain raw tool inputs or outputs — only SHA-256 hashes. Secret values are replaced with `[redacted]` before hashing; `secretGrantNames` records _which_ secrets were injected, not their values.

### 8. Backward compatibility & rollout

This ADR is **additive**:

- All `ExecutionContract` fields beyond `objective`/`wakeReason`/`wakeMode` default to empty arrays / today's behavior when `role.md` omits the `contract:` block.
- `WakeValidator` continues to fall back to the current artifact-counting heuristic when both `requiredOutputs` and `completionConditions` are empty (per decision §6).
- `ToolCallReceipts` collection is a no-op until tool wrappers are migrated to call the recorder; receipts are an empty list until then.
- `RunLedgerEntry.contractHash` is `undefined` for any wake whose contract is the synthesized minimal default (no operator-declared contract).

Phase 4 rollout sequence:

1. Wire `buildSpawnContext` to read `role.md` `contract:` block and assemble `ExecutionContract`
2. Inject the contract as a trusted prompt segment via `PromptAssembler`
3. Implement `validateOutcomes` and wire it into the post-wake hook (`AgentStateStore` already calls a validator; expand it)
4. Implement `ToolInvocationRecorder` and wire it through the executor
5. Implement `validateBehavior`
6. Wire validation results into `RunArtifactIndexEntry.validationStatus`

Each step is a separate PR. Each PR keeps the legacy code path intact (per Proposal 07's Phase 4 rollout strategy: _"the legacy code path remains intact through Phase 4"_).

## Consequences

**Easier:**

- Operators can declare what success looks like for an agent without writing custom validators.
- Failed wakes name which sub-contract was violated; debugging an idle agent goes from "I don't know what it was supposed to do" to "the agent met its obligation but its tool sequence violated the composite permission rule."
- The 67-point compliance gap (arXiv 2512.12791) becomes detectable, not invisible.
- `RunLedgerEntry` becomes a complete-enough substrate for a future self-improvement loop (GEPA-equivalent, Hermes §3) without a separate ADR.
- `ToolCallReceipts` are also the substrate for the INTERRUPT/RESUME approval pattern (LangGraph, Phase 7) — Phase 4 builds the bookkeeping that Phase 7 consumes.

**Harder:**

- Every role that wants stronger validation needs a `contract:` block in its `role.md`. The default fallback is permissive (per §4), but the operator burden is real for roles that opt in.
- `ToolInvocationRecorder` adds a small per-call overhead. Receipts are O(N) in tool calls per wake; for an agent making 50 tool calls a wake, that is 50 receipts × a few hundred bytes each = ~30 KB per wake in the ledger. This is bounded by the existing `maxToolCalls` budget.
- Behavioral validation introduces a new failure mode that does not exist today. A wake that produces all required artifacts can now be marked invalid because of a tool sequence violation. This is the _intent_ — but it changes what "invalid" means and requires operator education.
- The `done_when` YAML grammar (especially disjunction via `"OR"`-prefixed lines) is a small DSL. Edge cases (nested disjunction, mixed AND/OR) are explicitly out of scope for this ADR — disjunction is single-level OR only. Anything more is a follow-up ADR.

**Reversibility:** Medium. The interface scaffolding can be removed cleanly (Phase 0 was types-only with no consumers), but once roles declare `contract:` blocks operators will have written real YAML against this schema. Schema-breaking changes after the first roles ship require a migration step.

## Alternatives considered

### A. Single flat contract (no obligation/permission split)

Keep `ExecutionContract` flat with all five elements at the top level; let callers decide how to enforce. Rejected: the per-field enforcement point (pre-action vs post-wake) is the primary distinction. Without naming the split, every consumer reinvents it inconsistently — and the diagnostic surface ("which part failed?") cannot be answered.

### B. Outcome validation only (skip behavioral validation)

Land Phase 4 with `validateOutcomes` only; defer `validateBehavior` to a follow-up phase. Rejected: arXiv 2512.12791 quantifies the cost — 67 points of policy adherence go un-flagged. The behavioral surface is the entire reason `ToolCallReceipts` are being collected; gathering them without checking them is the worst of both worlds (storage cost, no policy benefit).

### C. LLM-based validator (verifier agent)

Replace `WakeValidator` with an LLM call that judges whether the wake satisfied its contract. Rejected: the subtraction principle (Proposal 07 §"Subtraction") is convergently validated by Stanford/Tsinghua benchmarks (−0.8 to −8.4), Minerva production data, and OpenClaw (250k+ stars, no internal verifier agents). `WakeValidator` is a deterministic contract check, not an LLM verifier — that distinction is load-bearing.

### D. Validation results in a separate file (not `RunArtifactIndexEntry`)

Write `validation.jsonl` alongside `index.jsonl` instead of embedding `validationStatus` in `RunArtifactIndexEntry`. Rejected: the index entry is the single record that downstream tools (dashboard, retrospective, Strategy plugin) consume per wake. Splitting would require every consumer to join two files. The 7-field `validationStatus` object is small enough to embed.

### E. Defer the `role.md` operator surface to a separate ADR

Land just the `ExecutionContract` types and `WakeValidator` semantics here; let a follow-up ADR define the YAML grammar. Rejected: the YAML _is_ the operator-facing API. Without it, the contract has no way for operators to opt in, and the ADR cannot be tested against a real role. Including the YAML keeps the ADR end-to-end shippable.

## References

- Proposal 07 §5 "Execution Contract" (`docs/proposals/07-harness-engineering-target-architecture.md`)
- arXiv 2512.12791 "Beyond Task Completion" — quantifies the outcome/behavioral validation gap
- Tsinghua NLAH execution-contract framework — the five-element decomposition
- `docs/research/beyond-task-completion-applied.md` — full mapping of the paper's findings to harness components
- `docs/research/agentic-security-threats-applied.md` §3 — composite-permission threat model
- `docs/research/hermes-applied.md` §3 — RunLedger as self-improvement substrate
- `docs/research/langgraph-applied.md` §2, §5 — INTERRUPT/RESUME pattern (Phase 7 dependency on Phase 4 receipts)
- ADR-0045 "Prompt Boundary" — trust classification used for contract injection
- `packages/core/src/runtime/execution-contract.ts` — Phase 0 types
- `packages/core/src/tools/receipts.ts` — Phase 0 types
- `packages/core/src/tools/registry.ts` — Phase 0 types
