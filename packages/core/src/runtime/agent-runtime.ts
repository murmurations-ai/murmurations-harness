/**
 * AgentRuntime — Proposal 07 Phase 0 (types only, no wiring).
 *
 * `AgentRuntime` is the typed, atomic boundary that defines what runs
 * in one wake. The target architecture:
 *
 *   AgentRuntime = Model + Prompt + Toolset + Environment + ExecutionContract + Ledger
 *
 * During migration (Phases 1–4), `AgentSpawnContext` remains the
 * compatibility envelope. `AgentRuntime` fields are assembled by a
 * `RuntimeAssembler` alongside the spawn context, giving us an
 * incrementally typed view of the wake without a flag-day rewrite.
 *
 * Phase 2: `PromptBundle` produced by `PromptAssembler` (extracted from DefaultRunner).
 * Phase 3: `Toolset` produced by `ToolRegistry`.
 * Phase 4: `ExecutionContract` fully populated; `WakeValidator` checks it.
 * Phase 7: `RunLedgerHandle` backed by a durable `RunLedger` implementation.
 */

import type { AgentId, ResolvedModel, WakeId } from "../execution/index.js";
import type { EnvironmentSpec } from "../environment/environment-spec.js";
import type { ExecutionContract } from "./execution-contract.js";
import type { PromptBundle } from "./prompt-assembler.js";
import type { RunLedgerHandle } from "./run-ledger.js";
import type { ToolDescriptor, ToolGrant } from "../tools/registry.js";

// ---------------------------------------------------------------------------
// Toolset
// ---------------------------------------------------------------------------

/** The set of tools available to one agent during one wake. Assembled by
 *  `ToolRegistry` (Phase 3) from MCP server configs, extension tools,
 *  CLI tools, and collaboration tools declared in `role.md`. */
export interface Toolset {
  /** Full descriptors for every available tool. */
  readonly descriptors: readonly ToolDescriptor[];
  /** Per-agent grants that authorize specific tools. Deny-by-default:
   *  a tool with no matching grant is unavailable. */
  readonly grants: readonly ToolGrant[];
}

// ---------------------------------------------------------------------------
// AgentRuntime
// ---------------------------------------------------------------------------

/** The typed atomic runtime boundary for one wake.
 *
 * Assembled by the daemon before executor spawn. The daemon is the
 * composition root; services (`PromptAssembler`, `ToolRegistry`,
 * `EnvironmentSpec` resolver) are injected during assembly.
 *
 * Migration note: `AgentSpawnContext.environment` (the loose string map)
 * is the Phase 0 compatibility field. `AgentRuntime.environment` (the
 * typed `EnvironmentSpec`) is the Phase 3+ target. Both coexist during
 * migration to avoid a flag-day break. */
export interface AgentRuntime {
  readonly wakeId: WakeId;
  readonly agentId: AgentId;
  readonly model: ResolvedModel;
  /** Assembled prompt bundle (Phase 2: produced by PromptAssembler). */
  readonly prompt: PromptBundle;
  /** Available tools with grants (Phase 3: produced by ToolRegistry). */
  readonly toolset: Toolset;
  /** Runtime environment spec (Phase 3: replaces ambient process.env). */
  readonly environment: EnvironmentSpec;
  /** Execution contract (Phase 4: fully validated by WakeValidator). */
  readonly contract: ExecutionContract;
  /** Narrow ledger write handle for this wake (Phase 7: durable backend). */
  readonly ledger: RunLedgerHandle;
}
