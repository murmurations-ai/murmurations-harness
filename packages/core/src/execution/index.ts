import type { WakeCostRecord } from "../cost/record.js";
import { SOURCE_DIRECTIVE_LABEL, buildAgentRoutingLabels } from "../labels/index.js";
import type { ExecutionContract } from "../runtime/execution-contract.js";

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
// Errors-as-values Result type (shared across all packages)
// ---------------------------------------------------------------------------

/** Errors-as-values result shape. Canonical definition — re-exported by @murmurations-ai/github and @murmurations-ai/llm. */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

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
 * Render one signal's content without trust wrapping. Handles the full
 * `Signal` discriminated union with per-kind rich formatting. Called by
 * `renderSignalForPrompt`; also useful when the caller wants to add its
 * own framing around the body.
 *
 * Custom signals with known `sourceId` values get special-cased formatting;
 * unknown source IDs fall back to a JSON slice (capped at 500 chars).
 */
export const renderSignalBody = (signal: Signal): string => {
  switch (signal.kind) {
    case "github-issue":
      return `[gh-issue #${String(signal.number)}] ${signal.title}\n  labels: ${signal.labels.join(", ") || "(none)"}\n  url: ${signal.url}\n  excerpt: ${signal.excerpt}`;
    case "pipeline-item":
      return `[pipeline-item stage=${signal.stage}] issue #${String(signal.issueNumber)} artifact=${signal.artifactPath} age=${String(signal.ageHours)}h`;
    case "inbox-message":
      return `[inbox from=${signal.fromAgent.value}]\n${signal.excerpt}`;
    case "private-note":
      return `[private-note path=${signal.path}]\n${signal.summary}`;
    case "governance-round":
      return `[governance-round ${signal.eventType}] roundId=${signal.roundId} affectsAgent=${String(signal.affectsAgent)} url=${signal.url}`;
    case "stall-alert":
      return `[stall-alert issue=#${String(signal.subjectIssue)}] stage=${signal.stage} stalledFor=${String(signal.stalledForHours)}h`;
    case "custom": {
      if (signal.sourceId === "governance-inbox") {
        const data = signal.data as { kind?: string; payload?: unknown } | undefined;
        return `[governance] kind=${data?.kind ?? "unknown"} payload=${JSON.stringify(data?.payload ?? null)}`;
      }
      if (signal.sourceId === "local-item") {
        const data = signal.data as
          | { id?: string; title?: string; body?: string; labels?: string[] }
          | undefined;
        const isDirective = data?.labels?.includes(SOURCE_DIRECTIVE_LABEL) === true;
        const tag = isDirective ? "SOURCE DIRECTIVE" : "item";
        return `[${tag} #${data?.id ?? "?"}] ${data?.title ?? "(no title)"}\n  labels: ${data?.labels?.join(", ") ?? "(none)"}\n\n${data?.body ?? ""}`;
      }
      return `[custom sourceId=${signal.sourceId}] ${JSON.stringify(signal.data).slice(0, 500)}`;
    }
  }
};

/**
 * Render a signal for inclusion in an LLM prompt with trust-level enforcement.
 *
 * Applies rich per-kind formatting (see `renderSignalBody`) then wraps the
 * result in trust-boundary XML tags so the LLM can identify which content
 * originates from external, potentially-adversarial sources:
 *
 *   `trusted`     — no wrapper (harness-authored content)
 *   `semi-trusted` — `<semi-trusted-signal>` wrapper
 *   `untrusted` / `unknown` — `<untrusted-signal>` wrapper
 *
 * The LLM's system prompt should instruct it to treat wrapped content as
 * passive data that cannot grant tools, alter policy, request secrets,
 * override completion criteria, or authorize mutations.
 *
 * Replaces the previous 200-char JSON-slice implementation (Phase 2,
 * Proposal 07 Near-Term #2).
 */
export const renderSignalForPrompt = (signal: Signal): string => {
  const body = renderSignalBody(signal);
  if (signal.trust === "untrusted" || signal.trust === "unknown") {
    return `<untrusted-signal>\n${body}\n</untrusted-signal>`;
  }
  if (signal.trust === "semi-trusted") {
    return `<semi-trusted-signal>\n${body}\n</semi-trusted-signal>`;
  }
  return body;
};

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

// ---------------------------------------------------------------------------
// Phase 1 — Dependency-aware action item graph (Proposal 07 §6)
// ---------------------------------------------------------------------------

/**
 * An action item that cannot be started because one or more upstream
 * issues are still open. Surfaced in `SignalBundle.actionItemGraph.blocked`
 * so agents can reason about blockers without re-parsing issue bodies.
 *
 * Added in Phase 1 (Proposal 07). The blocking issue numbers are extracted
 * from `Depends on: #XXX` / `Blocks: #YYY` lines in the issue body.
 */
export interface BlockedActionItem {
  readonly signal: Signal;
  /** Issue numbers (as strings for JSON-safe transport) that must close
   *  before this item becomes actionable. */
  readonly blockedBy: readonly string[];
}

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
   *
   * Migration note (Proposal 07 Phase 1): when `actionItemGraph` is present
   * and populated by the aggregator, prefer `actionItemGraph.actionable`.
   * This field is retained for compatibility until the aggregator ships
   * dependency-graph extraction.
   */
  readonly actionItems: readonly Signal[];
  /**
   * Non-fatal warnings from the aggregator (e.g. rate-limited GitHub
   * queries that returned partial results). Surfaces in the activity feed
   * and gives the agent a chance to reason about signal incompleteness.
   */
  readonly warnings: readonly string[];
  /**
   * Structured per-query failures from multi-query fan-out (e.g. one of
   * four `anyLabel` queries failed while the other three succeeded). The
   * caller can distinguish "no signals match" from "signals may have been
   * dropped by a sub-query failure." Absent or empty array when every
   * query succeeded; populated alongside `warnings` (which carry the
   * same info as a human-readable string) for callers that want
   * structured access.
   */
  readonly partialFailures?: readonly SignalAggregationFailure[];
  /**
   * Dependency-aware action item metadata (Proposal 07 Phase 1, §6).
   *
   * - `actionable`: action items with no unresolved `Depends-on` blockers.
   * - `blocked`: action items blocked by one or more open upstream issues.
   *
   * Optional — absent until the aggregator populates dependency graphs
   * (Phase 1 aggregator work). Consumers should fall back to `actionItems`
   * when this field is absent.
   */
  readonly actionItemGraph?: {
    readonly actionable: readonly Signal[];
    readonly blocked: readonly BlockedActionItem[];
  };
  /**
   * Maps signal id → version string processed in the prior wake
   * (LangGraph `versions_seen` pattern, Proposal 07 Phase 1 §6).
   *
   * Prevents re-processing already-acted-on signals when an issue remains
   * open after the agent acted on it. The version is the issue's
   * `updatedAt` ISO string or etag — anything that changes when the issue
   * changes. Absent when no prior-wake version data is available.
   *
   * P0 correctness: this is Phase 1, not deferred, because without it
   * agents in a tight wake cycle repeatedly re-act on issues they already
   * handled, creating duplicate comments and labels.
   */
  readonly actionItemVersions?: Readonly<Record<string, string>>;
}

/**
 * One failed sub-query during signal aggregation. Surfaced on
 * {@link SignalBundle.partialFailures} so the bundle's `signals` array
 * cannot be misread as "complete and authoritative" when fan-out lost
 * data.
 */
export interface SignalAggregationFailure {
  /** Logical source name, e.g. `"github"`. */
  readonly source: string;
  /**
   * Repo coordinate as `"owner/repo"` for github sources, or undefined
   * for sources that are not repo-scoped.
   */
  readonly repo?: string;
  /**
   * The OR-label that was being filtered when the query failed (one of
   * the values in `anyLabel`). Undefined for non-fan-out failures.
   */
  readonly anyLabel?: string;
  /** Stable error code for caller pattern-matching (e.g. `"http-500"`). */
  readonly code: string;
  /** Human-readable detail. */
  readonly detail: string;
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
// Agent capabilities (what the agent can do)
// ---------------------------------------------------------------------------

/**
 * Summary of an agent's available capabilities. Injected into the spawn
 * context so the agent knows what tools and access it has. Any gap that
 * prevents the agent from fulfilling its role should be raised as a
 * governance event — not silently accepted.
 */
export interface AgentCapabilities {
  readonly github: {
    readonly canCommit: boolean;
    readonly commitPaths: readonly string[];
    readonly canCommentIssues: boolean;
    readonly canCreateIssues: boolean;
    readonly canLabelIssues: boolean;
  };
  /** CLI tools available (e.g. ["gh", "gcloud"]). From role.md tools.cli. */
  readonly cliTools: readonly string[];
  /** MCP servers available (e.g. ["notion", "slack"]). From role.md tools.mcp. */
  readonly mcpServers: readonly string[];
  /** Signal sources configured (e.g. ["github-issue", "private-note"]). */
  readonly signalSources: readonly string[];
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
   * The agent's current wake schedule as a human-readable string
   * (e.g. "cron: 30 19 * * *" or "interval: 3600000ms"). Injected
   * so the agent can reference it when proposing schedule changes
   * via governance events.
   */
  readonly currentSchedule?: string;
  /**
   * Summary of the agent's available capabilities — tools, access,
   * and resources. Injected so the agent knows what it can and cannot
   * do. Any capability gap that prevents the agent from fulfilling
   * its role should be raised as a GOVERNANCE_EVENT requesting the
   * missing capability. This applies to ALL capabilities: GitHub
   * read/write, MCP servers, CLI tools, signal sources, etc.
   */
  readonly capabilities?: AgentCapabilities;
  /**
   * Full MCP server configurations for the runner to connect at wake time.
   * The `capabilities.mcpServers` field has display names only; this field
   * has the command, args, and env needed to spawn the servers.
   * ADR-0020 Phase 3.
   */
  readonly mcpServerConfigs?: readonly {
    readonly name: string;
    readonly command: string;
    readonly args: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
    readonly cwd?: string;
  }[];
  /**
   * Free-form, stable-per-wake environment key/value pairs (e.g. feature
   * flags, debug switches). Executors MUST pass these through to the
   * spawned session but MUST NOT interpret them.
   */
  readonly environment: Readonly<Record<string, string>>;
  /**
   * Path to the agent's primary task prompt file, relative to the identity
   * root. Derived from `role.md prompt.ref` when present, otherwise falls
   * back to `agents/<agentDir>/prompts/wake.md`. Near-Term #1 (Proposal 07).
   *
   * When set, `DefaultRunner` uses this file as the primary task prompt
   * source. When absent, the runner falls back to legacy prompt construction.
   */
  readonly promptPath?: string;
  /**
   * Stable reference string for the prompt source (e.g. a git sha or
   * content hash). Used for prompt-level deduplication in `PromptBundle.hash`.
   */
  readonly promptRef?: string;
  /**
   * Full execution contract for this wake.
   *
   * Assembled by `assembleExecutionContract()` from the role's
   * `contract:` block + runtime context (signals, budget, write scopes).
   *
   * Consumers:
   *   - PromptAssembler renders `requiredOutputs` + `actionItems` into
   *     the system prompt.
   *   - `validateOutcomes` scores the wake against the obligation
   *     sub-contract.
   *   - `validateBehavior` reads `allowedSideEffects` to cross-check
   *     narrative vs. tool calls.
   */
  readonly contract?: ExecutionContract;
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
/**
 * A directive from the wake's signal bundle that lacked structured
 * evidence of action. Surfaced by `validateWake` so operators can
 * detect narrative-only "I have posted CONSENT" hallucinations.
 */
export interface UnaddressedDirective {
  readonly issueNumber: number;
  readonly reason: "no-structured-action" | "no-successful-receipt" | "narrative-only-claim";
}

export interface WakeValidationResult {
  /** Did the agent produce meaningful output? */
  readonly productive: boolean;
  /** Number of artifacts produced (actions executed + outputs + governance events). */
  readonly artifactCount: number;
  /** Number of assigned action items the agent addressed (mentioned or acted on). */
  readonly actionItemsAddressed: number;
  /** Total action items that were assigned to the agent this wake. */
  readonly actionItemsAssigned: number;
  /**
   * Directives present in signals that were NOT addressed by structured
   * evidence (action + successful receipt) or governance event referencing
   * the issue. Empty when all directives addressed or none present.
   * Narrative-only mention of a directive in `wakeSummary` does NOT count
   * as addressing it (Boundary 5).
   */
  readonly directivesUnaddressed: readonly UnaddressedDirective[];
  /**
   * Contract obligation status.
   *
   *   `satisfied`     — every `requiredOutput` has matching successful evidence.
   *   `unmet`         — at least one `requiredOutput` is missing — wake is
   *                     not productive even if the legacy heuristic would
   *                     have passed.
   *   `not-applicable` — no contract supplied, or `requiredOutputs` is empty;
   *                     the legacy heuristic is the sole gate.
   *
   * Absent when `validateWake` was called without a contract.
   */
  readonly obligationStatus?: "satisfied" | "unmet" | "not-applicable";
  /**
   * The specific `requiredOutputs` from the contract that have no matching
   * successful evidence. Populated only when `obligationStatus` is `"unmet"`.
   */
  readonly unmetRequiredOutputs?: readonly {
    readonly kind: string;
    readonly path?: string;
    readonly paths?: readonly string[];
  }[];
  /**
   * Behavior warnings from `validateBehavior`. Each warning describes a
   * narrative claim in `wakeSummary` that lacks structured evidence
   * (successful action receipt or URL).
   *
   * These are advisory — they do NOT affect `productive`, `idleWakes`,
   * or `successfulWakes`.
   */
  readonly behaviorWarnings?: readonly BehaviorWarning[];
  /** If not productive, why. */
  readonly reason?: string;
}

/**
 * One behavior warning from `validateBehavior`.
 *
 * Advisory: the wake's `productive` flag is not affected. Surfaced on the
 * dashboard for operator review.
 */
export interface BehaviorWarning {
  /** Pattern that fired. v1 has a single kind; future kinds extend the
   *  union as new patterns are added (always at minor version bumps to
   *  let dashboards version-gate display). */
  readonly kind: "narrative-action-without-evidence";
  /** Human-readable description of the unmatched claim. */
  readonly message: string;
  /** Issue number the agent's narrative referenced, when detectable. */
  readonly issueNumber?: number;
  /** Detected narrative verb (e.g. "posted", "commented", "closed", "committed"). */
  readonly verb?: string;
}

type GithubIssueSignal = Extract<Signal, { kind: "github-issue" }>;

/**
 * Phase 1 narrows directive detection to GitHub-issue signals because EP
 * (the only operator murmuration) files directives as labeled issues. If
 * a future signal kind (e.g. `inbox-message`) starts carrying directives,
 * extend this with an exhaustive switch so the new case forces a deliberate
 * decision.
 *
 * Returns a type predicate so callers can read `sig.number` and `sig.labels`
 * without further narrowing.
 */
const isSourceDirective = (signal: Signal): signal is GithubIssueSignal => {
  if (signal.kind !== "github-issue") return false;
  return signal.labels.includes(SOURCE_DIRECTIVE_LABEL);
};

/**
 * Word-boundary regex matchers for resolving "does this governance event
 * reference issue #N" — required because plain substring matching causes
 * false positives (e.g. `#5` matches `#592`, `#54`). Built once per
 * issue number; cheap.
 */
const buildIssueReferenceMatchers = (issueNum: number): readonly RegExp[] => {
  const n = String(issueNum);
  return [
    new RegExp(`#${n}(?!\\d)`),
    new RegExp(`"issueNumber":\\s*${n}(?!\\d)`),
    new RegExp(`\\bissue ${n}(?!\\d)`, "i"),
  ];
};

/**
 * Match a fully-qualified `github.com/<owner>/<repo>/issues/<n>` URL,
 * with word boundary on the trailing digit so `/issues/845` does not
 * match `/issues/8450`. Comment anchors (`/issues/<n>#issuecomment-...`)
 * are also accepted.
 *
 * Used as structural evidence when an agent's commit/comment was made
 * via subprocess and produced no WakeActionReceipt but left the URL in
 * the wake summary or a governance event payload.
 */
const buildGithubIssueUrlMatcher = (issueNum: number): RegExp => {
  const n = String(issueNum);
  return new RegExp(`github\\.com/[^/]+/[^/]+/issues/${n}(?!\\d)`, "i");
};

/**
 * Extract the `<path>` portion from every
 * `github.com/<owner>/<repo>/blob/<branch>/<path>` URL in `text`.
 * Trailing `#Lxxx` line anchors are stripped.
 */
const extractGithubBlobPaths = (text: string): readonly string[] => {
  const re = /github\.com\/[^/\s]+\/[^/\s]+\/blob\/[^/\s]+\/([^\s)\]>`"']+)/gi;
  const paths: string[] = [];
  for (const match of text.matchAll(re)) {
    const path = match[1];
    if (path === undefined || path.length === 0) continue;
    const beforeAnchor = path.split("#")[0] ?? path;
    const cleanPath = beforeAnchor.replace(/[.,;:!?]+$/, "");
    if (cleanPath.length === 0) continue;
    paths.push(cleanPath);
  }
  return paths;
};

/**
 * Prefix + suffix glob matcher.
 *
 *   - The literal text before the first `*` is the required prefix.
 *   - The literal text after the last `*` is the required suffix.
 *   - Anything between matches arbitrary path content.
 *   - A glob with no `*` matches only via exact equality.
 *
 * Examples:
 *   `drafts/**\/*.md` → prefix `drafts/`, suffix `.md`  → matches `drafts/foo/bar.md`
 *   `agents/*\/role.md` → prefix `agents/`, suffix `/role.md` → matches `agents/x/role.md`
 *   `*.md` → prefix ``, suffix `.md` → matches `foo.md`
 */
const pathMatchesGlob = (actual: string, glob: string): boolean => {
  if (glob === actual) return true;
  const firstStar = glob.indexOf("*");
  if (firstStar === -1) return false;
  const prefix = glob.slice(0, firstStar);
  if (!actual.startsWith(prefix)) return false;
  const lastStar = glob.lastIndexOf("*");
  const suffix = glob.slice(lastStar + 1);
  return suffix.length === 0 || actual.endsWith(suffix);
};

/**
 * Check one required output against the wake's actual evidence.
 *
 * The mapping from `RequiredOutput.kind` to evidence is intentionally lax:
 * any successful receipt of the matching action kind satisfies the
 * obligation, plus path-glob checks where a `path` is declared. The
 * contract narrative remains the agent's authoritative guide on _what_ to
 * produce; the validator's job is to refuse "I claim I did it" wakes that
 * have no structured evidence at all.
 */
const isOutputSatisfied = (
  req: {
    readonly kind: string;
    readonly path?: string;
    readonly paths?: readonly string[];
  },
  result: {
    readonly actions: readonly WakeAction[];
    readonly outputs: readonly AgentOutputArtifact[];
    readonly governanceEvents: readonly EmittedGovernanceEvent[];
    readonly wakeSummary: string;
  },
  receipts: readonly WakeActionReceipt[],
): boolean => {
  const successfulReceiptOfKind = (actionKind: WakeAction["kind"]): boolean =>
    receipts.some((r) => r.success && r.action.kind === actionKind);

  switch (req.kind) {
    case "summary":
      return result.wakeSummary.trim().length > 0;
    case "runtime-artifact":
      // Runtime artifacts (per-wake digests) are produced by the daemon's
      // RunArtifactWriter unconditionally on wake completion. If validateWake
      // is being called, the wake completed, so a runtime artifact exists.
      return true;
    case "committed-artifact":
    case "commit": {
      // Build the set of acceptable globs. `paths` (OR semantics) wins over
      // `path` (single glob) when both are set. An obligation with neither
      // matches any commit-file receipt or any blob URL — a "did the agent
      // commit anything" check.
      const globs: readonly string[] | undefined =
        req.paths !== undefined && req.paths.length > 0
          ? req.paths
          : req.path !== undefined
            ? [req.path]
            : undefined;

      const receiptHit = receipts.some((r) => {
        if (!r.success || r.action.kind !== "commit-file") return false;
        if (globs === undefined) return true;
        const filePath = r.action.filePath;
        if (filePath === undefined) return false;
        return globs.some((g) => pathMatchesGlob(filePath, g));
      });
      if (receiptHit) return true;

      // Fallback evidence: a blob URL referenced in the wake summary or a
      // governance event. Agents that commit via subprocess (e.g. `gh api`)
      // leave no commit-file receipt but typically surface the resulting URL.
      const blobPaths = [
        ...extractGithubBlobPaths(result.wakeSummary),
        ...result.governanceEvents.flatMap((g) => {
          try {
            return extractGithubBlobPaths(JSON.stringify(g));
          } catch {
            return [];
          }
        }),
      ];
      if (blobPaths.length === 0) return false;
      if (globs === undefined) return true;
      return blobPaths.some((p) => globs.some((g) => pathMatchesGlob(p, g)));
    }
    case "comment":
      return successfulReceiptOfKind("comment-issue");
    case "issue":
      return successfulReceiptOfKind("create-issue");
    case "governance-event":
      return result.governanceEvents.length > 0;
    default:
      // Unknown kinds default to "satisfied" — forward-compat with future
      // contract extensions. The validator is a safety net, not a gatekeeper.
      return true;
  }
};

/**
 * Behavior validation.
 *
 * Scans `wakeSummary` for action-verb patterns that reference issue numbers
 * ("posted to #123", "closed issue #456", "labeled #789") and checks each
 * against structural evidence:
 *
 *   - successful WakeActionReceipt of the matching kind + issueNumber
 *   - a GitHub issue URL for the same issue number
 *
 * Unmatched claims produce a `BehaviorWarning`. Warnings are advisory:
 * they surface on dashboards and the wake record but do NOT affect
 * `productive`, `idleWakes`, or `successfulWakes`.
 */
export const validateBehavior = (
  result: {
    actions: readonly WakeAction[];
    governanceEvents: readonly EmittedGovernanceEvent[];
    wakeSummary: string;
  },
  actionReceipts: readonly WakeActionReceipt[],
): readonly BehaviorWarning[] => {
  const warnings: BehaviorWarning[] = [];
  const summary = result.wakeSummary;
  if (summary.length === 0) return warnings;

  // Pre-compute governance event text for URL evidence checks.
  const govStrings: string[] = [];
  for (const g of result.governanceEvents) {
    try {
      govStrings.push(JSON.stringify(g));
    } catch {
      govStrings.push("");
    }
  }

  const hasUrlEvidence = (issueNum: number): boolean => {
    const re = new RegExp(`github\\.com/[^/]+/[^/]+/issues/${String(issueNum)}(?!\\d)`, "i");
    if (re.test(summary)) return true;
    return govStrings.some((s) => s !== "" && re.test(s));
  };

  const hasReceiptOfKind = (issueNum: number, actionKind: WakeAction["kind"]): boolean =>
    actionReceipts.some(
      (r) => r.success && r.action.kind === actionKind && r.action.issueNumber === issueNum,
    );

  // Up to ~80 chars between the verb and the #N catches phrasing like
  // "posted my consent position on issue #864". The `{0,80}?` quantifier
  // is non-greedy so a sentence with multiple `#N` references attributes
  // the FIRST one to this verb, not the last. The trailing `(?!\d)` is a
  // word boundary on the digit so `#5` does not match `#54`.
  const commentClaimRegex =
    /\b(posted|commented|replied|left a comment|added a comment)\b(?:[^.\n]{0,80}?)#(\d+)(?!\d)/gi;
  const closeClaimRegex = /\b(closed|resolved)\b(?:[^.\n]{0,80}?)#(\d+)(?!\d)/gi;
  const labelClaimRegex =
    /\b(labeled|labelled|tagged|added (?:the )?label)\b(?:[^.\n]{0,80}?)#(\d+)(?!\d)/gi;

  for (const match of summary.matchAll(commentClaimRegex)) {
    const verb = match[1]?.toLowerCase() ?? "posted";
    const n = Number(match[2]);
    if (!Number.isFinite(n)) continue;
    if (hasReceiptOfKind(n, "comment-issue")) continue;
    if (hasUrlEvidence(n)) continue;
    warnings.push({
      kind: "narrative-action-without-evidence",
      message: `Narrative claims "${verb} … #${String(n)}" but no successful comment-issue receipt or issue URL`,
      issueNumber: n,
      verb,
    });
  }

  for (const match of summary.matchAll(closeClaimRegex)) {
    const verb = match[1]?.toLowerCase() ?? "closed";
    const n = Number(match[2]);
    if (!Number.isFinite(n)) continue;
    if (hasReceiptOfKind(n, "close-issue")) continue;
    if (hasUrlEvidence(n)) continue;
    warnings.push({
      kind: "narrative-action-without-evidence",
      message: `Narrative claims "${verb} … #${String(n)}" but no successful close-issue receipt or issue URL`,
      issueNumber: n,
      verb,
    });
  }

  for (const match of summary.matchAll(labelClaimRegex)) {
    const verb = match[1]?.toLowerCase() ?? "labeled";
    const n = Number(match[2]);
    if (!Number.isFinite(n)) continue;
    if (hasReceiptOfKind(n, "label-issue")) continue;
    if (hasUrlEvidence(n)) continue;
    warnings.push({
      kind: "narrative-action-without-evidence",
      message: `Narrative claims "${verb} … #${String(n)}" but no successful label-issue receipt or issue URL`,
      issueNumber: n,
      verb,
    });
  }

  return warnings;
};

/**
 * Default validation: checks artifact count, action item coverage, and
 * structured-evidence backing for any source-directive items in signals.
 * Used when no custom validator is configured.
 *
 * When `contract.requiredOutputs` is non-empty, each required output is
 * also checked against successful action receipts. An unmet required
 * output marks the wake non-productive even if the heuristic
 * (artifactCount > 0, no unaddressed directives) would have passed.
 *
 * `validateBehavior` runs alongside and attaches its warnings to the
 * result. Behavior warnings are advisory and do not affect `productive`.
 */
export const validateWake = (
  context: {
    actionItems: readonly Signal[];
    signals: readonly Signal[];
    /**
     * The waking agent's id and group memberships. Directives whose labels
     * don't intersect this agent's routing set (assigned:<id>,
     * scope:agent:<id>, scope:group:<gid>, scope:all) are treated as
     * signal, not accountability, and do not count as unaddressed.
     *
     * Pass empty groupIds when the agent has no group memberships.
     */
    agentId: string;
    groupIds: readonly string[];
    /**
     * Optional ExecutionContract. When supplied and `requiredOutputs` is
     * non-empty, obligation validation runs and may override the
     * heuristic productive flag.
     */
    contract?: ExecutionContract;
  },
  result: {
    actions: readonly WakeAction[];
    outputs: readonly AgentOutputArtifact[];
    governanceEvents: readonly EmittedGovernanceEvent[];
    wakeSummary: string;
  },
  actionReceipts: readonly WakeActionReceipt[],
): WakeValidationResult => {
  const artifactCount =
    actionReceipts.filter((r) => r.success).length +
    result.outputs.length +
    (result.governanceEvents.length > 0 ? 1 : 0);

  const actionItemsAssigned = context.actionItems.length;
  let actionItemsAddressed = 0;

  if (actionItemsAssigned > 0) {
    // Check which action items were addressed by a *successful* action
    // receipt referencing the issue number. Intent without a successful
    // receipt (i.e. an action returned in result.actions but never executed,
    // or executed and failed) is the same Boundary 5 anti-pattern: narration
    // of "I will/did" without structured evidence the action landed.
    for (const item of context.actionItems) {
      if (item.kind !== "github-issue") continue;
      const issueNum = item.number;
      const referenced = actionReceipts.some((r) => r.action.issueNumber === issueNum && r.success);
      if (referenced) actionItemsAddressed++;
    }
  }

  // Every source-directive in the bundle (signals + actionItems) must be
  // backed by a successful receipt OR a governance event whose
  // payload-as-string references the issue number with a word boundary.
  // The word boundary blocks `#5` from matching `#50` / `#592`. We also
  // serialize each governance event once (outside the per-directive loop)
  // and require a 1:1 directive→event match (one event satisfies at most
  // one directive) so a single multi-reference event cannot silence many.
  const directivesUnaddressed: UnaddressedDirective[] = [];
  const seen = new Set<number>();

  const govEventStrings: string[] = [];
  for (const g of result.governanceEvents) {
    try {
      govEventStrings.push(JSON.stringify(g));
    } catch {
      // Circular or non-serializable payload — treat as no reference rather
      // than crashing the validator on agent-controlled content.
      govEventStrings.push("");
    }
  }
  const claimedGovEventIdx = new Set<number>();

  // Routing set for this agent — directives whose labels don't intersect
  // this set are visible signal (facilitator cross-visibility) but not
  // this agent's accountability.
  const agentRoutingSet = new Set(buildAgentRoutingLabels(context.agentId, context.groupIds));

  const allBundle: readonly Signal[] = [...context.signals, ...context.actionItems];
  for (const sig of allBundle) {
    if (!isSourceDirective(sig)) continue;
    // Directive is signal, not work, for this agent — skip it.
    if (!sig.labels.some((l) => agentRoutingSet.has(l))) continue;
    const issueNum = sig.number;
    if (seen.has(issueNum)) continue;
    seen.add(issueNum);

    const hasSuccessfulReceipt = actionReceipts.some(
      (r) => r.action.issueNumber === issueNum && r.success,
    );
    if (hasSuccessfulReceipt) continue;

    const matchers = buildIssueReferenceMatchers(issueNum);
    let claimedIdx = -1;
    for (let i = 0; i < govEventStrings.length; i++) {
      if (claimedGovEventIdx.has(i)) continue;
      const s = govEventStrings[i];
      if (s !== undefined && s !== "" && matchers.some((re) => re.test(s))) {
        claimedIdx = i;
        break;
      }
    }
    if (claimedIdx >= 0) {
      claimedGovEventIdx.add(claimedIdx);
      continue;
    }

    const hasFailedReceipt = actionReceipts.some(
      (r) => r.action.issueNumber === issueNum && !r.success,
    );
    if (hasFailedReceipt) {
      directivesUnaddressed.push({ issueNumber: issueNum, reason: "no-successful-receipt" });
      continue;
    }

    const hasUnexecutedAction = result.actions.some((a) => a.issueNumber === issueNum);
    if (hasUnexecutedAction) {
      directivesUnaddressed.push({ issueNumber: issueNum, reason: "no-successful-receipt" });
      continue;
    }

    // A fully-qualified GitHub issue URL in the wake summary or any
    // governance event counts as structural evidence. This covers
    // subscription-CLI agents whose subprocess-internal comment posts
    // never land in `result.actions` but typically leave a URL in the
    // wake summary (the tool-call response includes the issue URL).
    const urlMatcher = buildGithubIssueUrlMatcher(issueNum);
    if (urlMatcher.test(result.wakeSummary)) {
      continue;
    }
    if (govEventStrings.some((s) => s !== "" && urlMatcher.test(s))) {
      continue;
    }

    if (matchers.some((re) => re.test(result.wakeSummary))) {
      directivesUnaddressed.push({ issueNumber: issueNum, reason: "narrative-only-claim" });
      continue;
    }

    directivesUnaddressed.push({ issueNumber: issueNum, reason: "no-structured-action" });
  }

  let obligationStatus: "satisfied" | "unmet" | "not-applicable" | undefined;
  let unmetRequiredOutputs:
    | { readonly kind: string; readonly path?: string; readonly paths?: readonly string[] }[]
    | undefined;
  if (context.contract !== undefined) {
    if (context.contract.requiredOutputs.length === 0) {
      obligationStatus = "not-applicable";
    } else {
      const unmet = context.contract.requiredOutputs.filter(
        (req) => !isOutputSatisfied(req, result, actionReceipts),
      );
      if (unmet.length === 0) {
        obligationStatus = "satisfied";
      } else {
        obligationStatus = "unmet";
        unmetRequiredOutputs = unmet.map((req) => ({
          kind: req.kind,
          ...(req.path !== undefined ? { path: req.path } : {}),
          ...(req.paths !== undefined ? { paths: req.paths } : {}),
        }));
      }
    }
  }

  const heuristicProductive =
    directivesUnaddressed.length === 0 && (artifactCount > 0 || actionItemsAddressed > 0);
  // Obligation enforcement: an unmet obligation marks the wake non-productive
  // even when the heuristic would have passed. `not-applicable` and
  // `satisfied` defer to the heuristic; `unmet` overrides to false.
  const productive = obligationStatus === "unmet" ? false : heuristicProductive;

  const reason = productive
    ? undefined
    : obligationStatus === "unmet"
      ? `contract obligation unmet: ${String(unmetRequiredOutputs?.length ?? 0)} required output(s) without matching evidence`
      : directivesUnaddressed.length > 0
        ? `${String(directivesUnaddressed.length)} directive(s) in signals not addressed by structured evidence`
        : actionItemsAssigned > 0
          ? `${String(actionItemsAssigned)} action items assigned but none addressed`
          : "wake completed but produced no artifacts";

  // Behavior validation runs alongside outcome validation but its
  // findings are advisory — they do NOT affect `productive` or any other
  // counter. They surface on the dashboard for operator review.
  const behaviorWarnings = validateBehavior(result, actionReceipts);

  const baseResult: WakeValidationResult = {
    productive,
    artifactCount,
    actionItemsAddressed,
    actionItemsAssigned,
    directivesUnaddressed,
    ...(obligationStatus !== undefined ? { obligationStatus } : {}),
    ...(unmetRequiredOutputs !== undefined ? { unmetRequiredOutputs } : {}),
    ...(behaviorWarnings.length > 0 ? { behaviorWarnings } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };
  return baseResult;
};

/**
 * Amend a wake summary string with the validation findings:
 * - inserts a `directives_unaddressed:` line after `signal_count:`
 * - downgrades the header `effectiveness:` line from `high` to `low` with
 *   an attribution noting the runtime override
 *
 * Returns the original summary unchanged when there are no unaddressed
 * directives. The agent's self-reflection block at the end of the digest
 * is not modified — operators see the discrepancy between the header
 * (runtime-overridden) and the agent's self-claim.
 *
 * Coupling note: the regexes target the exact line format produced by
 * the wake summary builder in `packages/core/src/runner/index.ts` (the
 * `[agent] wake <id>\n  model: ...\n  signal_count: ...\n  effectiveness: ...`
 * shape). If that format changes, the amendment silently no-ops on the
 * affected line — the directives_unaddressed line still appends at the
 * end as a fallback, but the effectiveness downgrade is lost. Tests in
 * `execution.test.ts` lock the current format.
 */
export const amendWakeSummaryWithValidation = (
  summary: string,
  validation: WakeValidationResult,
): string => {
  if (validation.directivesUnaddressed.length === 0) return summary;

  const summaryFragment = validation.directivesUnaddressed
    .map((d) => `#${String(d.issueNumber)} ${d.reason}`)
    .join(", ");
  const directivesLine = `  directives_unaddressed: ${String(validation.directivesUnaddressed.length)} (${summaryFragment})`;

  const plural = validation.directivesUnaddressed.length === 1 ? "directive" : "directives";
  const downgradeAttribution = `low (downgraded from agent-reported 'high' due to ${String(validation.directivesUnaddressed.length)} unaddressed ${plural})`;

  // Apply amendments only to the header section of the digest (the
  // structured pre-`---` block built by the runner). Splitting on the
  // first `\n---\n` keeps body content (which may quote prior digests'
  // `effectiveness: high` lines verbatim) untouched, and prevents the
  // downgrade attribution from rewriting an unrelated body line.
  const sep = "\n---\n";
  const sepIdx = summary.indexOf(sep);
  const header = sepIdx >= 0 ? summary.slice(0, sepIdx) : summary;
  const rest = sepIdx >= 0 ? summary.slice(sepIdx) : "";

  let amendedHeader = header;

  const signalCountRegex = /^(\s+signal_count:.*)$/m;
  if (signalCountRegex.test(amendedHeader)) {
    amendedHeader = amendedHeader.replace(signalCountRegex, `$1\n${directivesLine}`);
  } else {
    amendedHeader = `${amendedHeader}\n${directivesLine}`;
  }

  amendedHeader = amendedHeader.replace(
    /^(\s+effectiveness:)\s+high\b.*$/m,
    `$1 ${downgradeAttribution}`,
  );

  return amendedHeader + rest;
};

// ---------------------------------------------------------------------------
// Self-reflection parsing — extract structured reflection from wake output
// ---------------------------------------------------------------------------

/**
 * Parsed self-reflection from an agent's wake output.
 * The harness defines the format; the governance plugin interprets
 * the governance event if one was filed.
 */
export interface SelfReflection {
  readonly effectiveness: "high" | "medium" | "low" | "unknown";
  readonly observation: string;
  /** The governance event text, or null if none filed. */
  readonly governanceEvent: string | null;
}

/**
 * Parse the self-reflection block from an agent's wake output.
 * Looks for the standard format:
 *   EFFECTIVENESS: high / medium / low
 *   OBSERVATION: one sentence
 *   GOVERNANCE_EVENT: none — OR a description
 */
export const parseSelfReflection = (text: string): SelfReflection => {
  const effectivenessMatch = /EFFECTIVENESS:\s*(high|medium|low)/i.exec(text);
  const observationMatch = /OBSERVATION:\s*(.+)/i.exec(text);
  const govMatch = /GOVERNANCE_EVENT:\s*(.+)/i.exec(text);

  const effectiveness = (effectivenessMatch?.[1]?.toLowerCase() ??
    "unknown") as SelfReflection["effectiveness"];
  const observation = observationMatch?.[1]?.trim() ?? "";
  const govText = govMatch?.[1]?.trim() ?? "none";
  const governanceEvent = govText.toLowerCase() !== "none" && govText.length > 5 ? govText : null;

  return { effectiveness, observation, governanceEvent };
};

const VALID_WAKE_ACTION_KINDS = new Set([
  "label-issue",
  "create-issue",
  "close-issue",
  "comment-issue",
  "commit-file",
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

const isPositiveIssueNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v > 0;

const isValidWakeAction = (item: unknown): item is WakeAction => {
  if (typeof item !== "object" || item === null) return false;
  const obj = item as Record<string, unknown>;
  if (typeof obj.kind !== "string" || !VALID_WAKE_ACTION_KINDS.has(obj.kind)) return false;
  switch (obj.kind) {
    case "label-issue":
      return isPositiveIssueNumber(obj.issueNumber) && typeof obj.label === "string";
    case "create-issue":
      return typeof obj.title === "string";
    case "close-issue":
      return isPositiveIssueNumber(obj.issueNumber);
    case "comment-issue":
      return isPositiveIssueNumber(obj.issueNumber) && typeof obj.body === "string";
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
