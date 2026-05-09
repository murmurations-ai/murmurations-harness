# Proposal 07 — Phase 0 + Phase 1 Implementation Plan

**Proposal:** `docs/proposals/07-harness-engineering-target-architecture.md`
**Consent recorded:** EP #842 (2026-05-08) — engineering-agent + intelligence-agent both consented
**Authorized phases:** Phase 0 (types-first) + Phase 1 (signal quality + minimal contracts)
**Target version:** v0.7.2 (Phase 1 milestone per proposal)

---

## What Phase 0 and Phase 1 Do

**Phase 0 — Specification types, no behavior change.**
Introduces the six boundary types that define `AgentRuntime = Model + Prompt + Toolset + Environment + ExecutionContract + Ledger` as TypeScript interfaces. Nothing wired to the runtime yet — these compile in CI and give us a type-level contract to migrate toward incrementally.

**Phase 1 — Signal quality + minimal contracts (P0 correctness gaps).**

- G1 (signal comments): **already shipped** in harness#350 / signals v0.0.0-phase1b-d. No work needed.
- `actionItemVersions` on `SignalBundle` — prevents re-processing already-acted-on signals (P0 correctness).
- `actionItemGraph` optional field on `SignalBundle` — dependency-aware action item metadata.
- `promptPath`/`promptRef` optional fields on `AgentSpawnContext` (Near-Term #1).
- `contract` minimal scaffold on `AgentSpawnContext` (Near-Term #9).
- `validationStatus` + `artifactCount` on `RunArtifactIndexEntry` (Near-Term #4).
- `BlockedActionItem` type for dependency graph.

**Out of scope until Phase 2+:** prompt assembly migration from DefaultRunner, ToolRegistry wiring, EnvironmentSpec enforcement, full RunLedger persistence, WakeValidator contract-backed validation, memory tier, Langfuse threading.

---

## New Module Layout

```
packages/core/src/
  runtime/
    types.ts            ← ActionItemRef, CompletionCondition, VerificationStep, RunLedgerHandle
    prompt-assembler.ts ← PromptSegment, PromptBundle
    execution-contract.ts ← ExecutionContract
    run-ledger.ts       ← RunLedger, RunLedgerEntry, RunLedgerFilter
    agent-runtime.ts    ← AgentRuntime, Toolset
    index.ts            ← re-exports all runtime/*
    runtime.test.ts     ← fixture: map existing wake context to new boundaries
  tools/
    registry.ts         ← ToolPermission, ApprovalPolicy, ToolDescriptor, ToolGrant
    receipts.ts         ← ToolCallReceipt
    index.ts            ← re-exports all tools/*
  environment/
    environment-spec.ts ← EnvironmentSpec
    index.ts            ← re-exports
  validation/
    health.ts           ← WakeHealthMetrics, LangfuseMetricsSignal
    index.ts            ← re-exports
```

No tsconfig changes needed — `packages/core/tsconfig.json` uses `"include": ["src/**/*"]` which picks up all new subdirectories automatically.

---

## Import Dependency Graph (no cycles)

```
tools/registry.ts          ← (no harness imports)
tools/receipts.ts          ← execution/index (WakeId, AgentId) + tools/registry
environment/environment-spec.ts ← (no harness imports)
validation/health.ts       ← execution/index (AgentId)
runtime/types.ts           ← execution/index (WakeId, AgentId)
runtime/prompt-assembler.ts ← (no harness imports)
runtime/execution-contract.ts ← execution/index (WakeReason, WakeMode, CostBudget) + runtime/types + tools/registry
runtime/run-ledger.ts      ← execution/index (WakeId, AgentId, WakeActionReceipt, WakeValidationResult, ResolvedModel) + tools/receipts + cost/record + validation/health + runtime/types
runtime/agent-runtime.ts   ← execution/index (WakeId, AgentId, ResolvedModel) + runtime/prompt-assembler + runtime/execution-contract + runtime/run-ledger + environment/environment-spec
```

---

## File-by-File Specification

### 1. `packages/core/src/tools/registry.ts` (new)

Types: `ToolPermission`, `ApprovalPolicy`, `ToolDescriptor`, `ToolGrant`

```ts
export type ToolPermission = "read" | "write" | "execute" | "network" | "admin";

export interface ApprovalPolicy {
  readonly mode: "none" | "required" | "conditional";
  readonly reason?: string;
  readonly requiredFor?: readonly ToolPermission[];
}

export interface ToolDescriptor {
  readonly id: string;
  readonly name: string;
  readonly provider: "mcp" | "extension" | "cli" | "collaboration" | "internal";
  readonly description: string;
  readonly inputSchema: unknown;
  readonly permissions: readonly ToolPermission[];
  readonly mutability: "read-only" | "mutating";
  readonly trust: "trusted" | "semi-trusted" | "untrusted";
  readonly timeoutMs: number;
  readonly requiresVerification: boolean;
  readonly approval: ApprovalPolicy;
}

export interface ToolGrant {
  readonly toolId: string;
  readonly allowedAgentIds: readonly string[];
  readonly allowedSecretGrantNames: readonly string[];
  readonly maxCallsPerWake?: number;
}
```

### 2. `packages/core/src/tools/receipts.ts` (new)

Types: `ToolCallReceipt`

Imports `WakeId`, `AgentId` from `../execution/index.js`; `ToolPermission`, `ToolDescriptor` from `./registry.js`

### 3. `packages/core/src/tools/index.ts` (new)

Re-exports `registry.ts` and `receipts.ts`.

### 4. `packages/core/src/environment/environment-spec.ts` (new)

Types: `EnvironmentSpec`

### 5. `packages/core/src/environment/index.ts` (new)

Re-exports `environment-spec.ts`.

### 6. `packages/core/src/validation/health.ts` (new)

Types: `WakeHealthMetrics`, `LangfuseMetricsSignal`

Imports `AgentId` from `../execution/index.js`.

### 7. `packages/core/src/validation/index.ts` (new)

Re-exports `health.ts`.

### 8. `packages/core/src/runtime/types.ts` (new)

Types: `ActionItemRef`, `CompletionCondition`, `VerificationStep`, `RunLedgerHandle`

`RunLedgerHandle.append` is forward-declared with `RunLedgerEntry` via an import from `./run-ledger.js`. To avoid circular dep, `RunLedgerHandle` is declared with a type-only forward reference or moved into `run-ledger.ts`.

**Revised approach**: put `RunLedgerHandle` in `run-ledger.ts` to keep it next to `RunLedgerEntry`. Put `ActionItemRef`, `CompletionCondition`, `VerificationStep` in `execution-contract.ts` since they're `ExecutionContract` sub-types.

### 9. `packages/core/src/runtime/prompt-assembler.ts` (new)

Types: `PromptSegment`, `PromptBundle`

No harness imports — `PromptSegment.kind` and trust levels are standalone strings.

### 10. `packages/core/src/runtime/execution-contract.ts` (new)

Types: `ActionItemRef`, `CompletionCondition`, `VerificationStep`, `ExecutionContract`

Imports: `WakeReason`, `WakeMode`, `CostBudget` from `../execution/index.js`; `ToolPermission`, `ApprovalPolicy` from `../tools/registry.js`

### 11. `packages/core/src/runtime/run-ledger.ts` (new)

Types: `RunLedgerHandle`, `RunLedgerEntry`, `RunLedgerFilter`, `RunLedger`

Imports: `WakeId`, `AgentId`, `WakeActionReceipt`, `WakeValidationResult`, `ResolvedModel` from `../execution/index.js`; `ToolCallReceipt` from `../tools/receipts.js`; `WakeCostRecord` from `../cost/record.js`; `WakeHealthMetrics` from `../validation/health.js`

### 12. `packages/core/src/runtime/agent-runtime.ts` (new)

Types: `Toolset`, `AgentRuntime`

Imports: `WakeId`, `AgentId`, `ResolvedModel` from `../execution/index.js`; `PromptBundle` from `./prompt-assembler.js`; `Toolset` (defined here); `EnvironmentSpec` from `../environment/environment-spec.js`; `ExecutionContract` from `./execution-contract.js`; `RunLedgerHandle` from `./run-ledger.js`

### 13. `packages/core/src/runtime/index.ts` (new)

Re-exports all runtime/\* files.

### 14. `packages/core/src/runtime/runtime.test.ts` (new)

Fixture tests verifying:

- `PromptSegment` shapes compile correctly
- `ExecutionContract` minimal scaffold is constructable
- `WakeHealthMetrics` zero-baseline value compiles
- `RunLedgerEntry` schema version field defaults correctly
- A mock `AgentSpawnContext` maps cleanly to Phase 0 boundary types (no runtime behavior)

---

## Modified Files

### 15. `packages/core/src/index.ts`

Add exports:

```ts
export * from "./runtime/index.js";
export * from "./tools/index.js";
export * from "./environment/index.js";
export * from "./validation/index.js";
```

Check for name conflicts with existing exports before adding (e.g., `WakeHealthMetrics` must not duplicate an existing export).

### 16. `packages/core/src/execution/index.ts` — Phase 1 additions

**Add `BlockedActionItem` interface** (before `SignalBundle`):

```ts
export interface BlockedActionItem {
  readonly signal: Signal;
  readonly blockedBy: readonly string[];
}
```

**Add fields to `SignalBundle`**:

```ts
// Existing fields remain unchanged. Add:
readonly actionItemGraph?: {
  readonly actionable: readonly Signal[];
  readonly blocked: readonly BlockedActionItem[];
};
readonly actionItemVersions?: Readonly<Record<string, string>>;
```

**Add fields to `AgentSpawnContext`**:

```ts
// Add after `environment`:
readonly promptPath?: string;    // Near-Term #1
readonly promptRef?: string;     // Near-Term #1
readonly contract?: {            // Near-Term #9 — minimal scaffold
  readonly objective: string;
  readonly doneWhen: readonly string[];
  readonly allowedSideEffects: readonly string[];
};
```

### 17. `packages/core/src/daemon/runs.ts` — Phase 1 additions

**Add fields to `RunArtifactIndexEntry`** (Near-Term #4):

```ts
// Add after `digestPath`:
readonly productive?: boolean;
readonly artifactCount?: number;
readonly validationStatus?: "productive" | "idle" | "unaddressed-directives" | "unknown";
readonly directivesUnaddressed?: number;
```

These are optional (`?`) to maintain backward compatibility with existing index.jsonl readers.

---

## Test Strategy

**Phase 0 — compile-only tests** (`runtime.test.ts`):

- Construct minimal instances of each new type and assert types compile.
- Map a stubbed `AgentSpawnContext` to `AgentRuntime` shape using type assertions.
- Verify `PromptBundle.cacheAnchorIndex` is present.
- Verify `ExecutionContract.budget` accepts a `CostBudget` from execution/index.

**Phase 1 — behavioral tests** (extend existing test files):

- `signals.test.ts` (in packages/signals): assert `actionItemVersions` is passthrough-able on `SignalBundle`.
- `runs.test.ts` (in packages/core): assert `RunArtifactIndexEntry` with new optional fields round-trips to/from JSON.
- `execution.test.ts`: assert `BlockedActionItem` constructs correctly.

---

## CI Verification

After implementation, run:

```sh
pnpm run build && pnpm run typecheck && pnpm run lint && pnpm run format:check && pnpm run test
```

Expected: all pass. New types add zero runtime behavior so no existing tests break.

---

## Phase 2+ Reminder (not in scope)

- Phase 2: Move prompt assembly from DefaultRunner → PromptAssembler (requires ADR-0045)
- Phase 3: ToolRegistry wiring, ToolInvocationRecorder, MCP env migration
- Phase 4: Contract-backed completion validation (requires ADR-0047)
- Phase 5: WakeHealthMetrics derivation + Langfuse threading
- Phase 6: Two-tier memory, curate_memory built-in
- Phase 7: Durable RunLedger, ContainerExecutor, INTERRUPT/RESUME
