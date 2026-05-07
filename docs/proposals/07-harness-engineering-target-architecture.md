# Proposal 07: Harness Engineering Target Architecture

**Status:** Pending consent — Engineering circle
**Date:** 2026-05-06
**Related research:** `docs/research/agentic-engineering-resource-list-2026.md`, `docs/research/harness-engineering-video-applied.md`, `docs/research/harness-engineering-transcript.md`, `docs/research/how-to-build-effective-agents-transcript.md`, `docs/research/minerva-lessons-applied.md`, `docs/research/spike-langfuse-self-reflection.md`, `docs/research/openclaw-applied.md`, `docs/research/hermes-applied.md`
**Related proposals/ADRs:** Proposal 01 sandboxing, Proposal 03 observability, Proposal 04 durable execution, Proposal 06 MCP integration, ADR-0013 signal aggregation, ADR-0021 collaboration provider, ADR-0022 Langfuse self-reflection, ADR-0029 persistent memory

## Proposal Metadata (S3)

**Driver (situation → effect):** Prompt construction, tool availability, environment access, and completion expectations are spread across the runner, daemon, role frontmatter, MCP loader, collaboration provider, and run artifact code. This makes agent behavior hard to reason about, hard to evaluate for safety, and hard to improve transferably across model upgrades.

**Scope — included:**

- Direction-level architectural commitment to `AgentRuntime = Model + Prompt + Toolset + Environment + ExecutionContract + Ledger`
- Phase 0 (types-first, no behavior change) and Phase 1 (signal quality + minimal contracts) authorized to begin upon consent, targeting v0.7.2
- Architectural principles (subtraction, context-as-RAM, harness-as-IP, governance-agnostic self-improvement) as durable guardrails encoded into `CLAUDE.md` and `ARCHITECTURE.md`
- Phase ordering and gating in the Migration Plan

**Scope — not included:**

- Phases 2–7 are directional only; each requires a separate consent round before implementation
- ADR-003X "Prompt Boundary" and ADR-003Y "Execution Contracts" are required as separate consent rounds before Phases 2 and 4 respectively
- Cross-language harness ports, multi-tenant deployment, vector or embedding-based memory, `GovernancePlugin` interface changes beyond what Phases 5–6 require

**Review date:** After Phase 1 ships, or by 2026-07-01 — whichever comes first.

**Reversibility:**

- Phase 0 (types only) and Phase 1 (additive signal fields, minimal contract scaffold) are low-risk and reversible: each lands behind feature flags and the legacy code path remains intact through Phase 4.
- Phases 2–7 carry progressively higher reversibility cost as boundaries solidify; each phase's re-consent round must include its own rollback plan.

**Affected roles:**

- Engineering circle — primary consent body
- Maintainers of: `runner` (DefaultRunner / executor surface), `mcp` (tool loader + env handling), `signals` (aggregator + signal bundle), `llm` (Vercel adapter + telemetry), security review for tool/environment boundaries
- Operator-facing schema reviewers — `role.md` frontmatter additions in Phases 1, 4, and 6

## Executive Summary

The research converges on one practical definition:

> A harness is the durable system around the model: prompt, tools, environment, memory, orchestration, permissions, verification, and telemetry.

The current Murmurations Harness already has useful structural seams: `AgentExecutor`, `DispatchExecutor`, `SignalAggregator`, `CollaborationProvider`, MCP loading, cost records, agent state, run artifacts, governance plugins, and optional Langfuse tracing. These are strong foundations.

The main architectural gap is that the harness does not yet make the atomic runtime boundaries explicit. Prompt construction, tool availability, environment access, completion expectations, and validation are spread across runner, daemon, role frontmatter, MCP loader, collaboration provider, and run artifact code. That makes agent behavior harder to reason about, harder to evaluate, and harder to improve safely.

This proposal recommends promoting the core wake unit to:

```ts
AgentRuntime = Model + Prompt + Toolset + Environment + ExecutionContract + Ledger;
```

The migration should be incremental. First fix signal completeness and define the typed boundaries. Then move prompt assembly behind a `PromptAssembler`, normalize tool policy through a `ToolRegistry`, add a minimal execution contract early, make environment access least-privilege, enrich validation and health metrics, and finally add durable execution and stronger sandboxing.

## Consent Framing

This proposal is filed for consent as **direction and phased architecture**, not as a final implementation spec for every interface. Consent here means agreement that:

1. The atomic runtime boundary `AgentRuntime = Model + Prompt + Toolset + Environment + ExecutionContract + Ledger` is the right framing.
2. The phase ordering and gating in the Migration Plan is the right sequence.
3. The architectural principles (subtraction, context-as-RAM, harness-as-IP, governance-agnostic self-improvement) are durable guardrails.
4. Phase 0 (types-first, no behavior change) and Phase 1 (signal quality + minimal contracts) for v0.7.2 are authorized work upon consent.

**Still required as separate consent rounds before implementation:**

- **ADR-003X "Prompt Boundary"** — trust levels, segment policy, sanitizer contract (gates Phase 2).
- **ADR-003Y "Execution Contracts"** — the five elements and enforcement semantics (gates Phase 4).
- **Phase-by-phase re-consent** for Phases 2–7 as their detailed scope becomes concrete.

This is an architectural commitment, not a delivery commitment for every named interface.

## Research Synthesis

### Keep the agent loop simple

The strongest research signal is not to add elaborate orchestration early. The most robust baseline remains:

```text
while not done:
  model observes context
  model chooses tool or response
  harness executes tool
  harness records result
  harness evaluates completion
```

Agents are appropriate when the path is not known in advance. When the path is known, deterministic workflow code should own the flow and use the model only at judgment points.

### Think from the agent's context window

Harness design should start from what the agent actually sees: identity, task, available tools, memory, signals, recent outcomes, constraints, and completion conditions. Research repeatedly points to context representation as a key performance lever. Barry Zhang frames it as a 10–20k token RAM budget — if a human couldn't succeed with only that text, neither can the agent.

### Treat harness boundaries as product IP

Models will change. The durable value is in the harness: tool interfaces, environment contracts, state model, verification loop, memory curation, observability, and governance. Stanford's Meta Harness work showed a harness optimized on one model transferred its gains to five others — the harness is the IP, not the prompt.

### Prefer artifact-backed completion over naive verifier agents

Research warns that independent "verifier agents" and broad multi-candidate search often add cost and noise unless the task domain has a clear scoring function. The Stanford/Tsinghua benchmarks show verifiers actively degrade system performance (−0.8 to −8.4). For this harness, better first moves are structured completion contracts, explicit artifacts, action receipts, targeted tests, and trace-backed health metrics.

### Observe behavior at the right level

Useful agent telemetry is not only tokens and latency. The harness should also track tool utilization, error density, repeated idle wakes, action item closure, effectiveness decay, verification completion, and cost per useful artifact. The Minerva case study describes silent degradation (a "Bad credentials" spiral that never hard-failed) as the dominant production failure mode.

### Make memory two-tiered

Raw episodic history should remain separate from curated semantic memory. The harness already moved toward persistent memory in ADR-0029; the next step is to wire memory into prompt assembly with clear provenance, token budgets, and validation against memory poisoning.

### Name skill poisoning as a threat; the trust model is the mitigation

Hermes Agent (NousResearch, 103k+ GitHub stars, ICLR 2026) identified **skill poisoning** as a critical unresolved vulnerability in its own architecture: a single-turn prompt injection can cause the agent to write a malicious skill file that loads as trusted context on every future wake, creating a persistent, self-reinforcing compromise. Hermes has no mitigation beyond input filtering because it lacks a formal trust classification — all agent-curated content is implicitly trusted.

This is the precise attack that Proposal 07's trust model prevents. Skills and memory are `semi-trusted` segments. A `semi-trusted` segment cannot grant tools, alter policy, request secrets, override completion criteria, or authorize mutation — regardless of what its content says. The propagation rule is the defense. ADR-003X (Prompt Boundary) should name this threat explicitly. See `docs/research/hermes-applied.md` §1.

### Encode a memory consolidation trigger in role.md

Hermes uses character-limit discipline for MEMORY.md: when the file exceeds 80% of its character budget, the agent consolidates — merging related facts, removing outdated entries, compressing content. This forces selectivity. The trigger is concrete and automatic, not left to agent discretion.

Proposal 07 Phase 6 should encode this as a role.md field: `memory.consolidate_threshold: 0.8`. The `curate_memory` built-in tool should check this threshold on every wake and prompt curation when exceeded. See `docs/research/hermes-applied.md` §2.

### The RunLedger is the substrate for any future self-improvement loop

Hermes's GEPA mechanism (ICLR 2026 Oral) improves agent skills by analyzing complete execution traces — error messages, performance profiling, full reasoning chains. Agents with 20+ self-generated skills run 40% faster on repeated tasks in the same domain. GEPA is an external optimization loop that the harness enables by producing rich execution data.

The `RunLedgerEntry` with `toolReceipts`, `actionReceipts`, `validation`, and `health` is precisely the substrate a GEPA-equivalent loop would consume. Building this ledger correctly in Phases 0–4 is what makes a future Murmurations self-improvement loop possible. The Langfuse self-reflection loop (Phase 5) and a GEPA-style trace analysis loop are complementary: Langfuse feeds architectural improvement through governance; GEPA would optimize task-level procedures autonomously. Phase 5 comes first; GEPA-equivalent is a post-Phase 6 direction. See `docs/research/hermes-applied.md` §3.

### Separate stable and volatile prompt content with an explicit cache boundary

OpenClaw (openclaw/openclaw, 250k+ GitHub stars) uses a `SYSTEM_PROMPT_CACHE_BOUNDARY` marker to explicitly split stable workspace context (identity, role, governance) from volatile context (signals, memory search results, health). This maximizes Anthropic's prompt KV cache reuse across wakes. The Murmurations PromptAssembler will produce this split naturally — but the boundary should be a named, explicit concept, not an accidental property of segment ordering. See `docs/research/openclaw-applied.md` §1.

### The subtraction principle is convergently validated at scale

The subtraction principle (no verifier agents) is confirmed by three independent sources: Stanford/Tsinghua benchmarks (−0.8 to −8.4 on benchmarks with verifiers), the Minerva 27-domain production experiment, and OpenClaw — a widely deployed production system with 250k+ GitHub stars that reached that scale with no internal verifier agents. This is not a preference; it is a repeatedly observed production outcome. The `WakeValidator` checking execution contract conditions is a deterministic contract check, not an LLM verifier call — that distinction holds.

## Current State

### What maps well to best practice

| Area                                             | Current implementation                                                   | Why it matters                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Executor seam                                    | `AgentExecutor`, `DispatchExecutor`, in-process and subprocess executors | Place to add sandboxing, durable execution, alternate runners.                     |
| Signal aggregation                               | `DefaultSignalAggregator` and ADR-0013                                   | Separates wake input collection from runner behavior. The Environment layer.       |
| Collaboration boundary                           | `CollaborationProvider` and ADR-0021                                     | Keeps GitHub/local coordination replaceable.                                       |
| MCP tool loading                                 | `@murmurations-ai/mcp` tool loader                                       | Tools are a first-class layer with standardized schemas.                           |
| Skill scanner                                    | Three-Tier Progressive Disclosure                                        | Skills loaded on demand → lean context window. Implements "think like your agent." |
| Cost tracking                                    | `WakeCostBuilder`, `WakeCostRecord`                                      | Budget is one of the five execution-contract elements.                             |
| Run artifacts                                    | `RunArtifactWriter`                                                      | Persists wake summaries and cost records for review.                               |
| Agent state                                      | `AgentStateStore`                                                        | Tracks lifecycle, failures, idle wakes, artifacts.                                 |
| Observability                                    | Langfuse/OpenTelemetry support in `@murmurations-ai/llm`                 | Foundation for rich self-reflection; needs context threading.                      |
| Governance                                       | `GovernancePlugin` and emitted governance events                         | Model-agnostic separation; correct architecture for transferability.               |
| Write-scope enforcement                          | ADR-0017                                                                 | Permissions element of execution contracts already present.                        |
| GitHub as system of record                       | Issues + labels + committed files                                        | File-backed state survives truncation, restarts, delegation.                       |
| Structured `WakeAction` / `MeetingAction` output | parser + executor                                                        | Prevents prose-only wakes. Validates Minerva's "verification over generation."     |

### Gaps against best practice

Graded: **P0** = correctness gap today, **P1** = significant performance/capability gap, **P2** = future leverage.

#### G1 — P0: Signal bundle is context-incomplete (harness#350)

`DefaultSignalAggregator` passes only `issue.body`. Comments — often the most current instruction — are never fetched. `GithubClient.listIssueComments()` exists and is unused during aggregation.

Research basis: "Think like your agent." If the agent only sees the body but instructions are in comments, it operates blind. Minerva named partial-context hallucinations as the primary failure mode.

#### G2 — P0: No Execution Contracts (Completion Conditions + Output Paths)

The Tsinghua NLAH research defines five contract elements. Three are present, two are missing:

| Element                   | Status                                    |
| ------------------------- | ----------------------------------------- |
| Required Inputs           | ✓ `signals.sources` in role.md            |
| Budgets                   | ✓ `budget.max_cost_micros` in role.md     |
| Permissions               | ✓ `github_scopes` write-scope enforcement |
| **Completion Conditions** | ✗ Missing                                 |
| **Output Paths**          | ✗ Missing                                 |

Post-wake validation cannot enforce what it doesn't know is required. An agent that burns budget and produces nothing registers as "idle" only after the fact — there's no declared contract to measure against.

#### G3 — P1: Prompt assembly is embedded in `DefaultRunner` — no typed boundary

Prompt construction, trust wrapping, signal rendering, and token budgets are spread across `DefaultRunner`, the identity loader, and the MCP loader. There is no `PromptAssembler` with typed `PromptSegment`s, trust levels, or token budgets per segment.

Consequences: untrusted signal text (GitHub issue bodies) is not isolated from trusted identity/governance text. No prompt hash for the ledger. Prompt can't be composed, tested, or replaced independently.

#### G4 — P1: Tool access has no registry, policy, or receipt layer

MCP tools and extension tools are broadly loaded with minimal policy metadata. There is no `ToolRegistry` with per-agent allowlists, mutability declarations, trust levels, timeouts, or verification requirements. Tool outcomes are not recorded as `ToolCallReceipt`s — only LLM cost telemetry is captured.

Security gap: MCP subprocesses inherit the full `process.env` by default, exposing secrets to any MCP server regardless of whether it needs them.

#### G5 — P1: No `EnvironmentSpec` — environment access is implicit

The spawn context scopes declared secrets, but MCP subprocesses inherit `process.env` broadly. There is no explicit declaration of which paths are writable, which secrets go to which tools, or what network access is permitted. Resource limits (CPU, memory, output size) are not declared.

#### G6 — P1: No task dependency graph in signal bundle

The signal aggregator delivers a flat list of GitHub issues. Issues that say "Depends on: #XXX" in their body are indistinguishable from unblocked work. Agents waste context (RAM) and LLM budget attempting blocked tasks.

Research basis: the Minerva experiment found agents thrived with dependency-graph-aware task queues and struggled with flat lists.

#### G7 — P1: Health observability is cost-only — degradation is invisible

`WakeCostBuilder` tracks cost and tokens. Three critical health signals are absent:

- **Tool utilization rate** — an agent that normally uses 5 MCP tools per wake and suddenly uses 0 for three wakes is degraded, not just idle.
- **Error density** — ratio of failed tool calls to successful ones. Minerva's "Bad credentials" spiral wasn't caught because the agent never hard-failed.
- **Effectiveness decay** — `EFFECTIVENESS: low` exists in self-reports, but there is no rolling-window tracking or escalation when it persists.

The current circuit breaker only trips on consecutive hard failures. Silent degradation is invisible.

#### G8 — P1: Langfuse telemetry context is incomplete / not fully threaded

`@murmurations-ai/llm` already has a `telemetryContext` shape for `agentId`, `wakeId`, `groupIds`, and `wakeMode`, and the Vercel adapter can write those fields. The gap is that the default runner does not consistently thread this context into `llm.complete`, and prompt/contract hashes plus validation status do not exist yet. The read path (Langfuse metrics → `LangfuseMetricsSignal` → agent self-reflection) needs complete, queryable write-path metadata.

#### G9 — P1: Memory is episodic-only — no curated semantic tier

Agents write daily digests and artifact files. There is no harness-supported mechanism to distill these into curated semantic memory that survives agent restarts with a high signal-to-noise ratio.

Research basis: "Every session is a lossy compression of what came before." (Minerva). The two-tier architecture — raw episodic (daily digests) + curated semantic (MEMORY.md) — needs a harness-provided `curate_memory` tool.

#### G10 — P2: Budget-awareness is passive — agents can't introspect headroom

Budgets are declared in `role.md` and enforced at breach. Agents have no way to introspect remaining budget _during_ a wake to choose between expensive and cheap approaches. `WakeCostBuilder` already accumulates a running total — surfacing it is a small increment.

## Target Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Source (human)  — intent, strategy, bright lines            │
├─────────────────────────────────────────────────────────────┤
│  Environment Layer  (what the agent perceives)               │
│  SignalBundle: GitHub issues (with comments),                │
│  dependency graph (actionable vs. blocked),                  │
│  health actuals, Langfuse metrics signal,                    │
│  private notes, inbox messages                               │
├─────────────────────────────────────────────────────────────┤
│  Prompt Layer  (what the agent is told)                      │
│  PromptBundle: typed PromptSegments with trust levels,       │
│  token budgets, source refs, hash                            │
│  Segments: identity · role · signals · memory ·              │
│            skills · contract · governance · health           │
├─────────────────────────────────────────────────────────────┤
│  Tools Layer  (what the agent can do)                        │
│  ToolRegistry: MCP · extension · CLI · built-ins             │
│  Policy: deny-by-default, per-agent allowlists,              │
│  mutability, verification requirements                       │
│  ToolCallReceipts: auditable outcome log                     │
├─────────────────────────────────────────────────────────────┤
│  Execution Contract                                          │
│  Required Outputs · Action Items (machine-readable) ·        │
│  Allowed Side Effects · Budget · Completion Conditions ·     │
│  Verification Steps                                          │
├─────────────────────────────────────────────────────────────┤
│  Model Layer                                                 │
│  LLMClient (Vercel AI SDK) · pricing catalog                 │
│  Langfuse telemetry tagged: agentId, wakeId, wakeMode,       │
│  groupIds, promptHash, contractHash                          │
├─────────────────────────────────────────────────────────────┤
│  Ledger  (what was recorded)                                 │
│  promptHash · toolReceipts · actionReceipts ·                │
│  WakeValidationResult · WakeHealthActuals ·                  │
│  WakeCostRecord · artifactRefs                               │
└─────────────────────────────────────────────────────────────┘
```

### 1. AgentRuntime

Introduce a typed runtime object assembled by the daemon before executor spawn:

```ts
export interface AgentRuntime {
  readonly wakeId: WakeId;
  readonly agentId: AgentId;
  readonly model: ResolvedModel;
  readonly prompt: PromptBundle;
  readonly toolset: Toolset;
  readonly environment: EnvironmentSpec;
  readonly contract: ExecutionContract;
  readonly ledger: RunLedgerHandle;
}
```

`AgentSpawnContext` can remain as the compatibility envelope during migration. The target is for `AgentSpawnContext` to carry or derive these explicit boundaries rather than mixing them into one broad context.

During migration, use a `RuntimeAssembler` ownership boundary rather than forcing the daemon to own every runtime detail immediately. The daemon should assemble identity, signals, secrets, minimal contract, and policy inputs. `PromptAssembler`, `ToolRegistry`, and `ToolInvocationRecorder` can remain injected services used by the runner/executor until full runtime assembly is moved out of `DefaultRunner`.

Supporting target types that do not exist yet should be introduced in Phase 0:

```ts
export interface Toolset {
  readonly descriptors: readonly ToolDescriptor[];
  readonly grants: readonly ToolGrant[];
}

export interface RunLedgerHandle {
  append(entry: RunLedgerEntry): Promise<void>;
}

export interface ActionItemRef {
  readonly signalId: string;
  readonly sourceRef?: string;
}

export interface CompletionCondition {
  readonly id: string;
  readonly description: string;
}

export interface VerificationStep {
  readonly id: string;
  readonly description: string;
  readonly required: boolean;
}

export interface LangfuseMetricsSignal {
  readonly agentId: AgentId;
  readonly windowDays: number;
  readonly metrics: Readonly<Record<string, number>>;
}
```

### 2. Prompt Boundary

Prompt assembly should become a core harness service:

```ts
export interface PromptSegment {
  readonly id: string;
  readonly kind:
    | "identity"
    | "role"
    | "wake-task"
    | "signals"
    | "memory"
    | "skills"
    | "tools"
    | "contract"
    | "governance"
    | "health";
  readonly trust: "trusted" | "semi-trusted" | "untrusted";
  readonly tokenBudget?: number;
  readonly content: string;
  readonly sourceRef?: string;
}

export interface PromptBundle {
  readonly system: readonly PromptSegment[];
  readonly messages: readonly LLMMessage[];
  readonly hash: string;
  readonly tokenEstimate: number;
  // Index of the last stable segment — segments before this index are cache-stable across wakes;
  // segments at or after are volatile (signals, memory, health). Enables explicit cache boundary
  // optimization analogous to OpenClaw's SYSTEM_PROMPT_CACHE_BOUNDARY. Should be encoded in
  // ADR-003X, not left to implementation convention.
  readonly cacheAnchorIndex: number;
}
```

Rules:

- Identity, role, governance policy, and execution contract are trusted.
- GitHub issues, local coordination items, external web content, memory excerpts, and tool results are data unless explicitly promoted by a trusted process.
- Untrusted text cannot grant tools, alter policy, request secrets, override completion criteria, or authorize mutation; any tool call materially derived from untrusted input still passes policy and approval checks.
- Each prompt segment gets a token budget and source reference.
- All signal rendering uses a single sanitizer/renderer.
- `AgentSpawnContext.promptPath` / `promptRef` becomes the primary task prompt source after the field is added.
- The prompt bundle hash is recorded in the run ledger and trace metadata.
- **Canonical trust classification per segment kind** (to be encoded in ADR-003X, not left to convention):

  | Segment kind | Trust level    | Rationale                                          |
  | ------------ | -------------- | -------------------------------------------------- |
  | `identity`   | `trusted`      | Harness-authored                                   |
  | `role`       | `trusted`      | Operator-authored, version-controlled              |
  | `contract`   | `trusted`      | Harness-assembled from role.md                     |
  | `governance` | `trusted`      | GovernancePlugin output                            |
  | `skills`     | `trusted`      | Harness-controlled skill scanner                   |
  | `memory`     | `semi-trusted` | Agent-curated, sourced from prior wakes            |
  | `health`     | `semi-trusted` | Harness-derived from agent state                   |
  | `signals`    | `untrusted`    | GitHub issue bodies — external contributor content |
  | `wake-task`  | `untrusted`    | Task prompt text from signal source                |

  Comparison: OpenClaw uses context isolation and structured formatting as informal trust controls; it has no formal propagation model. For headless autonomous agents, formal classification is required. See `docs/research/openclaw-applied.md` §6.

- **Stable/volatile split:** segments with kind `identity`, `role`, `contract`, `governance`, `skills` are stable across wakes for the same agent configuration. Segments with kind `signals`, `memory`, `health`, `wake-task` are volatile per wake. `PromptBundle.cacheAnchorIndex` marks the boundary.

### 3. Tool Boundary

Normalize MCP, extension, CLI, and collaboration tools behind one registry:

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

export interface ToolCallReceipt {
  readonly schemaVersion: number;
  readonly wakeId: WakeId;
  readonly callerAgentId: AgentId;
  readonly toolId: string;
  readonly toolVersion?: string;
  readonly permissions: readonly ToolPermission[];
  readonly mutability: ToolDescriptor["mutability"];
  readonly policyVersion: string;
  readonly policyDecision: "allowed" | "denied" | "approval-required";
  readonly denialReason?: string;
  readonly approvalId?: string;
  readonly approvedBy?: string;
  readonly approvedAt?: string;
  readonly approvalScope?: string;
  readonly secretGrantNames: readonly string[];
  readonly inputHash: string;
  readonly outputHash?: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly outcome: "success" | "failure" | "timeout" | "denied";
  readonly errorCode?: string;
  readonly redactionApplied: boolean;
  readonly resultSummary?: string;
  readonly artifactRefs?: readonly string[];
  readonly externalCorrelationId?: string;
}
```

Rules:

- Tool access is deny-by-default.
- Mutating tools require explicit agent role configuration.
- Tool results are summarized and stored as receipts; large raw output goes to artifacts.
- Secrets passed to tools are scoped by `EnvironmentSpec`, not ambient process inheritance.
- MCP servers receive only declared environment variables by default after migration; ambient env is a compatibility exception requiring explicit config, warning, and risk acceptance.
- Tools that mutate external systems declare verification requirements and, when high-risk, pre-action approval requirements.
- Every adapter-facing tool `execute` function is wrapped by a `ToolInvocationRecorder` before reaching the LLM SDK.
- `budget_remaining()` is a harness built-in tool that surfaces `WakeCostBuilder`'s running total.

### 4. Environment Boundary

Make runtime environment a first-class object, not a loose string map:

```ts
export interface EnvironmentSpec {
  readonly cwd?: string;
  readonly workspace?: {
    readonly root: string;
    readonly writablePaths: readonly string[];
    readonly readOnlyPaths: readonly string[];
  };
  readonly publicEnv: Readonly<Record<string, string>>;
  readonly secretGrants: readonly {
    readonly name: string;
    readonly targetEnv: string;
    readonly allowedToolIds: readonly string[];
  }[];
  readonly network: "none" | "declared" | "ambient";
  readonly resourceLimits?: {
    readonly wallClockMs: number;
    readonly cpuMs?: number;
    readonly memoryMb?: number;
    readonly maxOutputBytes?: number;
  };
}
```

Rules:

- The daemon may resolve secrets, but tools and executors receive only what the environment spec grants.
- Tool subprocesses do not inherit `process.env` by default.
- Network access is explicit.
- Workspace write access is explicit.
- Environment spec is recorded by reference/hash in the ledger, with secret values redacted.
- Until `ContainerExecutor` or equivalent OS controls enforce filesystem/network limits, those limits are declared policy plus tool-wrapper enforcement rather than hard isolation.
- MCP server commands/configs should be allowlisted or pinned and recorded by hash.
- **Policy precedence ladder** (Phase 7): each level narrows or restricts, never expands beyond its parent. The assembled EnvironmentSpec is the intersection of all applicable layers:
  ```
  Harness Default → Group Policy → Role Policy → Wake Override
  ```
  `secretGrants` follows the same ladder — the most restrictive applicable level wins. Reference: OpenClaw's sandbox policy precedence model (Tool Profile → Provider Profile → Global → Provider → Agent → Group → Sandbox). See `docs/research/openclaw-applied.md` §3.

### 5. Execution Contract

Every wake should carry a contract that says what useful completion means:

```ts
export interface ExecutionContract {
  readonly wakeReason: WakeReason;
  readonly wakeMode: WakeMode;
  readonly objective: string;
  readonly requiredOutputs: readonly {
    readonly kind:
      | "summary"
      | "runtime-artifact"
      | "committed-artifact"
      | "comment"
      | "issue"
      | "commit"
      | "governance-event";
    readonly path?: string;
    readonly description: string;
  }[];
  readonly actionItems: readonly ActionItemRef[];
  readonly allowedSideEffects: readonly ToolPermission[];
  readonly budget: CostBudget;
  readonly completionConditions: readonly CompletionCondition[];
  readonly verification: readonly VerificationStep[];
  readonly approval: ApprovalPolicy;
}
```

Rules:

- Action items are machine-readable inputs to the contract, not just prompt text.
- A wake that only summarizes should be valid only if the contract permits summary-only completion.
- Mutating actions must produce receipts.
- Verification failures should not disappear into logs; they should be part of the result.

`role.md` operator-facing declaration:

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

### 6. Signal Bundle — Dependency-Aware + Health-Enriched

```ts
export interface BlockedActionItem {
  readonly signal: Signal;
  readonly blockedBy: readonly string[];
}

export interface SignalBundle {
  readonly signals: readonly Signal[];
  readonly actionItems: readonly Signal[]; // compatibility field
  readonly actionItemGraph?: {
    readonly actionable: readonly Signal[]; // no unresolved dependencies
    readonly blocked: readonly BlockedActionItem[]; // has open Depends-on issues
  };
  readonly health: WakeHealthActuals; // rolling window from AgentStateStore
  readonly langfuseMetrics?: LangfuseMetricsSignal; // present if Langfuse configured + 7+ days data
}
```

The aggregator:

1. Fetches comments when `commentCount > 0` (G1 / harness#350).
2. Extracts `Depends on: #XXX` / `Blocks: #YYY` from issue bodies.
3. Adds `actionItemGraph` without replacing the existing `actionItems` array.
4. Attaches `WakeHealthActuals` from the rolling window.
5. Attaches `LangfuseMetricsSignal` when Langfuse is configured and has sufficient history.

### 7. Two-Tier Memory

```
Tier 1 — Episodic (raw, append-only):
  agents/<id>/digests/YYYY-MM-DD.md
  agents/<id>/logs/YYYY-MM-DD.jsonl

Tier 2 — Semantic (curated, distilled):
  agents/<id>/MEMORY.md          ← harness-standard location, curated by agent
  agents/<id>/knowledge/*.md     ← domain knowledge files, committed artifacts
```

The harness provides a `curate_memory` built-in tool that:

1. Takes a date range.
2. Reads episodic digests for that range.
3. Returns a proposed MEMORY.md delta for the agent to review and commit.

`role.md` adds `memory.curate_on: "weekly"` and `memory.consolidate_threshold: 0.8` to trigger curation. When the agent's MEMORY.md exceeds 80% of its token budget, `curate_memory` is automatically invoked to merge related facts, remove outdated entries, and compress content before the next wake. This enforces selectivity rather than leaving consolidation to agent discretion (validated by Hermes Agent's character-limit discipline). See `docs/research/hermes-applied.md` §2.

Prompt integration: the `PromptAssembler` injects MEMORY.md content as a `"memory"` segment with trust `"semi-trusted"` and an explicit token budget. Memory poisoning is mitigated, not eliminated, through provenance, source attribution, taint-aware curation, reviewable diffs, and write-scope enforcement.

### 8. Ledger and Observability Boundary

Run artifacts should evolve into a run ledger:

```ts
export interface RunLedgerEntry {
  readonly schemaVersion: number;
  readonly sequence: number;
  readonly previousEntryHash?: string;
  readonly entryHash: string;
  readonly wakeId: WakeId;
  readonly agentId: AgentId;
  readonly promptHash: string;
  readonly contractHash: string;
  readonly model: ResolvedModel;
  readonly toolReceipts: readonly ToolCallReceipt[];
  readonly actionReceipts: readonly WakeActionReceipt[];
  readonly validation: WakeValidationResult;
  readonly health: WakeHealthActuals;
  readonly cost: WakeCostRecord;
  readonly artifactRefs: readonly string[];
}
```

`RunLedgerEntry` should be an append-only projection of `AgentResult + WakeValidationResult + prompt/contract/tool metadata`, not a parallel replacement for those types. Early phases need this observational ledger for debugging and evals; resumable checkpoints and replay protection come later with durable execution.

**Signed provenance for agent-written artifacts (Phase 6):** When Phase 6 enables agents to write skill or knowledge files, each file's `artifactRef` in the ledger should record the `wakeId`, `agentId`, and signal sources that produced it. This is the mitigation for Hermes's skill-poisoning gap — if a skill is later found to be malicious, the ledger identifies which wake and which signals produced it. Without this, autonomous skill generation is an unaudited trust escalation. See `docs/research/hermes-applied.md` §1.

`WakeHealthActuals`:

```ts
export interface WakeHealthActuals {
  readonly toolCalls: number;
  readonly mutatingToolCalls: number;
  readonly toolFailures: number;
  readonly toolErrorDensity: number;
  readonly actionItemsAssigned: number;
  readonly actionItemsAddressed: number;
  readonly verificationStepsRequired: number;
  readonly verificationStepsPassed: number;
  readonly idleWake: boolean;
  readonly selfReportedEffectiveness?: "high" | "medium" | "low";
  readonly costPerArtifactMicros?: number;
}
```

Rules:

- Langfuse/OTel traces should carry `agentId`, `wakeId`, `wakeMode`, prompt hash, contract hash, tool counts, validation status, and effectiveness.
- The dashboard should distinguish failure, timeout, idle, productive, and unverified completion.
- HealthState policy should consider repeated idle wakes and low effectiveness, not only hard failures; hard pause should remain opt-in per role policy.

Langfuse telemetry write path:

```ts
// packages/llm/src/adapters/vercel-adapter.ts
experimental_telemetry: {
  isEnabled: true,
  functionId: `${this.providerId}/${this.modelUsed}`,
  metadata: {
    agentId:       options.telemetryContext?.agentId       ?? "unknown",
    wakeId:        options.telemetryContext?.wakeId        ?? "unknown",
    wakeMode:      options.telemetryContext?.wakeMode      ?? "individual",
    groupIds:      options.telemetryContext?.groupIds?.join(",") ?? "",
    murmurationId: options.telemetryContext?.murmurationId ?? "unknown",
    // Hash fields are omitted when unset rather than stringified, so trace
    // queries by hash never collide with a literal "unknown" sentinel.
    ...(options.telemetryContext?.promptHash   ? { promptHash:   options.telemetryContext.promptHash }   : {}),
    ...(options.telemetryContext?.contractHash ? { contractHash: options.telemetryContext.contractHash } : {}),
  },
},
```

Threading complete `telemetryContext` from daemon/runner → `LLMClient` → adapter unblocks the read path: a `LangfuseMetricsSource` can query by `agentId` and return a `LangfuseMetricsSignal` in the agent's `SignalBundle`.

## Proposed Module Boundaries

```text
packages/core/src/runtime/
  agent-runtime.ts          # AgentRuntime assembly types
  prompt-assembler.ts       # PromptBundle construction and segment policy
  execution-contract.ts     # Completion contracts and validation inputs
  run-ledger.ts             # Durable wake ledger API

packages/core/src/tools/
  registry.ts               # ToolRegistry and ToolDescriptor
  receipts.ts               # ToolCallReceipt helpers
  policy.ts                 # allow/deny checks
  invocation-recorder.ts    # wraps execute() for policy + receipts
  builtins.ts               # budget_remaining(), curate_memory()

packages/core/src/environment/
  environment-spec.ts       # EnvironmentSpec and redaction
  secret-grants.ts          # secret-to-tool grants

packages/core/src/validation/
  wake-validator.ts         # contract-backed validation
  health.ts                 # WakeHealthActuals derivation + HealthState policy
```

Existing files become adapters:

- `packages/core/src/runner/index.ts` → consumes `PromptBundle`, `Toolset`, and `ExecutionContract`.
- `packages/mcp/src/tool-loader.ts` → MCP provider for `ToolRegistry`.
- `packages/core/src/daemon/runs.ts` → filesystem implementation of `RunLedger`.
- `packages/core/src/execution/index.ts` → compatibility export while types migrate.

## Migration Plan

### Phase 0: Specification and no-op types

- Add `PromptBundle`, `PromptSegment`, `ToolDescriptor`, `ToolGrant`, `ToolCallReceipt`, `EnvironmentSpec`, `ExecutionContract`, `WakeHealthActuals`, and `RunLedgerEntry` as types only.
- Do not change runtime behavior yet.
- Add fixtures/tests that show how an existing wake maps into the new boundaries.
- Compile the proposed type module in CI so undefined or duplicate types fail fast.
- Add an evaluation lane: golden wake fixtures, prompt assembly snapshots, tool-policy denial tests, contract-validation tests, trace-level regression metrics.

### Phase 1: Signal quality and minimal contracts (v0.7.2, P0 gaps)

- Fetch GitHub issue comments when present so agents see current instructions, not only issue bodies.
- Add dependency-aware action item metadata as additive fields, preserving the current `SignalBundle.actionItems` array during migration.
- Add a minimal execution contract scaffold (`objective`, `requiredOutputs`, `allowedSideEffects`, `done_when`) before full verification hooks exist.
- Add validation status and artifact count to run artifact index entries.

### Phase 2: Prompt boundary cleanup

- Move prompt construction from `DefaultRunner` into `PromptAssembler`.
- Add optional `promptPath`/`promptRef` to `AgentSpawnContext`, derived from role `prompt.ref`, then make it authoritative with legacy `agents/<id>/prompts/wake.md` fallback.
- Replace runner-local signal rendering with the shared trusted signal renderer.
- Add prompt segment hashes and token estimates to run artifacts.
- Parse structured wake actions in `DefaultRunner` and surface parse errors.

**ADR required:** ADR-003X "Prompt Boundary" — trust levels, segment policy, sanitizer contract.

### Phase 3: Tool boundary cleanup

- Introduce `ToolRegistry` and normalize extension tools and MCP tools into `ToolDescriptor`.
- Add `ToolGrant` / per-agent extension tool allowlists.
- Add tool permissions, mutability, timeouts, and verification metadata.
- Add `ToolInvocationRecorder` around every tool `execute` function passed to the LLM SDK.
- Record normalized tool receipts.
- Add MCP env migration controls (`ambientEnv` flag, explicit grants, warnings), then flip the default away from ambient `process.env`.
- **MCP supply-chain:** MCP server commands/configs must be allowlisted or pinned and recorded by hash. Hermes's security review (103k+ star production deployment) explicitly warned that MCP's discovery surface "is the same surface that made npm a decade-long supply-chain problem." Allowlist-and-pin is required, not optional hardening. See `docs/research/hermes-applied.md` §4.
- Add `budget_remaining()` built-in tool.

### Phase 4: Contract-backed completion

- Expand minimal execution contracts into full contract generation in `buildSpawnContext`.
- Map signal action items into `ExecutionContract.actionItems`.
- Allow role frontmatter to declare required outputs and completion conditions.
- Replace shallow productivity validation with contract-backed validation.
- Include validation results in `RunArtifactIndexEntry`.

**ADR required:** ADR-003Y "Execution Contracts" — five elements and enforcement semantics.

### Phase 5: Health metrics and self-reflection

- Add `WakeHealthActuals` derivation.
- Feed health metrics into Langfuse metadata and run artifacts.
- Extend agent state to track rolling idle rate, action closure rate, tool error density, and self-reported effectiveness.
- Add passive `HealthState` warnings for repeated idle or low-effectiveness wakes; hard pause only when role policy opts in.
- Inject recent health summaries as semi-trusted self-reflection signals.
- Add `LangfuseMetricsSource` and self-reflection `SKILL.md`.

### Phase 6: Two-tier memory and self-improvement loop

- `role.md` schema: `memory.curate_on` field.
- Two-tier memory convention enforced by `IdentityLoader`.
- `PromptAssembler` injects MEMORY.md as `"memory"` segment.
- Add `curate_memory` built-in tool.
- Self-improvement governance event kinds (model-agnostic).
- Group retrospective integration with `WakeHealthActuals` + Langfuse data.

### Phase 7: Durable execution ledger and isolation

- Implement Proposal 04 using the run ledger as the durable history.
- Store checkpoint references for prompt, contract, tool receipts, action receipts, validation, and artifacts.
- Make mutating tools idempotent where possible through request IDs, receipt lookup, and hash-chained ledger entries.
- Implement Proposal 01 `ContainerExecutor`.
- Apply `EnvironmentSpec` to filesystem, env, network, CPU, memory, and output limits.
- Prefer sandboxed execution for untrusted or high-permission agents.

Phase 7 gates on Phase 3 (tool contracts) and Phase 4 (environment specs) being stable.

## Near-Term High-Value Fixes

These are small enough to do before the full migration:

1. Add optional `promptPath`/`promptRef` to `AgentSpawnContext` and use it in `DefaultRunner`.
2. Route all signal prompt rendering through `renderSignalForPrompt`.
3. Call `parseWakeActions(content)` in `DefaultRunner`.
4. Add validation status and artifact count to run artifact index entries.
5. Add explicit per-agent extension tool allowlists.
6. Add MCP env migration controls before changing the default to empty env plus declared grants.
7. Log or record failed best-effort artifact commits instead of silently ignoring them.
8. Include `wakeId`, `agentId`, `wakeMode`, and validation status in every LLM telemetry call.
9. Add minimal execution-contract fields so productive completion is declared early.

## Architectural Principles

These are guardrails to encode in `CLAUDE.md` and `ARCHITECTURE.md` — not implementation tasks.

### The Subtraction Principle

> Disciplined narrowing beats expensive broadening every time.

Do not add verifier agents or multi-candidate search loops. This principle is convergently validated by three independent sources:

1. **Stanford/Tsinghua benchmarks**: verifier agents actively degrade system performance (−0.8 to −8.4 on benchmarks across 10 models).
2. **Minerva (27-domain production experiment)**: verified that disciplined contracts and artifact-backed completion outperform added verifier layers.
3. **OpenClaw (production runtime, 250k+ GitHub stars)**: reached wide deployment with no internal verifier agents — its architecture is model → tool → result → continue, with a serialized Command Queue for ordering rather than a verification layer.

`WakeValidator` checking execution contract conditions is correct — it is a deterministic contract check, not an LLM verifier call. That distinction holds.

### Context Window is RAM

> Everything the agent knows is in 10–20k tokens. If a human couldn't succeed with only that text, neither can the agent.

- Comments must be in the signal bundle (G1) — body-only signals are RAM starvation.
- `jcodemunch-mcp` + `jdocmunch-mcp` keep context lean; agents pull on demand.
- `PromptSegment.tokenBudget` makes RAM allocation explicit per segment.
- Memory is injected as a `semi-trusted` segment with a declared budget — not appended wholesale.
- Untrusted text is rendered as data with explicit instruction hierarchy. It cannot grant tools, alter policy, request secrets, override completion criteria, or authorize mutation; any tool call materially derived from untrusted input still passes policy and approval checks.

### The Harness is the Durable Asset

> A harness optimized on one model transferred its gains to five others. The harness is the IP, not the prompt.

- `role.md`, `soul.md`, `harness.yaml` are operator-facing interfaces. Version and schema-validate them.
- Execution contracts make expectations machine-readable — not documentation.
- Every tightened contract or formalized interface increases transferability across model upgrades.

### Governance-Agnostic Self-Improvement

> The self-reflection pipeline produces data and proposals. The governance plugin decides what happens next.

The Langfuse metrics → self-reflection → governance proposal loop must never hardcode S3 consent patterns, Chain of Command flows, or any model-specific behavior. The feedback loop goes _through_ governance, not around it. This is the fundamental safety guarantee.

## Non-Goals

- Do not replace the current simple wake loop with a complex multi-agent planner.
- Do not add generic verifier agents as the default verification strategy.
- Do not build a vector memory layer until the prompt, contract, and ledger boundaries are stable.
- Do not make every tool sandboxed before tool metadata and environment specs exist.

## Acceptance Criteria

The target architecture is working when:

- A wake can be inspected as `model + prompt + toolset + environment + contract + ledger`.
- Prompt segments have provenance, trust level, token budget, and hash.
- Tool access is explicit, auditable, and per-agent (deny-by-default).
- MCP subprocesses receive only declared environment variables.
- Environment access is explicit, least-privilege, and redacted in artifacts.
- Completion is evaluated against a contract, not inferred from summary text alone.
- Run artifacts include prompt hash, contract hash, action receipts, tool receipts, validation, health metrics, and costs.
- Tool receipts include policy decisions, denial receipts, secret grant names, redaction status, output hashes, and approval metadata when applicable.
- Run ledger entries are append-only and hash-chained.
- Agents can review their own recent performance through curated health signals in their signal bundle.
- Langfuse traces are queryable by `agentId`, `wakeId`, and `wakeMode`.
- Sandboxed execution can enforce the same environment and tool contracts used by normal execution.

## Recommendation

Adopt the atomic runtime boundary as the guiding architecture:

```text
Model + Prompt + Toolset + Environment + ExecutionContract + Ledger
```

Start with signal completeness, minimal execution contracts, and the typed runtime boundaries. Then move prompt and tool boundaries behind dedicated services. Those steps unlock contract-backed validation, richer health metrics, durable execution, and sandboxing while preserving the simple loop that already works.

## Appendix: Research → Implementation Map

| Research finding                                          | Primary implementation location                                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Execution contracts / 5 elements (NLAH)                   | `core/runtime/execution-contract.ts` + `core/identity/` schema + `core/validation/wake-validator.ts`    |
| File-backed state (NLAH)                                  | Already correct — GitHub issues + JSONL. Reinforce, don't replace.                                      |
| Prompt trust segmentation (NLAH)                          | `core/runtime/prompt-assembler.ts`                                                                      |
| Tool receipts + registry (NLAH)                           | `core/tools/registry.ts` + `core/tools/receipts.ts`                                                     |
| Ambient observability (Minerva)                           | `core/validation/health.ts` + `core/daemon/` (HealthState policy)                                       |
| Task dependency graph (Minerva)                           | `packages/signals/src/index.ts`, with a future split into a GitHub-specific aggregator module if needed |
| Two-tier memory (Minerva)                                 | `core/tools/builtins.ts` (`curate_memory`) + `core/identity/` schema                                    |
| Langfuse telemetry tags (spike)                           | `packages/llm/src/adapters/vercel-adapter.ts` + spawn context threading                                 |
| Langfuse metrics as signal (spike)                        | `packages/signals/src/` (new `LangfuseMetricsSource`)                                                   |
| Self-reflection skill (spike)                             | `skills/self-reflection/SKILL.md`                                                                       |
| Environment + Tools + Prompt as atomic loop (Barry Zhang) | `core/runtime/agent-runtime.ts` (types), then phases 2–4 (implementations)                              |
| Budget introspection (Barry Zhang)                        | `core/tools/builtins.ts` (`budget_remaining()` tool)                                                    |
| Context window discipline (Barry Zhang)                   | `PromptSegment.tokenBudget` + `jcodemunch-mcp` policy in `CLAUDE.md`                                    |
| Harness as transferable IP (Meta Harness)                 | `role.md` + `soul.md` schema stability + execution contract formalization                               |
