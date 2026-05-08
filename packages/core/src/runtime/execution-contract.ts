/**
 * Execution contract — Proposal 07 Phase 0 (types only, no wiring).
 *
 * `ExecutionContract` encodes what a wake must produce (obligation) and
 * what it is allowed to do (permission). The dual lifecycle:
 *
 *   - At spawn time: injected as a `trusted` prompt segment so the model
 *     knows what it must produce and what it may do.
 *   - Post-wake: used as the validation frame by `WakeValidator` (Phase 4).
 *
 * These two uses are not redundant — the injection encodes intent for the
 * model; the validation checks what actually happened. Conflating them
 * obscures which part of the contract was violated in a failed wake.
 *
 * `role.md` operator-facing YAML (Phase 4):
 *   contract:
 *     done_when:
 *       - "At least one file committed to agents/<id>/knowledge/"
 *     committed_artifacts:
 *       - "agents/<id>/knowledge/*.md"
 *     verification_required_for:
 *       - "github.create_pull_request"
 *     approval_required_for:
 *       - "admin"
 */

import type { CostBudget, WakeMode, WakeReason } from "../execution/index.js";
import type { ApprovalPolicy, ToolPermission } from "../tools/registry.js";

// ---------------------------------------------------------------------------
// Sub-types
// ---------------------------------------------------------------------------

/** Machine-readable reference to an action item from the signal bundle. */
export interface ActionItemRef {
  /** Signal id of the action item issue (e.g. `"github-issue:xeeban/ep#842"`). */
  readonly signalId: string;
  /** Optional source ref for provenance (e.g. the issue URL). */
  readonly sourceRef?: string;
}

/** One testable condition that must be true for the wake to be considered done. */
export interface CompletionCondition {
  /** Stable id for this condition (e.g. `"committed-knowledge-file"`). */
  readonly id: string;
  /** Human-readable description that can be injected into the prompt. */
  readonly description: string;
}

/** One step the harness or operator must verify after the model run. */
export interface VerificationStep {
  readonly id: string;
  readonly description: string;
  /** When `true`, the wake is not marked productive until this step passes. */
  readonly required: boolean;
}

// ---------------------------------------------------------------------------
// ExecutionContract
// ---------------------------------------------------------------------------

/** Full execution contract for one wake. Assembled by the daemon in Phase 4;
 *  in Phase 0 and Phase 1 only a minimal scaffold is populated. */
export interface ExecutionContract {
  /** Why this wake was triggered. */
  readonly wakeReason: WakeReason;
  readonly wakeMode: WakeMode;
  /** One-sentence description of what this wake should accomplish. */
  readonly objective: string;

  // ── Obligation sub-contract ────────────────────────────────────────────
  // Injected as a `trusted` prompt segment at spawn time.
  // Checked by WakeValidator POST-WAKE against actuals (Phase 4).

  /** Artifacts the agent must produce to satisfy the contract. */
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
  /** Action items from the signal bundle mapped into the contract. */
  readonly actionItems: readonly ActionItemRef[];
  /** Testable completion conditions (Phase 4 validator checks these). */
  readonly completionConditions: readonly CompletionCondition[];
  /** Post-wake verification steps (Phase 4). */
  readonly verification: readonly VerificationStep[];

  // ── Permission sub-contract ───────────────────────────────────────────
  // Injected as a `trusted` prompt segment at spawn time.
  // Checked PRE-ACTION by the policy layer and ApprovalPolicy (Phase 3).

  /** Tool permission classes the agent may exercise this wake. */
  readonly allowedSideEffects: readonly ToolPermission[];
  readonly budget: CostBudget;
  readonly approval: ApprovalPolicy;
}
