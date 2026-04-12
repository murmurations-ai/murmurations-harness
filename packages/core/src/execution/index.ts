import type { WakeCostRecord } from "../cost/record.js";

/**
 * Agent execution — the pluggable boundary between the harness daemon and
 * whatever actually runs an agent session.
 *
 * Closes carry-forward {@link https://github.com/murmurations-ai/murmurations-harness/issues/3 | #3}
 * ("AgentExecutor interface explicit"). Owned by TypeScript / Runtime
 * Agent (#24). Must support, without modification, at least two concrete
 * backends before v0.1 ships:
 *
 *   1. The default `SubprocessExecutor` — forks a child process per wake
 *      (Phase 1A deliverable A3).
 *   2. A stub `InProcessExecutor` — runs the agent's wake function in-process
 *      to validate the interface is actually pluggable and not post-hoc
 *      documentation of the subprocess implementation.
 *
 * Reference: MURMURATION-HARNESS-SPEC.md §4.1 (components table),
 * §5 (identity model), §7 (wake loop), §10 (model tiers).
 *
 * @packageDocumentation
 */

// ---------------------------------------------------------------------------
// Branded primitives
// ---------------------------------------------------------------------------

/**
 * Identifier for an agent (e.g. `"01-research"`, `"my-agent"`).
 *
 * Branded object rather than a bare string so callers cannot cross-wire
 * agent ids with arbitrary strings at the type level. Construct via
 * {@link makeAgentId}.
 */
export interface AgentId {
  readonly kind: "agent-id";
  readonly value: string;
}

/**
 * Construct an {@link AgentId} from the string form used in frontmatter
 * (`agent_id:` in `role.md`).
 */
export const makeAgentId = (value: string): AgentId => ({
  kind: "agent-id",
  value,
});

/**
 * Identifier for a group (e.g. `"content"`), matching
 * `group_id:` in `governance/groups/<name>.md` frontmatter.
 */
export interface GroupId {
  readonly kind: "group-id";
  readonly value: string;
}

/** Construct a {@link GroupId} from its string form. */
export const makeGroupId = (value: string): GroupId => ({
  kind: "group-id",
  value,
});

/**
 * Opaque identifier for a single wake attempt. Minted by the harness
 * scheduler before `spawn()` is called and threaded through every log,
 * signal, artifact, and governance event attributable to this wake.
 */
export interface WakeId {
  readonly kind: "wake-id";
  readonly value: string;
}

/** Construct a {@link WakeId} from its string form. */
export const makeWakeId = (value: string): WakeId => ({
  kind: "wake-id",
  value,
});

// ---------------------------------------------------------------------------
// Identity chain (spec §5)
// ---------------------------------------------------------------------------

/**
 * A single layer of the agent identity chain. Layers are materialized
 * documents — the executor receives the *resolved* text, not a path to
 * read, so executors running in a sandbox do not need filesystem access
 * to the governance tree.
 *
 * The four layer kinds match spec §5.1:
 *
 *   `murmuration_soul` → `agent_soul` → `agent_role` → `group_context`
 *
 * `group_context` may appear zero or more times (spec §6: agents can
 * belong to multiple groups). All other kinds appear exactly once and
 * in the order shown.
 */
export type IdentityLayer =
  | {
      readonly kind: "murmuration-soul";
      /** Rendered contents of `murmuration/soul.md`. */
      readonly content: string;
      /** Path in the repo the content was loaded from, for provenance. */
      readonly sourcePath: string;
    }
  | {
      readonly kind: "agent-soul";
      readonly agentId: AgentId;
      /** Rendered contents of `agents/NN-name/soul.md`. */
      readonly content: string;
      readonly sourcePath: string;
    }
  | {
      readonly kind: "agent-role";
      readonly agentId: AgentId;
      /**
       * Narrative body of `agents/NN-name/role.md` with YAML frontmatter
       * stripped (spec §7.1 step 3). The parsed frontmatter is delivered
       * separately as {@link AgentRoleFrontmatter}.
       */
      readonly content: string;
      readonly sourcePath: string;
    }
  | {
      readonly kind: "group-context";
      readonly groupId: GroupId;
      /** Rendered contents of `governance/groups/<group>.md`. */
      readonly content: string;
      readonly sourcePath: string;
    };

/**
 * Parsed operational frontmatter from `role.md`. Mirrors spec §5.3.
 * Kept loosely typed at this layer — the harness frontmatter validator
 * owns the strict schema; this is the handoff shape the executor sees.
 */
export interface AgentRoleFrontmatter {
  readonly agentId: AgentId;
  readonly name: string;
  readonly modelTier: ModelTier;
  readonly groupMemberships: readonly GroupId[];
}

/**
 * The full ordered identity chain handed to an executor on spawn. The
 * harness enforces that exactly one `murmuration-soul`, one `agent-soul`,
 * and one `agent-role` layer are present; `group-context` entries match
 * `frontmatter.groupMemberships` 1:1.
 */
export interface IdentityChain {
  readonly agentId: AgentId;
  readonly layers: readonly IdentityLayer[];
  readonly frontmatter: AgentRoleFrontmatter;
}

// ---------------------------------------------------------------------------
// Model tiers (spec §10)
// ---------------------------------------------------------------------------

/**
 * Task-class tier the agent is pinned to. Mapping from tier to concrete
 * model lives in `murmuration/models.yaml` and is resolved by the harness
 * before `spawn()` is called — the executor receives both the tier and
 * the resolved model selection so it does not need to re-read the catalog.
 *
 * Spec §10.1.
 */
export type ModelTier = "fast" | "balanced" | "deep";

/**
 * Concrete model selection resolved from a tier against
 * `murmuration/models.yaml`. Passed to the executor so the subprocess
 * does not need its own catalog parser.
 */
export interface ResolvedModel {
  readonly tier: ModelTier;
  readonly provider: string;
  readonly model: string;
  readonly maxTokens: number;
}

// ---------------------------------------------------------------------------
// Signal bundle (spec §7.1 step 2)
// ---------------------------------------------------------------------------

/**
 * Why the scheduler fired this wake. Discriminated so downstream event
 * handlers and loggers can reason about the trigger without string
 * parsing. Spec §7.1.
 */
export type WakeReason =
  | { readonly kind: "scheduled"; readonly cronExpression: string }
  | { readonly kind: "event"; readonly eventType: string; readonly eventId: string }
  | { readonly kind: "manual"; readonly invokedBy: string; readonly note?: string };

/**
 * Wake mode — determines what the agent should focus on during this wake.
 *
 * - `individual`: standard wake — process signals, act on action items, produce artifacts
 * - `group-member`: participating in a group meeting — contribute perspective, don't execute
 * - `group-facilitator`: facilitating a group meeting — synthesize, produce action list
 *
 * Agents in `group-member` or `group-facilitator` mode should NOT execute
 * action items — they are contributing to a group discussion, not doing individual work.
 */
export type WakeMode = "individual" | "group-member" | "group-facilitator";

/**
 * Trust level tag for a signal, per carry-forward
 * {@link https://github.com/murmurations-ai/murmurations-harness/issues/4 | #4}
 * (Security Agent #25). The Security Agent owns the authoritative
 * taxonomy; this is a placeholder stable enough to thread through
 * the executor interface so adding real enforcement later is a
 * semver-minor change, not a breaking one.
 *
 * @see https://github.com/murmurations-ai/murmurations-harness/issues/4
 */
export type SignalTrustLevel =
  | "trusted"
  | "semi-trusted"
  | "untrusted"
  // TODO(#4): Security Agent #25 owns the authoritative taxonomy. Additional
  // trust levels (e.g. "attested", "quarantined") may be added as a
  // semver-minor change.
  | "unknown";

/** Base fields every signal carries. */
interface SignalBase {
  readonly id: string;
  readonly trust: SignalTrustLevel;
  readonly fetchedAt: Date;
}

/**
 * A single signal in the bundle. The well-known variants have typed
 * fields; the `custom` variant carries an opaque `data` payload so
 * operators can define signal sources the harness doesn't ship
 * built-in support for (e.g. `pr-review`, `ci-failure`,
 * `slack-message`). Executors must not interpret signal contents —
 * the agent does that.
 */
export type Signal =
  | (SignalBase & {
      readonly kind: "github-issue";
      readonly number: number;
      readonly title: string;
      readonly url: string;
      readonly labels: readonly string[];
      readonly excerpt: string;
    })
  | (SignalBase & {
      readonly kind: "pipeline-item";
      readonly stage: string;
      readonly issueNumber: number;
      readonly artifactPath: string;
      readonly ageHours: number;
    })
  | (SignalBase & {
      readonly kind: "inbox-message";
      readonly fromAgent: AgentId;
      readonly path: string;
      readonly excerpt: string;
    })
  | (SignalBase & {
      readonly kind: "private-note";
      readonly path: string;
      readonly summary: string;
    })
  | (SignalBase & {
      readonly kind: "governance-round";
      readonly roundId: string;
      readonly eventType: string;
      readonly affectsAgent: boolean;
      readonly url: string;
    })
  | (SignalBase & {
      readonly kind: "stall-alert";
      readonly subjectIssue: number;
      readonly stage: string;
      readonly stalledForHours: number;
    })
  | (SignalBase & {
      /** Operator-defined signal source. The `sourceId` names the custom
       *  source (e.g. `"pr-review"`, `"slack-message"`). The `data`
       *  payload is opaque to the harness — the agent's runner interprets
       *  it based on `sourceId`. */
      readonly kind: "custom";
      readonly sourceId: string;
      readonly data: unknown;
    });

/**
 * The full bundle handed to the agent on wake. Assembled by the
 * Signal Aggregator (core component, not pluggable) and passed through
 * the executor verbatim. Spec §7.1 step 2.
 */
export interface SignalBundle {
  readonly wakeId: WakeId;
  readonly assembledAt: Date;
  readonly signals: readonly Signal[];
  /**
   * Action items assigned to this agent (subset of signals, filtered by
   * `assigned:<agentId>` + `action-item` labels). Surfaced prominently
   * in the agent's prompt — these take priority over default role behavior
   * unless the agent is blocked by upstream work, governance, or Source.
   *
   * This is harness-level behavior, not governance-model-specific.
   */
  readonly actionItems: readonly Signal[];
  /**
   * Non-fatal warnings from the aggregator (e.g. rate-limited GitHub
   * queries that returned partial results). Surfaces in the activity feed
   * and gives the agent a chance to reason about signal incompleteness.
   */
  readonly warnings: readonly string[];
}

// ---------------------------------------------------------------------------
// Cost budget (carry-forward #5 — Performance Agent #27)
// ---------------------------------------------------------------------------

/**
 * Pre-wake cost ceiling the executor must honor. Mirrored on the way
 * out by {@link CostActuals}. Per carry-forward
 * {@link https://github.com/murmurations-ai/murmurations-harness/issues/5 | #5}
 * (Performance / Observability Agent #27 owns the schema).
 *
 * The executor is responsible for enforcing `maxWallClockMs` (hard kill).
 * Token ceilings are advisory at the executor layer — the LLM client
 * enforces them. If the LLM client exceeds them, the executor must still
 * report the actuals truthfully.
 */
export interface CostBudget {
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxWallClockMs: number;
  readonly model: ResolvedModel;
  /**
   * Currency-neutral ceiling in fractional cost units (e.g. USD micros).
   * The harness computes this from tier + token ceilings before spawn;
   * the executor does not price tokens itself.
   */
  readonly maxCostMicros: number;
}

/**
 * Actual resource consumption of a completed wake. Reported in
 * {@link AgentResult}. Truthfulness is required even when the wake failed
 * — the harness pays for tokens whether or not the wake succeeded.
 */
export interface CostActuals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly wallClockMs: number;
  readonly costMicros: number;
  /**
   * Number of times the executor observed a budget ceiling being
   * exceeded (token or wall-clock). Non-zero implies degraded operation
   * and is a signal to Performance #27.
   */
  readonly budgetOverrunEvents: number;
}

// ---------------------------------------------------------------------------
// Spawn context (what the executor receives)
// ---------------------------------------------------------------------------

/**
 * Everything the executor needs to run one wake. Assembled by the
 * scheduler + signal aggregator + cost manager before `spawn()` is
 * called. Read-only from the executor's perspective.
 *
 * Spec §7.1 (wake loop).
 */
export interface AgentSpawnContext {
  readonly wakeId: WakeId;
  readonly agentId: AgentId;
  readonly identity: IdentityChain;
  readonly signals: SignalBundle;
  readonly wakeReason: WakeReason;
  readonly wakeMode: WakeMode;
  readonly budget: CostBudget;
  /**
   * Free-form, stable-per-wake environment key/value pairs (e.g. feature
   * flags, debug switches). Executors MUST pass these through to the
   * spawned session but MUST NOT interpret them.
   */
  readonly environment: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Governance events emitted during a wake
// ---------------------------------------------------------------------------

/**
 * Governance events an agent can emit during a wake. Captured by the
 * executor from the agent's structured output and forwarded to the
 * {@link GovernancePlugin} after the wake completes.
 *
 * The `kind` is an open string — not a closed enum — so any governance
 * model can define its own event kinds (S3 uses `"tension"`,
 * `"proposal-opened"`, etc.; a command-and-control model might use
 * `"approval-requested"`, `"directive-issued"`). The executor MUST NOT
 * parse or validate the payload; the governance plugin does that.
 *
 * @see https://github.com/murmurations-ai/murmurations-harness/issues/2
 */
export interface EmittedGovernanceEvent {
  readonly kind: string;
  readonly payload: unknown;
  /** Agent that emitted this event. Populated by the executor. */
  readonly sourceAgentId?: AgentId;
  /** Target agent (if the event is addressed to a specific peer). */
  readonly targetAgentId?: AgentId;
}

// ---------------------------------------------------------------------------
// Wake actions — structured actions agents return for the harness to execute
// ---------------------------------------------------------------------------

/**
 * A structured action an agent wants the harness to execute against GitHub.
 * Returned alongside the wake summary. The executor validates each action
 * against the agent's write scopes (ADR-0017) before executing.
 *
 * This is the individual-wake equivalent of MeetingAction. Agents that
 * need to label issues, create action items, close completed work, or
 * post comments return these instead of making raw GitHub API calls.
 */
export interface WakeAction {
  readonly kind: "label-issue" | "create-issue" | "close-issue" | "comment-issue" | "commit-file";
  readonly issueNumber?: number;
  readonly label?: string;
  readonly removeLabel?: string;
  readonly title?: string;
  readonly body?: string;
  readonly labels?: readonly string[];
  readonly filePath?: string;
  readonly fileContent?: string;
}

/** Result of executing a single WakeAction. */
export interface WakeActionReceipt {
  readonly action: WakeAction;
  readonly success: boolean;
  readonly error?: string;
  readonly issueNumber?: number;
}

// ---------------------------------------------------------------------------
// Wake validation — post-wake check on whether the agent did real work
// ---------------------------------------------------------------------------

/**
 * Result of validating a completed wake. Produced by the daemon's
 * post-wake validation hook. Feeds into AgentStateStore metrics
 * and retrospective data.
 */
export interface WakeValidationResult {
  /** Did the agent produce meaningful output? */
  readonly productive: boolean;
  /** Number of artifacts produced (actions executed + outputs + governance events). */
  readonly artifactCount: number;
  /** Number of assigned action items the agent addressed (mentioned or acted on). */
  readonly actionItemsAddressed: number;
  /** Total action items that were assigned to the agent this wake. */
  readonly actionItemsAssigned: number;
  /** If not productive, why. */
  readonly reason?: string;
}

/**
 * Default validation: checks artifact count and action item coverage.
 * Used when no custom validator is configured.
 */
export const validateWake = (
  context: { actionItems: readonly Signal[] },
  result: { actions: readonly WakeAction[]; outputs: readonly AgentOutputArtifact[]; governanceEvents: readonly EmittedGovernanceEvent[]; wakeSummary: string },
  actionReceipts: readonly WakeActionReceipt[],
): WakeValidationResult => {
  const artifactCount = actionReceipts.filter((r) => r.success).length
    + result.outputs.length
    + (result.governanceEvents.length > 0 ? 1 : 0);

  const actionItemsAssigned = context.actionItems.length;
  let actionItemsAddressed = 0;

  if (actionItemsAssigned > 0) {
    // Check which action items were addressed — either by structured action
    // referencing the issue number, or by mention in the wake summary
    for (const item of context.actionItems) {
      if (item.kind !== "github-issue") continue;
      const issueNum = (item as unknown as { number: number }).number;
      const referenced =
        result.actions.some((a) => a.issueNumber === issueNum) ||
        actionReceipts.some((r) => r.action.issueNumber === issueNum) ||
        result.wakeSummary.includes(`#${String(issueNum)}`);
      if (referenced) actionItemsAddressed++;
    }
  }

  const productive = artifactCount > 0 || actionItemsAddressed > 0;
  const reason = productive
    ? undefined
    : actionItemsAssigned > 0
      ? `${String(actionItemsAssigned)} action items assigned but none addressed`
      : "wake completed but produced no artifacts";

  return { productive, artifactCount, actionItemsAddressed, actionItemsAssigned, reason };
};

const VALID_WAKE_ACTION_KINDS = new Set([
  "label-issue", "create-issue", "close-issue", "comment-issue", "commit-file",
]);

/**
 * Parse structured wake actions from LLM output. Same format as meeting
 * actions (```actions fenced JSON block), with the addition of "commit-file".
 * Returns empty array if no valid actions found (never throws).
 */
export const parseWakeActions = (text: string): WakeAction[] => {
  const fencedMatch = /```(?:actions|json)\s*\n(\[[\s\S]*?\])\s*\n```/.exec(text);
  if (!fencedMatch?.[1]) return [];
  try {
    const parsed: unknown = JSON.parse(fencedMatch[1]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidWakeAction);
  } catch {
    return [];
  }
};

const isValidWakeAction = (item: unknown): item is WakeAction => {
  if (typeof item !== "object" || item === null) return false;
  const obj = item as Record<string, unknown>;
  if (typeof obj.kind !== "string" || !VALID_WAKE_ACTION_KINDS.has(obj.kind)) return false;
  switch (obj.kind) {
    case "label-issue":
      return typeof obj.issueNumber === "number" && typeof obj.label === "string";
    case "create-issue":
      return typeof obj.title === "string";
    case "close-issue":
      return typeof obj.issueNumber === "number";
    case "comment-issue":
      return typeof obj.issueNumber === "number" && typeof obj.body === "string";
    case "commit-file":
      return typeof obj.filePath === "string" && typeof obj.fileContent === "string";
    default:
      return false;
  }
};

// ---------------------------------------------------------------------------
// Agent result (what the executor returns)
// ---------------------------------------------------------------------------

/**
 * A single non-governance output artifact produced by the wake
 * (pipeline state writes, private notes, inbox messages, files touched).
 * The executor reports these as metadata; the actual writes happen
 * in the agent's session against the repo, not through the executor.
 */
export interface AgentOutputArtifact {
  readonly kind:
    | "file-written"
    | "file-modified"
    | "file-deleted"
    | "github-comment"
    | "github-issue-opened"
    | "github-issue-labeled"
    | "inbox-message-sent";
  readonly description: string;
  readonly ref?: string;
}

/**
 * Why a wake terminated. Discriminated union so callers can pattern-match
 * on outcome rather than inspecting nullable error fields.
 *
 * `completed` — the agent ran to a normal end and wrote its wake summary.
 * `failed` — the agent encountered an error. `error` is populated.
 * `killed` — the executor killed the wake on request (`kill(handle)`).
 * `timed-out` — the executor killed the wake when `maxWallClockMs` elapsed.
 */
export type AgentOutcome =
  | { readonly kind: "completed" }
  | { readonly kind: "failed"; readonly error: ExecutorError }
  | { readonly kind: "killed"; readonly reason: string }
  | { readonly kind: "timed-out"; readonly budget: CostBudget };

/**
 * Result of a completed (or terminated) wake. Always returned — even on
 * failure — so the harness can record cost and partial artifacts. Only
 * catastrophic executor-level failures are surfaced as Promise rejections
 * from {@link AgentExecutor.waitForCompletion}; agent-level failures are
 * `outcome.kind === "failed"`.
 */
export interface AgentResult {
  readonly wakeId: WakeId;
  readonly agentId: AgentId;
  readonly outcome: AgentOutcome;
  readonly outputs: readonly AgentOutputArtifact[];
  readonly governanceEvents: readonly EmittedGovernanceEvent[];
  readonly cost: CostActuals;
  /**
   * Rich per-wake cost record (schema owned by Performance / Observability
   * Agent #27; closes carry-forward #5). Populated by executors that
   * construct a {@link import("../cost/index.js").WakeCostBuilder} —
   * the default {@link import("./subprocess.js").SubprocessExecutor}
   * does. Optional because the field is additive over the pre-1B-c
   * `AgentResult` shape; legacy consumers that only need summary
   * numbers keep reading {@link AgentResult.cost}.
   */
  readonly costRecord?: WakeCostRecord;
  /**
   * Agent-authored wake summary (spec §7.1 step 4). May be empty when the
   * wake failed before the summary was written.
   */
  readonly wakeSummary: string;
  /**
   * Structured actions the agent wants executed. Populated by the runner,
   * validated + executed by the daemon after the wake completes. Empty if
   * the agent didn't return any actions (legacy runners, failed wakes).
   */
  readonly actions: readonly WakeAction[];
  /** Execution receipts — one per action attempted. Empty until the daemon executes. */
  readonly actionReceipts: readonly WakeActionReceipt[];
  readonly startedAt: Date;
  readonly finishedAt: Date;
}

// ---------------------------------------------------------------------------
// Spawn handle
// ---------------------------------------------------------------------------

/**
 * Opaque handle to an in-flight wake. Callers must treat this as a
 * token — they pass it back to `waitForCompletion` and `kill` but do
 * not inspect its internals. The `__executor` brand exists solely to
 * prevent cross-wiring handles between two different executor instances
 * at the type level.
 */
export interface AgentSpawnHandle {
  readonly kind: "agent-spawn-handle";
  readonly wakeId: WakeId;
  readonly agentId: AgentId;
  readonly startedAt: Date;
  /**
   * Internal brand identifying which executor minted this handle.
   * Executors set this to their own `capabilities().id`. Do not read
   * in caller code.
   */
  readonly __executor: string;
}

// ---------------------------------------------------------------------------
// Executor capabilities
// ---------------------------------------------------------------------------

/**
 * Declarative description of what a given executor implementation can
 * and cannot do. The harness uses this to route wakes (e.g. a wake that
 * requires subprocess isolation cannot be run on an in-process executor).
 *
 * Adding a capability field is a semver-minor change *as long as* it
 * defaults to `false` for existing implementations. Removing one is a
 * breaking change.
 */
export interface ExecutorCapabilities {
  /**
   * Stable, unique identifier for this executor implementation
   * (e.g. `"subprocess"`, `"in-process-stub"`). Used as the brand on
   * {@link AgentSpawnHandle.__executor} so handles cannot be crossed
   * between executor instances.
   */
  readonly id: string;
  readonly displayName: string;
  readonly version: string;

  /** Agent runs in a separate OS process with isolated memory. */
  readonly supportsSubprocessIsolation: boolean;
  /** Executor runs the agent in-process (same memory as the daemon). */
  readonly supportsInProcess: boolean;
  /** Executor can enforce CPU/memory/FD ceilings on the wake. */
  readonly supportsResourceLimits: boolean;
  /** Executor honors `kill(handle)` synchronously (best-effort). */
  readonly supportsKill: boolean;
  /** Executor captures stdout/stderr and emits them as wake logs. */
  readonly capturesStdio: boolean;
  /** Executor can run multiple wakes concurrently. */
  readonly supportsConcurrentWakes: boolean;
  /** Upper bound on concurrent wakes, if bounded. */
  readonly maxConcurrentWakes: number | "unbounded";
  /** Model tiers this executor supports. Empty = no tier restriction. */
  readonly supportedModelTiers: readonly ModelTier[];
}

// ---------------------------------------------------------------------------
// Error taxonomy
// ---------------------------------------------------------------------------

/**
 * Discriminant for the executor error taxonomy. Exists so callers can
 * pattern-match on `error.code` without `instanceof` chains.
 */
export type ExecutorErrorCode =
  | "spawn-failed"
  | "handle-unknown"
  | "handle-expired"
  | "timeout"
  | "killed"
  | "budget-exceeded"
  | "capability-unsupported"
  | "identity-chain-invalid"
  | "internal";

/**
 * Base class for errors thrown by an {@link AgentExecutor} implementation
 * or returned as part of a `failed` {@link AgentResult}.
 *
 * Every subclass sets a stable `code` for pattern matching. Callers
 * should switch on `code`, not on `instanceof`, because subclasses may
 * be re-thrown across worker boundaries where prototypes are lost.
 *
 * Rejection contract — the following methods on {@link AgentExecutor}
 * may reject with an `ExecutorError`:
 *
 * - `spawn` → {@link SpawnError}, {@link CapabilityUnsupportedError},
 *   {@link IdentityChainInvalidError}
 * - `waitForCompletion` → {@link HandleUnknownError} only. Agent-level
 *   failures (errors, timeouts, kills) surface as a resolved
 *   {@link AgentResult} with the matching `outcome.kind`. This is
 *   the errors-as-values pathway.
 * - `kill` → {@link HandleUnknownError} only. Killing an already-finished
 *   wake resolves successfully (idempotent).
 * - `capabilities` → never rejects.
 */
export abstract class ExecutorError extends Error {
  public abstract readonly code: ExecutorErrorCode;
  public readonly wakeId: WakeId | undefined;
  public override readonly cause: unknown;

  protected constructor(
    message: string,
    options: { readonly wakeId?: WakeId; readonly cause?: unknown } = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.wakeId = options.wakeId;
    this.cause = options.cause;
  }
}

/** The executor could not start the wake at all (fork failed, binary missing, etc). */
export class SpawnError extends ExecutorError {
  public readonly code = "spawn-failed" as const;
  public constructor(
    message: string,
    options: { readonly wakeId?: WakeId; readonly cause?: unknown } = {},
  ) {
    super(message, options);
  }
}

/**
 * `waitForCompletion` or `kill` was called with a handle this executor
 * does not recognize (wrong executor, or handle already reaped).
 */
export class HandleUnknownError extends ExecutorError {
  public readonly code = "handle-unknown" as const;
  public constructor(
    message: string,
    options: { readonly wakeId?: WakeId; readonly cause?: unknown } = {},
  ) {
    super(message, options);
  }
}

/**
 * The wake exceeded its `maxWallClockMs` budget and the executor killed
 * it. Surfaces as `outcome.kind === "timed-out"` in {@link AgentResult};
 * the error is also attached to the outcome for introspection.
 */
export class TimeoutError extends ExecutorError {
  public readonly code = "timeout" as const;
  public readonly budget: CostBudget;
  public constructor(
    message: string,
    options: {
      readonly wakeId?: WakeId;
      readonly cause?: unknown;
      readonly budget: CostBudget;
    },
  ) {
    super(message, options);
    this.budget = options.budget;
  }
}

/**
 * The wake was killed via `kill(handle)`. Surfaces as
 * `outcome.kind === "killed"` in {@link AgentResult}.
 */
export class KilledError extends ExecutorError {
  public readonly code = "killed" as const;
  public readonly reason: string;
  public constructor(
    message: string,
    options: {
      readonly wakeId?: WakeId;
      readonly cause?: unknown;
      readonly reason: string;
    },
  ) {
    super(message, options);
    this.reason = options.reason;
  }
}

/**
 * The wake tripped a cost budget ceiling (token count or cost micros)
 * that the executor was asked to enforce.
 */
export class BudgetExceededError extends ExecutorError {
  public readonly code = "budget-exceeded" as const;
  public readonly budget: CostBudget;
  public readonly actuals: CostActuals;
  public constructor(
    message: string,
    options: {
      readonly wakeId?: WakeId;
      readonly cause?: unknown;
      readonly budget: CostBudget;
      readonly actuals: CostActuals;
    },
  ) {
    super(message, options);
    this.budget = options.budget;
    this.actuals = options.actuals;
  }
}

/**
 * The caller asked for a capability this executor does not advertise
 * in {@link ExecutorCapabilities} (e.g. requested subprocess isolation
 * from an in-process executor).
 */
export class CapabilityUnsupportedError extends ExecutorError {
  public readonly code = "capability-unsupported" as const;
  public readonly capability: string;
  public constructor(
    message: string,
    options: {
      readonly wakeId?: WakeId;
      readonly cause?: unknown;
      readonly capability: string;
    },
  ) {
    super(message, options);
    this.capability = options.capability;
  }
}

/**
 * The {@link IdentityChain} passed to `spawn` was structurally invalid
 * (missing a required layer, duplicate layers, frontmatter mismatch).
 * This is a programmer error in the harness; executors should throw
 * loudly so the bug is caught before the subprocess is forked.
 */
export class IdentityChainInvalidError extends ExecutorError {
  public readonly code = "identity-chain-invalid" as const;
  public readonly reason: string;
  public constructor(
    message: string,
    options: {
      readonly wakeId?: WakeId;
      readonly cause?: unknown;
      readonly reason: string;
    },
  ) {
    super(message, options);
    this.reason = options.reason;
  }
}

/**
 * Escape hatch for executor-internal failures that do not map to any
 * other error in the taxonomy. If you find yourself reaching for this
 * often, the taxonomy is wrong — file an issue.
 */
export class InternalExecutorError extends ExecutorError {
  public readonly code = "internal" as const;
  public constructor(
    message: string,
    options: { readonly wakeId?: WakeId; readonly cause?: unknown } = {},
  ) {
    super(message, options);
  }
}

// ---------------------------------------------------------------------------
// The AgentExecutor interface
// ---------------------------------------------------------------------------

/**
 * The pluggable boundary between the harness daemon and the thing that
 * actually runs one agent wake.
 *
 * Implementations include (see spec §4.1):
 *
 *   - `SubprocessExecutor` — default. Forks a child Node/Claude process
 *     per wake. Implements the full capability set.
 *   - `InProcessExecutor` — stub. Runs the agent's wake function in the
 *     daemon's own process. Validates pluggability, used for tests.
 *   - (future) `ContainerExecutor`, `RemoteExecutor`.
 *
 * ## Lifecycle
 *
 * ```text
 *   spawn(ctx) ──► handle ──► waitForCompletion(handle) ──► result
 *                      │
 *                      └────► kill(handle) ──► result { outcome: "killed" }
 * ```
 *
 * An executor instance is long-lived (owned by the daemon) and may
 * service many wakes, sequentially or concurrently per
 * {@link ExecutorCapabilities.supportsConcurrentWakes}.
 *
 * ## Errors-as-values boundary
 *
 * Agent-level failure (the agent ran but errored, was killed, or timed
 * out) is reported via `outcome.kind` on {@link AgentResult}, not via
 * Promise rejection. `waitForCompletion` resolves successfully in all
 * those cases. Only catastrophic executor faults (unknown handle, the
 * executor itself is broken) reject. This keeps the happy-path caller
 * free of try/catch for expected failure modes while still allowing
 * programmer errors to surface.
 *
 * See the rejection contract on {@link ExecutorError} for the complete
 * list of which methods can reject with what.
 */
export interface AgentExecutor {
  /**
   * Start a new wake. Returns an opaque {@link AgentSpawnHandle} that
   * must be passed to {@link waitForCompletion} or {@link kill}.
   *
   * Rejects with {@link SpawnError} on fork/start failure,
   * {@link CapabilityUnsupportedError} if the context asks for something
   * this executor cannot provide, or {@link IdentityChainInvalidError}
   * if the identity chain is structurally broken.
   *
   * Must not block on agent execution — this is a start-and-return
   * operation. The returned Promise resolves as soon as the wake has
   * been dispatched.
   */
  spawn(context: AgentSpawnContext): Promise<AgentSpawnHandle>;

  /**
   * Wait for a wake to reach a terminal state and return the full
   * {@link AgentResult}. Always resolves when the handle is known;
   * failure modes surface on `result.outcome.kind`. Rejects only with
   * {@link HandleUnknownError}.
   *
   * Calling `waitForCompletion` twice on the same handle is permitted
   * and idempotent — both calls observe the same {@link AgentResult}.
   */
  waitForCompletion(handle: AgentSpawnHandle): Promise<AgentResult>;

  /**
   * Request termination of an in-flight wake. Idempotent and safe to
   * call after the wake has already finished (resolves cleanly). The
   * resulting wake outcome will be `killed` (or `completed` / `failed`
   * if the wake raced the kill).
   *
   * Rejects only with {@link HandleUnknownError}.
   */
  kill(handle: AgentSpawnHandle, reason: string): Promise<void>;

  /**
   * Describe what this executor can do. Must return the same value on
   * every call — capabilities are a property of the implementation, not
   * of any particular wake.
   */
  capabilities(): ExecutorCapabilities;
}

// ---------------------------------------------------------------------------
// Convenience type guards
// ---------------------------------------------------------------------------

/** Narrow an {@link AgentResult} to the `completed` outcome. */
export const isCompleted = (
  result: AgentResult,
): result is AgentResult & { readonly outcome: { readonly kind: "completed" } } =>
  result.outcome.kind === "completed";

/** Narrow an {@link AgentResult} to the `failed` outcome. */
export const isFailed = (
  result: AgentResult,
): result is AgentResult & {
  readonly outcome: { readonly kind: "failed"; readonly error: ExecutorError };
} => result.outcome.kind === "failed";

/** Narrow an {@link AgentResult} to the `timed-out` outcome. */
export const isTimedOut = (
  result: AgentResult,
): result is AgentResult & {
  readonly outcome: { readonly kind: "timed-out"; readonly budget: CostBudget };
} => result.outcome.kind === "timed-out";

/** Narrow an {@link AgentResult} to the `killed` outcome. */
export const isKilled = (
  result: AgentResult,
): result is AgentResult & {
  readonly outcome: { readonly kind: "killed"; readonly reason: string };
} => result.outcome.kind === "killed";
