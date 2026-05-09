# Proposal 07 Phase 4 — Implementation Plan

**Status:** Awaiting consent on ADR-0047 (filed as EP #845, 2026-05-08).
Implementation begins on engineering-agent's consent or with-amendment ratification.

**Scope:** Wire the Phase 0 type scaffolding (`ExecutionContract`, `ToolCallReceipt`, `WakeValidator`) into the runtime. Replace the shallow artifact-counting heuristic with contract-backed dual validation.

**Non-goals:** Sequencing rule DSL beyond the surface (defer to follow-up ADR per ADR-0047 §3B); nested AND/OR in `done_when` (defer per §6); container isolation (Phase 7 per Proposal 07 §7).

**Design principle: v1 is brutally simple.** External review (OpenClaw agent, 2026-05-08) flagged that the contract DSL and behavioral validation are the two places where Phase 4 risk concentrates. Every fork in this plan that could grow features now should defer instead. Concretely:

- The `contract:` YAML grammar in PR 1 is the smallest set of fields that supports the Phase 4 use case. No nesting, no expressions, no operators beyond single-level `OR`. If an operator demands more, file a follow-up ADR — do not extend this PR.
- The composite-permission check in PR 6 ships with **exactly one rule** (`read` + `network`) and it emits a **warning, not a hard failure**, for the first 14 days after merge. Promotion to hard failure requires an explicit follow-up commit and a documented incident or near-miss.
- The sequencing surface in PR 6 is plumbing only. No rule evaluator. No DSL. The first sequencing rule waits for a real bug.

When in doubt, the right answer is "less."

---

## Synopsis — what Phase 4 is about

### One breath

Phase 4 is when the harness stops asking "did the agent produce _something_?" and starts asking "did the agent produce _the right thing_, _the right way_?"

### The problem it solves

Today the harness has one validity check: did the wake produce any artifacts? If yes, mark productive; if no, mark idle. That's it. Two failure modes slip through:

1. **Agent did the wrong work** — produced artifacts, but not the ones it was supposed to produce. Burns budget, looks productive on the dashboard.
2. **Agent did the right work the wrong way** — completed its task while violating policy. The "Beyond Task Completion" research (arXiv 2512.12791) measured this on production agents at **100% completion / 33% policy adherence**. Two-thirds of misbehavior is invisible.

### What changes

Operators declare a contract per agent in `role.md`:

```yaml
contract:
  done_when:
    - "At least one knowledge file committed"
  committed_artifacts:
    - "agents/<id>/knowledge/*.md"
  approval_required_for:
    - "admin"
```

That contract is used twice:

1. **At spawn:** injected into the agent's system prompt as a trusted segment so the model knows what it must produce and what it's allowed to do.
2. **After the wake:** the validator checks both surfaces:
   - **Outcome** — did the declared artifacts exist? Did the action items get touched?
   - **Behavior** — did the _sequence_ of tool calls violate composite permissions? (e.g., `read` + `network` together = exfiltration risk, even if each is individually allowed.)

### What gets built

The type scaffolding already exists from Phase 0–1 (`ExecutionContract`, `ToolCallReceipt`, `WakeValidator` interfaces). Phase 4 wires it up: read the YAML, assemble the contract, render it into the prompt, record every tool call as a receipt with hashed input/output, validate both surfaces post-wake, surface results in the run index for the dashboard.

### What it unlocks

- Failed wakes name _which sub-contract_ they violated (obligation vs. permission), instead of vague "idle"
- The 67-point compliance gap becomes detectable
- Tool-call receipts become the substrate for Phase 6 self-improvement (a GEPA-equivalent loop reads them) and Phase 7 INTERRUPT/RESUME approval gates
- Operators get an opt-in path to stricter validation without any existing role breaking

### What it doesn't do

It's not container isolation (Phase 7), not health metrics or self-reflection (Phase 5), not memory curation (Phase 6). It's the contract layer — the thing that makes everything downstream measurable.

---

## Milestones at a glance

Six PRs. Each lands behind no flag — the ADR's backward-compat guarantee (synthesized minimal default for roles without a `contract:` block) provides the safety net. Each PR is independently shippable; later PRs assume earlier PRs are merged.

| #   | PR title                                                                                 | Surface affected                                                                                                                  | Blocker for next? |
| --- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| 1   | feat(identity): role.md `contract:` frontmatter — Zod schema + parser                    | `packages/core/src/identity/index.ts`, `packages/core/src/types/role-frontmatter.ts`                                              | Yes (gates 2)     |
| 2   | feat(daemon): assemble `ExecutionContract` in `buildSpawnContext`                        | `packages/core/src/daemon/index.ts`, `packages/core/src/runtime/execution-contract.ts`                                            | Yes (gates 3, 4)  |
| 3   | feat(prompt): inject contract as trusted segment via `PromptAssembler`                   | `packages/core/src/runtime/prompt-assembler.ts`                                                                                   | No                |
| 4   | feat(validation): `validateOutcomes` + wire into post-wake hook                          | `packages/core/src/execution/index.ts` (extend `validateWake`), `packages/core/src/runtime/wake-validator.ts` (new)               | No                |
| 5   | feat(tools): `ToolInvocationRecorder` — collect `ToolCallReceipts`                       | `packages/core/src/tools/recorder.ts` (new), executor wiring in `packages/core/src/execution/{in-process,subprocess,dispatch}.ts` | Yes (gates 6)     |
| 6   | feat(validation): `validateBehavior` + populate `RunArtifactIndexEntry.validationStatus` | `packages/core/src/runtime/wake-validator.ts`, `packages/core/src/daemon/runs.ts`                                                 | Closes Phase 4    |

PRs 3, 4, 5 can land in parallel after PR 2. PR 6 is the closer.

---

## PR 1 — `role.md` `contract:` frontmatter schema

**Goal:** Operators can declare `contract:` in `role.md`. Schema validation runs at boot. Roles without `contract:` continue to work unchanged.

**Files:**

- `packages/core/src/types/role-frontmatter.ts` (or wherever `AgentRoleFrontmatter` Zod schema lives — find via `grep -rn "AgentRoleFrontmatter"`)
- `packages/core/src/identity/index.ts` — `enrichRoleFrontmatter` passes the parsed `contract` block through to the runtime

**New schema (Zod):**

```ts
export const ContractDeclarationSchema = z
  .object({
    done_when: z.array(z.string()).default([]),
    committed_artifacts: z.array(z.string()).default([]),
    runtime_artifacts: z.array(z.string()).default([]),
    verification_required_for: z.array(z.string()).default([]),
    approval_required_for: z.array(z.string()).default([]),
  })
  .strict();

export const AgentRoleFrontmatterSchema = z.object({
  // ... existing fields
  contract: ContractDeclarationSchema.optional(),
});
```

**Tests** (add to `packages/core/src/identity/identity.test.ts`):

1. role.md without `contract:` parses and produces `frontmatter.contract === undefined`
2. role.md with full `contract:` block parses; all five arrays present
3. role.md with `contract: {}` parses; all arrays default to `[]`
4. Unknown key under `contract:` rejected (`.strict()`)
5. Non-string entry in any array rejected

**Risk:** Zero — additive optional field.

---

## PR 2 — Assemble `ExecutionContract` in `buildSpawnContext`

**Goal:** Daemon produces a fully-populated `ExecutionContract` per wake. `AgentSpawnContext.contract` (already declared by Phase 1) is no longer empty.

**File:** `packages/core/src/daemon/index.ts:1309` (`buildSpawnContext`).

**New helper:** `packages/core/src/runtime/execution-contract.ts` — add `assembleExecutionContract(input) → ExecutionContract` next to the existing types. Pure function, no I/O.

```ts
export interface AssembleContractInput {
  readonly wakeReason: WakeReason;
  readonly wakeMode: WakeMode;
  readonly objective: string;
  readonly contractDeclaration: ContractDeclaration | undefined; // from role.md
  readonly actionItems: readonly Signal[]; // from SignalBundle.actionItems
  readonly allowedSideEffects: readonly ToolPermission[]; // derived from github_scopes + tool grants
  readonly budget: CostBudget;
}

export const assembleExecutionContract = (input: AssembleContractInput): ExecutionContract => {
  // When contractDeclaration is undefined, synthesize the minimal default
  // per ADR-0047 §4 (requiredOutputs: [{kind:"summary",description:"wake summary"}],
  // empty completionConditions, empty verification, approval.mode:"none").
};
```

**Mapping rules** (per ADR-0047 §4):

| `role.md` field               | `ExecutionContract` field                                                              |
| ----------------------------- | -------------------------------------------------------------------------------------- |
| `done_when[]`                 | `completionConditions[]` — id = SHA-256(description).slice(0,12), description verbatim |
| `committed_artifacts[]`       | `requiredOutputs[]` with `kind: "committed-artifact"` and `path` = the glob            |
| `runtime_artifacts[]`         | `requiredOutputs[]` with `kind: "runtime-artifact"` and `path` = the glob              |
| `verification_required_for[]` | `verification[]` with `required: true`, `id` = the tool id                             |
| `approval_required_for[]`     | `approval.mode: "conditional"`, `approval.requiredFor: <permissions>`                  |
| `signals.actionItems[]`       | `actionItems[]` (signalId from `signal.id`, sourceRef from `signal.sourceRef`)         |

**Disjunction:** an entry starting with `"OR "` continues the prior entry as a single `kind: "any"` condition node. Single-level only (per ADR §6); nested OR is rejected with a parse error pointing at the offending line.

**Tests** (new file `packages/core/src/runtime/execution-contract.test.ts`):

1. `assembleExecutionContract` with `undefined` contract produces minimal default (the §4 fallback)
2. Each `done_when` entry → one `completionConditions` entry with stable id
3. Disjunction: `["A", "OR B", "OR C"]` → single `{ kind: "any", clauses: [A, B, C] }` node
4. Nested OR rejected
5. `verification_required_for` populates `verification[]` with `required: true`
6. `approval_required_for` populates `approval.mode: "conditional"` correctly
7. `actionItems` from signals are passed through with stable refs
8. Contract is deterministic (same input → byte-identical JSON serialization → identical SHA-256)

**Wiring in `buildSpawnContext`:**

```ts
const contract = assembleExecutionContract({
  wakeReason: event.wakeReason,
  wakeMode: "individual",
  objective: agent.identity.frontmatter.role_summary ?? "respond to signals",
  contractDeclaration: agent.identity.frontmatter.contract,
  actionItems: signals.actionItems,
  allowedSideEffects: derivePermissions(agent),
  budget,
});
return { ...existingFields, contract };
```

**Risk:** Low. The contract field is populated but nothing yet consumes it (PRs 3, 4, 6 do). Existing `AgentSpawnContext` consumers ignore it.

---

## PR 3 — Inject contract as trusted segment via `PromptAssembler`

**Goal:** Agents see their contract in their system prompt as a `trusted` segment.

**File:** `packages/core/src/runtime/prompt-assembler.ts`. Add a `contractSegment` between the existing `skillsSegment` and `memoryInstructionSegment` (so it lives in the cache-stable system block per ADR-0045).

**Contract renderer** (pure helper):

```ts
export const renderContractAsPromptText = (contract: ExecutionContract): string => {
  // Returns markdown that says:
  //   ## Wake Contract
  //   **Objective:** <objective>
  //   **Required outputs:** <bulleted list of requiredOutputs[].description>
  //   **Completion conditions:** <bulleted list, OR-grouped>
  //   **Action items:** <bulleted list of signalId + sourceRef>
  //   **Allowed side-effects:** read | write | execute | network | admin
  //   **Approval required for:** <permissions, or "none">
};
```

**Trust level:** `trusted` (the contract originates from `role.md`, which is trusted operator content).

**Tests** (extend `prompt-assembler.test.ts`):

1. Contract segment present when `spawn.contract.requiredOutputs.length > 0`
2. Minimal-default contract (just summary) produces a short segment, not omitted entirely (so the agent always sees its objective)
3. Disjunctive completion conditions render as `"A OR B OR C"` not as separate bullets
4. `approval_required_for: []` renders as `"Approval required for: none"`
5. Cache-stability: two contracts with the same hash produce byte-identical segment content

**Risk:** Low-medium. Adds tokens to every wake's system prompt. Token impact: ~150–400 tokens per wake depending on contract size. Confirm cache reuse via the existing `prompt_hash` check — the contract-stable-across-wakes case should not invalidate the cache.

---

## PR 4 — `validateOutcomes` + wire into post-wake hook

**Goal:** After every wake, check whether the agent met its declared obligations. Replace `validateWake`'s shallow artifact count when a contract is present.

**New file:** `packages/core/src/runtime/wake-validator.ts`.

```ts
export interface OutcomeValidationResult {
  readonly ok: boolean;
  readonly checks: readonly {
    readonly kind: "required-output" | "completion-condition" | "verification" | "action-item";
    readonly id: string;
    readonly passed: boolean;
    readonly reason?: string;
  }[];
  readonly summary: string; // e.g. "3/4 obligations met; failed: completion-condition:committed-knowledge-file"
}

export const validateOutcomes = (
  contract: ExecutionContract,
  evidence: {
    readonly actions: readonly WakeActionReceipt[];
    readonly artifacts: readonly { kind: string; path: string }[]; // produced this wake
    readonly verificationResults: readonly { id: string; passed: boolean }[];
    readonly mutatedIssues: readonly number[]; // issue numbers touched this wake
  },
): OutcomeValidationResult => {
  // For each requiredOutputs[]: glob-match against artifacts[]
  // For each completionConditions[]: deterministic predicate evaluator
  //   - single condition: literal substring match against artifacts/actions
  //   - disjunction (kind:"any"): any clause passes
  // For each verification[].required: confirm passed:true in verificationResults
  // For each actionItems[]: confirm signalId resolves to an issue in mutatedIssues
};
```

**Completion condition evaluators (v1):** existence checks only. The `description` is the operator's prose, but the harness pattern-matches against artifact paths and action verbs. Pluggable evaluators (e.g., a JS expression DSL) are explicitly deferred.

**Wire-up:** in `packages/core/src/daemon/index.ts:875` where `validateWake` is called today, also call `validateOutcomes` when `spawnContext.contract.completionConditions.length > 0` or `spawnContext.contract.requiredOutputs.length > 0`. The combined result feeds `WakeValidationResult`.

**`WakeValidationResult` extension:**

```ts
export interface WakeValidationResult {
  // ... existing fields
  readonly outcome?: OutcomeValidationResult; // present when contract is non-default
}
```

**Tests** (`wake-validator.test.ts`):

1. Empty contract (minimal default) → `validateOutcomes` returns `{ ok: true, summary: "no obligations declared" }`
2. requiredOutputs glob match: `committed_artifacts: ["agents/x/knowledge/*.md"]` + an artifact at `agents/x/knowledge/foo.md` → pass
3. requiredOutputs miss: same glob, no matching artifact → fail with named reason
4. Disjunction: `done_when: ["committed file", "OR labelled issue"]` + only labelled an issue → pass
5. Action item not addressed: contract has actionItem for issue #100 but `mutatedIssues = [200]` → fail
6. Verification step required but missing → fail
7. Combined outcome: 2 pass + 1 fail → `ok: false`, summary names the failure

**Risk:** Medium. Changes the meaning of "valid wake" for any role that opts into a contract. Operator must be told via dashboard surface (PR 6).

---

## PR 5 — `ToolInvocationRecorder` — collect `ToolCallReceipts`

**Goal:** Every tool call produces a `ToolCallReceipt`. Receipts persist in `RunLedgerEntry.toolReceipts`.

**New file:** `packages/core/src/tools/recorder.ts`.

```ts
export class ToolInvocationRecorder {
  readonly #wakeId: WakeId;
  readonly #callerAgentId: AgentId;
  readonly #policyVersion: string;
  readonly #receipts: ToolCallReceipt[] = [];

  constructor(input: { wakeId: WakeId; agentId: AgentId; policyVersion: string }) { ... }

  /**
   * Record one tool call. Hashes input/output (with secret redaction).
   * Returns the receipt so callers can persist or replay.
   */
  record(input: {
    descriptor: ToolDescriptor;
    rawInput: unknown;
    rawOutput: unknown | undefined;
    outcome: ToolCallReceipt["outcome"];
    policyDecision: ToolCallReceipt["policyDecision"];
    secretGrantNames: readonly string[];
    startedAt: Date;
    durationMs: number;
    errorCode?: string;
    artifactRefs?: readonly string[];
  }): ToolCallReceipt;

  /** Return the immutable receipt list at end-of-wake. */
  drain(): readonly ToolCallReceipt[];
}
```

**Hash policy:** SHA-256 of canonicalized JSON of input/output. Before hashing, walk the object and replace any string matching the secret-redaction patterns (already implemented in `packages/core/src/secrets/index.ts` — `scrubLogRecord`) with `[redacted]`. Never store raw input/output.

**Wiring:**

- `packages/core/src/execution/in-process.ts` — recorder instantiated per spawn; passed to the tool execution layer (extension loader, MCP loader).
- `packages/core/src/execution/subprocess.ts` — receipts collected from the subprocess via the existing stdio protocol (extend `::tool-receipt::` envelope, or surface via the run ledger directly).
- `packages/core/src/execution/dispatch.ts` — passes recorder through to whichever underlying executor.

**RunLedgerEntry wiring:** the recorder's `drain()` output is written to `RunLedgerEntry.toolReceipts` at wake completion (already declared in `runtime/run-ledger.ts:71`).

**Tests** (`recorder.test.ts`):

1. `record` produces a receipt with `inputHash` ≠ raw input
2. Secret redaction: input containing a value matching `AKIA[A-Z0-9]+` → hash differs from raw, redacted version hashed instead
3. `outputHash` undefined when `outcome === "denied"`
4. `secretGrantNames` recorded; values never recorded
5. `drain()` returns receipts in `startedAt` order
6. `drain()` is idempotent (second call returns the same list, no mutation)
7. Receipt JSON serialization is stable (canonical key ordering)

**Risk:** Medium-high. This is the most invasive PR — it touches all three executor variants and the tool dispatch layer. Mitigation: receipts are collected but not yet validated (PR 6 closes that loop). If recorder breaks, it can be feature-flagged off without affecting wake correctness.

**Subprocess complication:** subprocess agents call tools through their own MCP layer. The receipts must either be:

- (a) collected in-subprocess and surfaced via stdio (`::tool-receipt::<json>::`) — preferred, mirrors existing `::wake-summary::` pattern, or
- (b) inferred post-hoc from MCP server logs — fragile, defer.

Pick (a). Add a small helper in `@murmurations-ai/mcp` that the subprocess can use to emit receipts.

---

## PR 6 — `validateBehavior` + populate `RunArtifactIndexEntry.validationStatus`

**Goal:** Both validation surfaces produce results; both surface in the run artifact index for dashboards and retrospectives.

**File:** `packages/core/src/runtime/wake-validator.ts` (extend).

```ts
export interface BehaviorValidationResult {
  readonly ok: boolean;
  readonly checks: readonly {
    readonly kind: "composite-permission" | "denied-call-pattern" | "sequencing";
    readonly passed: boolean;
    readonly reason?: string;
  }[];
  readonly summary: string;
}

export const validateBehavior = (
  contract: ExecutionContract,
  receipts: readonly ToolCallReceipt[],
): BehaviorValidationResult => {
  // Composite permission check (v1 — WARNING-only for first 14 days):
  //   - Compute the union of permissions actually exercised across all
  //     successful receipts (outcome === "success").
  //   - One rule only: read + network without a contract-declared
  //     side-effect spanning both. Other dangerous combinations require
  //     a follow-up commit + documented incident before they ship.
  //   - During the soak period, flag with `passed: true` and a
  //     `reason: "warning: composite-permission read+network observed"`
  //     so dashboards surface it but the wake does not fail.
  // Sequencing surface (v1): infrastructure only — no rules evaluated.
  //   The receipt sequence is passed through to the result so future
  //   sequencing rules can add checks without re-plumbing. No DSL.
  // Denied-call pattern (v1):
  //   - >5 denied calls in a single wake → flag as policy probing
  //     (warning, not failure, for first 14 days).
};
```

**Soak period (per "v1 is brutally simple" principle):** After PR 6 merges, the composite-permission check runs in WARNING mode for **14 days** before being promoted to a hard failure. Promotion requires:

1. Zero false positives observed during the soak period across all opted-in agents, OR
2. An explicit retrospective commit naming each false-positive case and ratifying the rule anyway with documented operator awareness.

If false positives appear, the rule does not promote — it goes back to the design board.

**`RunArtifactIndexEntry.validationStatus` extension** (`packages/core/src/daemon/runs.ts:171`):

```ts
readonly validationStatus?:
  | "productive"        // legacy default
  | "idle"              // legacy: no artifacts
  | "unaddressed-directives"  // legacy
  | "obligation-failed"       // contract: requiredOutputs/completionConditions failed
  | "behavior-failed"         // contract: behavioral check failed (composite permission etc.)
  | "obligation-and-behavior-failed"  // both
  | "unknown";
readonly validationDetail?: {
  readonly outcome?: OutcomeValidationResult;
  readonly behavior?: BehaviorValidationResult;
};
```

**Dashboard surface:** the dashboard-tui already reads `validationStatus`. Add display for the new statuses (one-line summary per row, color-code by severity).

**Tests** (extend `wake-validator.test.ts`):

1. Receipts with read + network exercised, contract allows both individually but not the composite → `behavior.ok === false`
2. Receipts with only allowed individual permissions and no composite rule fires → `behavior.ok === true`
3. > 5 denied receipts → flagged as policy probing
4. Empty receipts (recorder didn't run, e.g. no tools used) → `ok: true`
5. Combined `validationStatus`: outcome ✓ + behavior ✗ → `"behavior-failed"`
6. Combined `validationStatus`: outcome ✗ + behavior ✓ → `"obligation-failed"`
7. Combined `validationStatus`: both ✗ → `"obligation-and-behavior-failed"`

**Risk:** Low after PR 5 lands. The composite-permission rule is conservative in v1 (just `read + network`). Operators can extend via a follow-up ADR.

---

## Cross-cutting concerns

### Test fixtures

Add a `examples/contract-fixtures/` directory with:

- `minimal-role.md` — no `contract:` block (regression test for the synthesized default)
- `full-role.md` — every contract field populated
- `disjunctive-role.md` — `done_when` with single-level OR
- `nested-or-role.md` — `done_when` with nested OR (must reject)

These fixtures back the integration tests in PR 2 and PR 4.

### Logging

Every PR adds structured log events:

- PR 2: `daemon.contract.assembled` `{ wakeId, agentId, contractHash }`
- PR 4: `daemon.contract.outcome` `{ wakeId, ok, summary }`
- PR 5: `daemon.tool.receipt` `{ wakeId, toolId, outcome, durationMs }` (debug-level only — receipts can be high-volume)
- PR 6: `daemon.contract.behavior` `{ wakeId, ok, summary }`

### Migration story for EP

Once PRs 1–6 land:

1. EP roles update `role.md` opt-in. Engineering-agent goes first as the dogfood case.
2. Each role's first wake under contract gets manual review of the validation result before the next wake.
3. After two weeks of all-roles-on-contract data, file a retrospective tension (per Phase 3 cadence) on whether the contract DSL needs amendment.

### Inter-PR soak periods

Per the "v1 is brutally simple" principle, each PR has a minimum settle time before the next PR starts. This prevents stacking unverified surface area in a single weekend:

| PR transition         | Minimum soak | Validation gate before next PR                                                                                 |
| --------------------- | ------------ | -------------------------------------------------------------------------------------------------------------- |
| PR 1 → PR 2           | 24 h         | Engineering-agent role.md parses cleanly with a `contract:` block                                              |
| PR 2 → PR 3           | 24 h         | One real EP wake produces a populated `ExecutionContract` in logs (`daemon.contract.assembled` event)          |
| PR 3 → PR 4           | 48 h         | Engineering-agent prompt cache hit-rate unchanged after contract injection                                     |
| PR 4 → PR 5           | 48 h         | One real wake completes with both legacy validation AND new `validateOutcomes` agreeing on `valid: true/false` |
| PR 5 → PR 6           | 72 h         | Three real wakes' worth of `ToolCallReceipts` collected without crash, drift, or missing receipts              |
| PR 6 merge → soak end | 14 d         | Composite-permission rule promotion (see PR 6 §Soak period)                                                    |

Total wall-clock from PR 1 start to Phase 4 closure: **≥ 22 days**, not "tonight." This is a deliberate slowdown — the architectural surface is wide enough that batching all six PRs on a single review pass invites integration bugs that don't show up until production wakes hit them.

### Performance budget

- `assembleExecutionContract`: O(n) in role.md array sizes, called once per wake. Bounded.
- Contract prompt segment: ~150–400 tokens per wake. Cache-stable across wakes for the same role config.
- `ToolInvocationRecorder.record`: O(1) per tool call (hash + push). Bounded by `maxToolCalls` budget.
- `validateOutcomes` + `validateBehavior`: O(receipts + obligations). Both bounded by per-wake budgets.

Total per-wake overhead estimate: ≤5% wall-clock, ≤15% ledger size.

### Rollback

Each PR is independently revertable. The synthesized minimal default (PR 2) is the safety net — even if PRs 3–6 are reverted, PR 2's contract is consumed only by the new validators, so rollback restores legacy behavior.

---

## Acceptance criteria for Phase 4 closure

- [ ] All six PRs merged
- [ ] One EP role (engineering-agent) running with a non-default contract for ≥7 days
- [ ] Dashboard surfaces all new `validationStatus` values
- [ ] At least one bug caught by behavioral validation that outcome validation missed (or, if none caught, a documented retrospective on why the composite-permission rule is too narrow)
- [ ] Phase 4 marked complete in `EXECUTION-PLAN.md`
- [ ] Follow-up ADRs filed for any deferred decisions hit during implementation (sequencing rules DSL, nested OR grammar, additional composite permission rules)

---

## Open questions (to be answered by ADR-0047 consent)

These are the same questions in EP #845. The plan adapts based on ratified answers:

1. Disjunction grammar — single-level OR (current plan) vs nested
2. Sequencing-rules ADR timing — file alongside Phase 4 vs wait for first real bug
3. Receipt storage — embedded in ledger (current plan) vs separate jsonl with retention policy
4. Composite permission rules — `read + network` only (current plan) vs broader v1 set
5. Legacy code path horizon — Phase 4 retains it (current plan) vs deprecate at Phase 5
