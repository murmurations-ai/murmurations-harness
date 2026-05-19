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

import { z } from "zod";

import type { CostBudget, Signal, SignalBundle, WakeMode, WakeReason } from "../execution/index.js";
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

  /**
   * Artifacts the agent must produce to satisfy the contract.
   *
   * Each obligation accepts either a single `path` glob OR a list of `paths`.
   * When `paths` is set, any one of the listed globs satisfies the obligation
   * (OR semantics) — this is how the assembler folds a multi-entry
   * `committed_artifacts:` list into a single obligation. `path` and `paths`
   * are exclusive; a caller setting both is using the older (single-path)
   * shape and `paths` is ignored.
   */
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
    readonly paths?: readonly string[];
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

// ---------------------------------------------------------------------------
// `role.md` operator-facing contract declaration
// ---------------------------------------------------------------------------

/**
 * Zod schema for the optional `contract:` block in `role.md` frontmatter
 * (ADR-0047 §4, Phase 4 PR 1). All arrays default to empty so a partial
 * `contract: {}` block parses cleanly; unknown keys are rejected via
 * `.strict()` so typos surface at boot rather than silently degrading.
 *
 * The schema is intentionally minimal per the "v1 brutally simple"
 * design principle in `docs/plans/proposal-07-phase4-implementation.md`:
 * no nesting, no expressions, no operators beyond single-level `OR` in
 * `done_when[]` strings (parsed downstream in `buildSpawnContext` —
 * PR 2). When operators demand more expressive grammar, file a
 * follow-up ADR rather than extending this schema.
 *
 * The downstream mapping into {@link ExecutionContract} happens at
 * spawn time in PR 2. Operators with no `contract:` block fall back
 * to the synthesized minimal default (ADR-0047 §4 fallback).
 */
export const contractDeclarationSchema = z
  .object({
    done_when: z.array(z.string()).default([]),
    committed_artifacts: z.array(z.string()).default([]),
    runtime_artifacts: z.array(z.string()).default([]),
    verification_required_for: z.array(z.string()).default([]),
    approval_required_for: z.array(z.string()).default([]),
  })
  .strict();

/** Parsed `contract:` block from `role.md` frontmatter. Optional on
 *  the parent schema; this type is what consumers see when a role
 *  declares the block. */
export type ContractDeclaration = z.infer<typeof contractDeclarationSchema>;

// ---------------------------------------------------------------------------
// assembleExecutionContract (Phase 4 PR 2)
// ---------------------------------------------------------------------------

/** GitHub write scope shape consumed by {@link assembleExecutionContract}.
 *  Mirrors the subset of `RegisteredAgent.githubWriteScopes` the contract
 *  cares about — pulled out so this module does not depend on `daemon/`. */
export interface GithubWriteScopesView {
  readonly issueComments: readonly string[];
  readonly branchCommits: readonly { readonly repo: string; readonly paths: readonly string[] }[];
  readonly labels: readonly string[];
  readonly issues: readonly string[];
}

/** Inputs to {@link assembleExecutionContract}. */
export interface AssembleExecutionContractArgs {
  readonly wakeReason: WakeReason;
  readonly wakeMode: WakeMode;
  /** Parsed `contract:` block from `role.md`. Undefined when the role
   *  does not declare a contract — the function still returns a valid
   *  {@link ExecutionContract} populated only from runtime context. */
  readonly declaration: ContractDeclaration | undefined;
  readonly signals: SignalBundle;
  readonly budget: CostBudget;
  readonly githubWriteScopes: GithubWriteScopesView;
}

/** Maps a single action-item Signal to an {@link ActionItemRef}. */
const toActionItemRef = (signal: Signal): ActionItemRef => {
  const sourceRef =
    signal.kind === "github-issue" || signal.kind === "governance-round" ? signal.url : undefined;
  return {
    signalId: signal.id,
    ...(sourceRef !== undefined ? { sourceRef } : {}),
  };
};

/**
 * Build a full {@link ExecutionContract} for one wake.
 *
 * Combines the operator-authored `contract:` block from `role.md` with
 * runtime context (signal bundle, budget, wake reason, GitHub write
 * scopes). The result is the single source of truth used by:
 *
 *   - The prompt assembler (PR 3) to render `requiredOutputs` and
 *     `actionItems` into the system prompt.
 *   - `validateOutcomes` (PR 4) to score the wake against the
 *     declared obligations.
 *
 * Phase 4 PR 2 keeps the assembly intentionally minimal:
 *
 *   - `objective` is the first `done_when` string when present, else
 *     a synthesized one-line derived from `wakeReason`.
 *   - `requiredOutputs` is the concatenation of `committed_artifacts`
 *     and `runtime_artifacts` from the declaration; each entry becomes
 *     a glob-style required-output descriptor.
 *   - `actionItems` is the SignalBundle's action-item array mapped 1:1
 *     to {@link ActionItemRef}.
 *   - `completionConditions` is one entry per `done_when` string.
 *   - `verification` is one required step per `verification_required_for`
 *     entry.
 *   - `allowedSideEffects` is derived from `githubWriteScopes`: `read`
 *     is always granted; `write` is added when any write scope is
 *     non-empty. Finer-grained tool permission grants land in a later
 *     PR.
 *   - `approval` requires Source approval when `approval_required_for`
 *     is non-empty; the reason string lists the gated keys.
 *
 * Phase 5+ will replace this with full Tsinghua NLAH semantics
 * (disjunction, exemption, partial-credit). The v1 form is brutally
 * simple per ADR-0048 §Decision-drivers (1) and the
 * "v1 DSLs brutally simple" project rule.
 */
export const assembleExecutionContract = (
  args: AssembleExecutionContractArgs,
): ExecutionContract => {
  const declaration = args.declaration;

  // Fold a multi-entry path list into ONE obligation with OR semantics
  // across the listed globs. A single-entry list becomes a single-path
  // obligation (no `paths` field) for backwards-compatible output shape.
  const foldPaths = <K extends "committed-artifact" | "runtime-artifact">(
    kind: K,
    list: readonly string[],
    describe: (p: string) => string,
    describeMany: (n: number) => string,
  ): readonly {
    kind: K;
    path?: string;
    paths?: readonly string[];
    description: string;
  }[] => {
    if (list.length === 0) return [];
    if (list.length === 1) {
      const path = list[0]!;
      return [{ kind, path, description: describe(path) }];
    }
    return [{ kind, paths: list, description: describeMany(list.length) }];
  };

  const committedOutputs = foldPaths(
    "committed-artifact",
    declaration?.committed_artifacts ?? [],
    (p) => `Committed artifact matching: ${p}`,
    (n) => `Committed artifact matching any of ${String(n)} declared paths`,
  );
  const runtimeOutputs = foldPaths(
    "runtime-artifact",
    declaration?.runtime_artifacts ?? [],
    (p) => `Runtime artifact matching: ${p}`,
    (n) => `Runtime artifact matching any of ${String(n)} declared paths`,
  );
  const requiredOutputs = [...committedOutputs, ...runtimeOutputs];

  const actionItems = args.signals.actionItems.map(toActionItemRef);

  const completionConditions: readonly CompletionCondition[] = (declaration?.done_when ?? []).map(
    (description, idx) => ({
      id: `done-when-${String(idx)}`,
      description,
    }),
  );

  const verification: readonly VerificationStep[] = (
    declaration?.verification_required_for ?? []
  ).map((id, idx) => ({
    id: `verification-${String(idx)}`,
    description: `Verification required for: ${id}`,
    required: true,
  }));

  const writeScopes = args.githubWriteScopes;
  const hasAnyWrite =
    writeScopes.issueComments.length > 0 ||
    writeScopes.branchCommits.length > 0 ||
    writeScopes.labels.length > 0 ||
    writeScopes.issues.length > 0;
  const allowedSideEffects: readonly ToolPermission[] = hasAnyWrite ? ["read", "write"] : ["read"];

  const firstDoneWhen = declaration?.done_when[0];
  const objective =
    firstDoneWhen ??
    (args.wakeReason.kind === "scheduled"
      ? `Scheduled wake (${args.wakeReason.cronExpression})`
      : args.wakeReason.kind === "event"
        ? `Event-triggered wake: ${args.wakeReason.eventType}`
        : `Manual wake invoked by ${args.wakeReason.invokedBy}`);

  const approvalKeys = declaration?.approval_required_for ?? [];
  const approval: ApprovalPolicy =
    approvalKeys.length > 0
      ? {
          mode: "required",
          reason: `Source approval required for: ${approvalKeys.join(", ")}`,
        }
      : { mode: "none" };

  return {
    wakeReason: args.wakeReason,
    wakeMode: args.wakeMode,
    objective,
    requiredOutputs,
    actionItems,
    completionConditions,
    verification,
    allowedSideEffects,
    budget: args.budget,
    approval,
  };
};

// ---------------------------------------------------------------------------
// renderContractForPrompt (Phase 4 PR 3)
// ---------------------------------------------------------------------------

/**
 * Render an {@link ExecutionContract} as a prompt segment body.
 *
 * Used by `PromptAssembler` to inject the contract into the system prompt
 * as a `trusted` segment (the operator authored the underlying `role.md`
 * `contract:` block; the harness assembled the runtime fields). The agent
 * reads this block to learn what completion looks like and what side
 * effects it may exercise this wake.
 *
 * Format is brutally simple per ADR-0048 / "v1 DSLs brutally simple":
 * markdown sections with one bullet per item, no nesting, no DSL. The
 * agent's role narrative remains authoritative on *how* to do the work;
 * this block clarifies *what counts as done*.
 *
 * Sections are omitted when their list is empty (with the exception of
 * the objective line, which is always emitted). When the contract has
 * no obligations declared, the block degrades to a short
 * "no obligations declared" notice rather than a wall of empty sections.
 */
export const renderContractForPrompt = (contract: ExecutionContract): string => {
  const lines: string[] = [];
  lines.push("# Execution Contract");
  lines.push("");
  lines.push("You must satisfy this contract to mark this wake productive.");
  lines.push("");
  lines.push(`**Objective:** ${contract.objective}`);

  const hasObligation =
    contract.completionConditions.length > 0 ||
    contract.requiredOutputs.length > 0 ||
    contract.verification.length > 0;

  if (!hasObligation) {
    lines.push("");
    lines.push(
      "_No explicit obligations declared in `role.md` `contract:` block. " +
        "Follow your role narrative; the validator will fall back to artifact-presence heuristics._",
    );
  }

  if (contract.completionConditions.length > 0) {
    lines.push("");
    lines.push("## Completion conditions");
    lines.push("");
    lines.push("This wake is productive when ALL of these conditions hold:");
    lines.push("");
    for (const cond of contract.completionConditions) {
      lines.push(`- ${cond.description}`);
    }
  }

  if (contract.requiredOutputs.length > 0) {
    lines.push("");
    lines.push("## Required outputs");
    lines.push("");
    lines.push(
      "Produce at least one artifact for each obligation. " +
        "When an obligation lists multiple paths, any one of them satisfies it. " +
        "Globs accepted (e.g. `drafts/**/*.md`):",
    );
    lines.push("");
    for (const out of contract.requiredOutputs) {
      let pathPart = "";
      if (out.paths !== undefined && out.paths.length > 0) {
        pathPart = ` (any of: ${out.paths.map((p) => `\`${p}\``).join(", ")})`;
      } else if (out.path !== undefined) {
        pathPart = ` \`${out.path}\``;
      }
      lines.push(`- **${out.kind}**${pathPart} — ${out.description}`);
    }
  }

  if (contract.verification.length > 0) {
    lines.push("");
    lines.push("## Verification required");
    lines.push("");
    lines.push("These steps must succeed before the wake counts as productive:");
    lines.push("");
    for (const step of contract.verification) {
      const requiredTag = step.required ? " (required)" : " (advisory)";
      lines.push(`- ${step.description}${requiredTag}`);
    }
  }

  lines.push("");
  lines.push("## Permitted side effects");
  lines.push("");
  const sideEffectList = contract.allowedSideEffects.join(", ");
  lines.push(
    `You may exercise tools whose permission is one of: \`${sideEffectList}\`. ` +
      "Tools requiring permissions outside this set will be refused at the tool layer.",
  );

  if (contract.approval.mode !== "none") {
    lines.push("");
    lines.push("## Source approval");
    lines.push("");
    const reason = contract.approval.reason ?? "Source approval is required for this wake's scope.";
    lines.push(`**${contract.approval.mode}** — ${reason}`);
    lines.push("");
    lines.push(
      "If an action would invoke an approval-gated capability, file the request as a " +
        "structured action item rather than executing it; the harness will pause for Source.",
    );
  }

  return lines.join("\n");
};
