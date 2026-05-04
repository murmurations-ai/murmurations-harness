/**
 * Governance plugin interface — the pluggable boundary for decision
 * lifecycle, event routing, action authorization, and state tracking.
 *
 * The interface is governance-model-agnostic. It does not assume any
 * specific governance model. Instead it exposes generic primitives
 * that any model can implement:
 *
 *   - **Event routing** — after a wake, the daemon hands the plugin
 *     the emitted governance events and asks "where should these go?"
 *   - **Action authorization** — before a consequential action, the
 *     daemon asks the plugin "should this agent proceed?"
 *   - **State machine** — governance items (tensions, directives,
 *     proposals, motions) are tracked through model-defined states
 *     with a full audit trail and review dates. The harness manages
 *     the machine; the plugin defines the graph.
 *
 * Plugins are **decision-makers, not actors.** They return routing
 * decisions, go/no-go rulings, and state transitions; the daemon
 * executes them. This keeps plugins free of infrastructure deps.
 *
 * Every governance model follows the same universal flow, just with
 * different states and transitions:
 *
 *   Problem → Planning/Deliberation → Decision → Execution → Review
 *
 * The state machine formalizes this: each `kind` has a declared graph
 * of states and valid transitions, and every item carries a
 * `reviewAt` date so decisions can be revisited on cadence.
 *
 * @see https://github.com/murmurations-ai/murmurations-harness/issues/2
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentId, WakeId, EmittedGovernanceEvent } from "../execution/index.js";

// ---------------------------------------------------------------------------
// State machine — governance items tracked through model-defined states
// ---------------------------------------------------------------------------

/**
 * Declares the valid states and transitions for one governance item
 * kind. The plugin registers its graphs at `onDaemonStart`; the
 * harness validates every transition attempt against the graph.
 *
 * Examples:
 *   Self-Organizing (S3): open → deliberating → consent-round → resolved | withdrawn
 *   Chain of Command:     drafted → submitted → approved → executing → completed
 *   Meritocratic:         open → review → scored → accepted | rejected
 *   Consensus:            proposed → discussion → voting → passed | failed
 *   Parliamentary:        motion → seconded → debate → vote → passed | failed | tabled
 */
export interface GovernanceStateGraph {
  readonly kind: string;
  readonly initialState: string;
  readonly terminalStates: readonly string[];
  readonly transitions: readonly GovernanceTransitionRule[];
  /**
   * Default review interval for items of this kind, in days. When an
   * item reaches a terminal state, `reviewAt` is set to
   * `finishedAt + defaultReviewDays`. Plugins can override per-item.
   * If absent, terminal items have no automatic review date.
   */
  readonly defaultReviewDays?: number;
}

/** A single valid state transition in the graph. */
export interface GovernanceTransitionRule {
  readonly from: string;
  readonly to: string;
  /**
   * What triggers this transition. Free-form string so plugins can
   * define their own triggers. Well-known values:
   *   - `"agent-action"` — an agent explicitly advances the item
   *   - `"timeout"` — a deadline elapsed
   *   - `"vote-threshold"` — enough votes accumulated
   *   - `"approval"` — an authority approved
   *   - `"auto"` — harness-driven (e.g. review date reached)
   */
  readonly trigger: string;
  /** If set, the harness auto-fires this transition after N ms in
   *  the `from` state. Used for timeouts and escalation deadlines. */
  readonly timeoutMs?: number;
}

/**
 * A tracked governance item — the central persistence object. Created
 * when an agent emits a governance event that the plugin maps to a
 * new item, and tracked through states until it reaches a terminal
 * state. Terminal items persist for audit + review.
 */
export interface GovernanceItem {
  readonly id: string;
  readonly kind: string;
  readonly currentState: string;
  readonly payload: unknown;
  readonly createdBy: AgentId;
  readonly createdAt: Date;
  /** GitHub issue URL, set when the item is synced to GitHub. */
  readonly githubIssueUrl?: string | undefined;
  /**
   * When this governance decision should be reviewed. Set
   * automatically from the graph's `defaultReviewDays` when the item
   * reaches a terminal state, or overridden per-item by the plugin.
   * `null` means no scheduled review.
   *
   * The harness surfaces items past their review date as governance
   * signals on the next wake so the responsible agent (or Source)
   * can re-evaluate whether the decision is still valid.
   */
  readonly reviewAt: Date | null;
  readonly history: readonly GovernanceStateTransition[];
}

/** One state transition in an item's audit trail. */
export interface GovernanceStateTransition {
  readonly from: string;
  readonly to: string;
  readonly triggeredBy: string; // agentId, "system", "timeout"
  readonly at: Date;
  readonly reason?: string;
}

/**
 * The record the harness writes when a governance item reaches a
 * terminal state. This is the durable artifact agents can reference
 * to know what was decided. In a GitHub-backed murmuration, the
 * daemon writes this as an issue comment or a file in a governance
 * decisions directory. The format is deliberately simple so it can
 * be rendered as markdown, JSON, or YAML.
 */
export interface GovernanceDecisionRecord {
  readonly itemId: string;
  readonly kind: string;
  readonly finalState: string;
  readonly decidedAt: Date;
  readonly reviewAt: Date | null;
  readonly summary: string;
  readonly payload: unknown;
  readonly history: readonly GovernanceStateTransition[];
  readonly createdBy: string; // agentId value
}

// ---------------------------------------------------------------------------
// State store — in-memory for Phase 2, durable for Phase 3
// ---------------------------------------------------------------------------

/** Filter for querying governance items. All fields are optional (&& logic). */
/**
 * Callbacks for syncing governance state to an external system
 * (GitHub issues, etc.). The GovernanceStateStore fires these
 * on every create/transition. Implementations must be fire-and-forget
 * (never throw, never block governance operations).
 */
export interface GovernanceSyncCallbacks {
  /** Called when a governance item is created. May return a GitHub issue URL. */
  onCreate?(item: GovernanceItem): undefined | string | Promise<undefined | string>;
  onTransition?(
    item: GovernanceItem,
    transition: GovernanceStateTransition,
    isTerminal: boolean,
  ): void;
}

export interface GovernanceItemFilter {
  readonly state?: string;
  readonly kind?: string;
  readonly createdBy?: string; // agentId value
  /** If true, return only items whose reviewAt is in the past. */
  readonly reviewDue?: boolean;
}

/**
 * Governance state store. Tracks items through model-defined states
 * with a full audit trail. Optionally persists to disk when
 * `persistDir` is set — items are written to `items.jsonl` on every
 * create/transition and restored on `load()`.
 *
 * In-memory when `persistDir` is omitted (tests, Phase 1/2 behavior).
 * Durable when `persistDir` is set (production daemon restarts).
 */

/**
 * Read-only view of governance state, handed to {@link GovernancePlugin}
 * lifecycle hooks. Plugins are decision-makers, not state mutators —
 * they inspect current state and return {@link GovernanceRoutingDecision}s
 * that describe what should happen. The daemon applies mutations on the
 * plugin's behalf.
 *
 * Isolating reads from writes at the type level prevents a buggy or
 * adversarial plugin from corrupting items it does not own, bypassing
 * state-graph validation, or mutating history.
 */
export interface GovernanceStateReader {
  graphs(): readonly GovernanceStateGraph[];
  get(itemId: string): GovernanceItem | undefined;
  query(filter?: GovernanceItemFilter): readonly GovernanceItem[];
  buildDecisionRecord(itemId: string, summary: string): GovernanceDecisionRecord;
  size(): number;
}

/**
 * Build a runtime read-only proxy of a {@link GovernanceStateReader}.
 *
 * TypeScript narrows the plugin interface to the reader surface, but a
 * JavaScript/`.mjs` plugin can runtime-cast its parameter back to the
 * full store. This proxy closes that gap: the returned object carries
 * *only* the reader methods, delegating each to the underlying store.
 * Casting it back to `GovernanceStateStore` still yields `undefined`
 * for `create`/`transition`/`setGithubIssueUrl` at runtime.
 */
export const makeGovernanceStateReader = (store: GovernanceStateReader): GovernanceStateReader => ({
  graphs: () => store.graphs(),
  get: (itemId) => store.get(itemId),
  query: (filter) => store.query(filter),
  buildDecisionRecord: (itemId, summary) => store.buildDecisionRecord(itemId, summary),
  size: () => store.size(),
});

/** Interface for governance state storage — enables GitHub-backed or SSE implementations. */
export interface IGovernanceStateStore extends GovernanceStateReader {
  registerGraph(graph: GovernanceStateGraph): void;
  create(
    kind: string,
    createdBy: AgentId,
    payload: unknown,
    options?: { reviewAt?: Date },
  ): GovernanceItem;
  transition(itemId: string, to: string, triggeredBy: string, reason?: string): GovernanceItem;
  setGithubIssueUrl(itemId: string, url: string): void;
  load(): Promise<number>;
  flush(): Promise<void>;
}

export class GovernanceStateStore implements IGovernanceStateStore {
  readonly #items = new Map<string, GovernanceItem>();
  readonly #graphs = new Map<string, GovernanceStateGraph>();
  readonly #now: () => Date;
  readonly #persistDir: string | undefined;
  readonly #onSync: GovernanceSyncCallbacks | undefined;
  readonly #readOnly: boolean;
  #persistPending: Promise<void> | null = null;

  public constructor(
    options: {
      readonly now?: () => Date;
      readonly persistDir?: string | undefined;
      readonly onSync?: GovernanceSyncCallbacks | undefined;
      /**
       * When `true`, `create` and `transition` throw instead of mutating
       * state. Use for CLI processes that share the on-disk `items.jsonl`
       * with a running daemon — the daemon is the single writer
       * (Engineering Standard #3). Default: `false`.
       */
      readonly readOnly?: boolean;
    } = {},
  ) {
    this.#now = options.now ?? ((): Date => new Date());
    this.#persistDir = options.persistDir;
    this.#onSync = options.onSync;
    this.#readOnly = options.readOnly ?? false;
  }

  /**
   * Load persisted governance items from disk. Call once at daemon
   * start, AFTER registering graphs. No-op if `persistDir` is unset
   * or the file doesn't exist yet (first run).
   */
  public async load(): Promise<number> {
    if (!this.#persistDir) return 0;
    const path = join(this.#persistDir, "items.jsonl");
    let contents: string;
    try {
      contents = await readFile(path, "utf8");
    } catch {
      return 0; // file doesn't exist yet
    }
    let loaded = 0;
    for (const line of contents.trim().split("\n")) {
      if (line.length === 0) continue;
      try {
        const raw = JSON.parse(line) as GovernanceItem & {
          createdBy: { value: string };
          createdAt: string;
          reviewAt: string | null;
          history: (GovernanceStateTransition & { at: string })[];
        };
        // Rehydrate dates from ISO strings with validation.
        const createdAt = new Date(raw.createdAt as unknown as string);
        const reviewAt = raw.reviewAt ? new Date(raw.reviewAt) : null;
        if (Number.isNaN(createdAt.getTime())) {
          console.warn(`governance: skipping item "${raw.id}" — invalid createdAt`);
          continue;
        }
        if (reviewAt && Number.isNaN(reviewAt.getTime())) {
          console.warn(`governance: skipping item "${raw.id}" — invalid reviewAt`);
          continue;
        }
        const item: GovernanceItem = {
          ...raw,
          createdBy: { kind: "agent-id", value: raw.createdBy.value } as AgentId,
          createdAt,
          reviewAt,
          history: raw.history.map((h) => ({
            ...h,
            at: new Date(h.at as unknown as string),
          })),
        };
        this.#items.set(item.id, item);
        loaded++;
      } catch {
        // Malformed line — skip.
      }
    }
    return loaded;
  }

  /** Register a state graph. Call once per kind at plugin init. */
  public registerGraph(graph: GovernanceStateGraph): void {
    this.#graphs.set(graph.kind, graph);
  }

  /** All registered state graphs. */
  public graphs(): readonly GovernanceStateGraph[] {
    return [...this.#graphs.values()];
  }

  /**
   * Create a new governance item in the graph's initial state.
   * Throws if the `kind` has no registered graph.
   */
  public create(
    kind: string,
    createdBy: AgentId,
    payload: unknown,
    options: { readonly reviewAt?: Date } = {},
  ): GovernanceItem {
    if (this.#readOnly) {
      throw new Error(
        "GovernanceStateStore: create() called on read-only instance. Only the daemon writes to items.jsonl; CLI processes must RPC the daemon.",
      );
    }
    const graph = this.#graphs.get(kind);
    if (!graph) {
      throw new Error(`governance: no state graph registered for kind "${kind}"`);
    }
    const now = this.#now();
    const item: GovernanceItem = {
      id: randomUUID(),
      kind,
      currentState: graph.initialState,
      payload,
      createdBy,
      createdAt: now,
      reviewAt: options.reviewAt ?? null,
      history: [],
    };
    this.#items.set(item.id, item);
    this.#persistPending = this.#persist(item);
    try {
      const syncResult = this.#onSync?.onCreate?.(item);
      // If the sync returns a GitHub URL (sync or async), set it on the item
      if (typeof syncResult === "string") {
        this.setGithubIssueUrl(item.id, syncResult);
      } else if (syncResult instanceof Promise) {
        void syncResult
          .then((url) => {
            if (typeof url === "string") this.setGithubIssueUrl(item.id, url);
          })
          .catch(() => {
            /* fire-and-forget */
          });
      }
    } catch {
      /* fire-and-forget */
    }
    return item;
  }

  /**
   * Transition an item to a new state. Validates against the
   * registered graph — throws if the transition is not allowed.
   * Returns the updated item.
   */
  public transition(
    itemId: string,
    to: string,
    triggeredBy: string,
    reason?: string,
  ): GovernanceItem {
    if (this.#readOnly) {
      throw new Error(
        "GovernanceStateStore: transition() called on read-only instance. Only the daemon writes to items.jsonl; CLI processes must RPC the daemon.",
      );
    }
    const item = this.#items.get(itemId);
    if (!item) throw new Error(`governance: item "${itemId}" not found`);

    const graph = this.#graphs.get(item.kind);
    if (!graph) throw new Error(`governance: no graph for kind "${item.kind}"`);

    const valid = graph.transitions.some((t) => t.from === item.currentState && t.to === to);
    if (!valid) {
      throw new Error(
        `governance: transition "${item.currentState}" → "${to}" is not valid for kind "${item.kind}"`,
      );
    }

    const now = this.#now();
    const transition: GovernanceStateTransition = {
      from: item.currentState,
      to,
      triggeredBy,
      at: now,
      ...(reason !== undefined ? { reason } : {}),
    };

    // Compute reviewAt when reaching a terminal state.
    const isTerminal = graph.terminalStates.includes(to);
    const reviewAt =
      isTerminal && graph.defaultReviewDays !== undefined
        ? new Date(now.getTime() + graph.defaultReviewDays * 86_400_000)
        : item.reviewAt;

    const updated: GovernanceItem = {
      ...item,
      currentState: to,
      reviewAt,
      history: [...item.history, transition],
    };
    this.#items.set(itemId, updated);
    this.#persistPending = this.#persist(updated);
    try {
      this.#onSync?.onTransition?.(updated, transition, isTerminal);
    } catch {
      /* fire-and-forget */
    }
    return updated;
  }

  /** Set the GitHub issue URL for an item (called by sync after issue creation). */
  public setGithubIssueUrl(itemId: string, url: string): void {
    const item = this.#items.get(itemId);
    if (!item) return;
    const updated: GovernanceItem = { ...item, githubIssueUrl: url };
    this.#items.set(itemId, updated);
    this.#persistPending = this.#persist(updated);
  }

  /** Look up a single item by id. */
  public get(itemId: string): GovernanceItem | undefined {
    return this.#items.get(itemId);
  }

  /** Query items matching the filter. */
  public query(filter: GovernanceItemFilter = {}): readonly GovernanceItem[] {
    const now = this.#now();
    const results: GovernanceItem[] = [];
    for (const item of this.#items.values()) {
      if (filter.state !== undefined && item.currentState !== filter.state) continue;
      if (filter.kind !== undefined && item.kind !== filter.kind) continue;
      if (filter.createdBy !== undefined && item.createdBy.value !== filter.createdBy) continue;
      if (filter.reviewDue === true) {
        if (item.reviewAt === null || item.reviewAt.getTime() > now.getTime()) continue;
      }
      results.push(item);
    }
    return results;
  }

  /** Build a decision record for a terminal item (for durable persistence). */
  public buildDecisionRecord(itemId: string, summary: string): GovernanceDecisionRecord {
    const item = this.#items.get(itemId);
    if (!item) throw new Error(`governance: item "${itemId}" not found`);
    return {
      itemId: item.id,
      kind: item.kind,
      finalState: item.currentState,
      decidedAt: this.#now(),
      reviewAt: item.reviewAt,
      summary,
      payload: item.payload,
      history: item.history,
      createdBy: item.createdBy.value,
    };
  }

  /** How many items are tracked (for logging). */
  public size(): number {
    return this.#items.size;
  }

  /** Wait for any pending persistence writes to complete. Tests use
   *  this to ensure the file is flushed before reading it back. */
  public async flush(): Promise<void> {
    if (this.#persistPending) await this.#persistPending;
  }

  /**
   * Persist a single item by rewriting the full items.jsonl file.
   * This is append-style in spirit but rewrites on every mutation
   * to keep the file a clean snapshot (no stale entries for the same
   * item id). Best-effort — errors are swallowed so governance
   * operations are never blocked by I/O.
   */
  async #persist(_item: GovernanceItem): Promise<void> {
    if (!this.#persistDir) return;
    try {
      await mkdir(this.#persistDir, { recursive: true });
      const lines = [...this.#items.values()].map((i) => JSON.stringify(i));
      await writeFile(join(this.#persistDir, "items.jsonl"), lines.join("\n") + "\n", "utf8");
    } catch {
      // Best-effort persistence — swallow errors.
    }
  }
}

// ---------------------------------------------------------------------------
// Event routing
// ---------------------------------------------------------------------------

/** The batch of governance events from one completed wake. */
export interface GovernanceEventBatch {
  readonly wakeId: WakeId;
  readonly agentId: AgentId;
  readonly events: readonly EmittedGovernanceEvent[];
}

/**
 * Where the plugin wants a governance event delivered. The daemon
 * owns the actual dispatch; the plugin only names the target.
 */
export type GovernanceRouteTarget =
  | { readonly target: "agent"; readonly agentId: AgentId }
  | { readonly target: "source" }
  | { readonly target: "external"; readonly channel: string; readonly ref: string }
  | { readonly target: "discard" };

/**
 * A plugin-requested governance item creation. Returned as part of
 * {@link GovernanceRoutingDecision} so the daemon — not the plugin —
 * writes to the state store. The daemon sets `createdBy` from the
 * triggering batch; the plugin has no way to forge it.
 */
export interface GovernanceItemCreateRequest {
  readonly kind: string;
  readonly payload: unknown;
  readonly reviewAt?: Date;
}

/** Pairs one governance event with its routing decision(s). */
export interface GovernanceRoutingDecision {
  readonly event: EmittedGovernanceEvent;
  readonly routes: readonly GovernanceRouteTarget[];
  /** Optional: ask the daemon to create a governance item tied to this event. */
  readonly create?: GovernanceItemCreateRequest;
}

// ---------------------------------------------------------------------------
// Action authorization
// ---------------------------------------------------------------------------

/** The plugin's ruling on whether an agent may proceed with an action. */
export type GovernanceDecision =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: string };

// ---------------------------------------------------------------------------
// Plugin interface
// ---------------------------------------------------------------------------

/**
 * The governance plugin contract. Implement this interface to provide
 * a governance model to the harness.
 *
 * The daemon calls lifecycle hooks at well-defined points; the plugin
 * returns decisions without performing side effects. The daemon also
 * provides a {@link GovernanceStateStore} at init time so the plugin
 * can register its state graphs, create items, and advance them
 * through states.
 *
 * Universal governance flow (model-agnostic):
 *   Problem → Planning/Deliberation → Decision → Execution → Review
 *
 * The state machine formalizes this per governance model. Each plugin
 * declares its own state graphs (kinds + states + transitions) and
 * the harness tracks items through those states with a full audit
 * trail and automatic review-date enforcement.
 */
/**
 * Display terms the governance model uses for human-facing output.
 * The harness code uses "group" internally; the plugin overrides
 * these for CLI output, dashboard labels, and meeting titles.
 */
export interface GovernanceTerminology {
  /** What to call a group of agents (e.g. "circle", "department", "committee", "guild"). Default: "group". */
  readonly group: string;
  /** Plural form (e.g. "circles", "departments"). Default: "groups". */
  readonly groupPlural: string;
  /** What to call a governance item (e.g. "tension", "report", "motion", "flag"). Default: "item". */
  readonly governanceItem: string;
  /** What to call a governance event filed by an agent (e.g. "tension", "directive", "flag"). Default: "governance event". */
  readonly governanceEvent: string;
}

export const DEFAULT_TERMINOLOGY: GovernanceTerminology = {
  group: "group",
  groupPlural: "groups",
  governanceItem: "item",
  governanceEvent: "governance event",
};

// ---------------------------------------------------------------------------
// v0.7.0 — facilitator-facing types (ADR-0041)
// ---------------------------------------------------------------------------

/**
 * Snapshot of a GitHub-side issue at a moment in time, fed to the
 * facilitator-callable plugin methods (`computeNextState`,
 * `verifyClosure`, `buildAgenda`). Decoupled from `GovernanceItem`
 * because the facilitator works with the live GitHub view and may
 * advance items that don't yet have a `GovernanceItem` record.
 */
export interface IssueSnapshot {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly state: "open" | "closed";
  readonly comments: readonly IssueComment[];
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Author agent id when traceable via comment authorship or label heuristics; otherwise undefined. */
  readonly authorAgentId?: AgentId;
}

export interface IssueComment {
  readonly authorAgentId?: AgentId;
  readonly body: string;
  readonly createdAt: string;
}

/**
 * Evidence that a closure is structurally backed. The facilitator
 * collects these from the issue thread before closing; a closure
 * with zero verifications fails the default `verifyClosure` check
 * and is re-opened with `verification-failed`.
 */
export interface ClosureEvidence {
  readonly closerAgentId: AgentId;
  readonly reason: string;
  readonly verifications: readonly Verification[];
}

export type Verification =
  | { readonly kind: "linked-closed-issue"; readonly issueNumber: number }
  | { readonly kind: "commit-ref"; readonly sha: string; readonly path: string }
  | {
      readonly kind: "confirmation-comment";
      readonly authorAgentId: AgentId;
      readonly commentSha: string;
    }
  | { readonly kind: "agreement-entry"; readonly slug: string };

/**
 * Default closer roles for an issue type. Returned by `closerFor()`
 * (plugin override; harness default for unknown types).
 *
 * - `"facilitator"` — facilitator-agent closes after state machine reaches terminal
 * - `"source"` — Source closes (facilitator labels `awaiting:source-close`)
 * - `"filer"` — the agent that filed the issue closes their own when resolved
 * - `"responsible"` — the agent named in the `assigned:` label closes when done
 */
export type CloserRole = "facilitator" | "source" | "filer" | "responsible";

/** Result of `verifyClosure` — either success or a named failure reason. */
export type ClosureVerificationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

// ---------------------------------------------------------------------------
// State graph helper — derived from plugin's stateGraphs()
// ---------------------------------------------------------------------------

/**
 * Returns true when `state` is terminal for the given `kind` according
 * to the plugin's declared state graphs. Falls back to checking every
 * graph when `kind` is omitted (returns true if state is terminal in
 * any graph). Implements the "is this closeable?" check the
 * facilitator runs each wake.
 */
export const isTerminalState = (
  plugin: Pick<GovernancePlugin, "stateGraphs">,
  state: string,
  kind?: string,
): boolean => {
  const graphs = plugin.stateGraphs();
  for (const graph of graphs) {
    if (kind !== undefined && graph.kind !== kind) continue;
    if (graph.terminalStates.includes(state)) return true;
  }
  return false;
};

// ---------------------------------------------------------------------------
// GovernancePlugin interface
// ---------------------------------------------------------------------------

export interface GovernancePlugin {
  /** Human-readable name for logging (e.g. "self-organizing", "chain-of-command", "meritocratic", "consensus", "parliamentary"). */
  readonly name: string;
  /** Semver version of the plugin implementation. */
  readonly version: string;
  /** Display terminology for this governance model. If omitted, generic defaults are used. */
  readonly terminology?: GovernanceTerminology;

  /**
   * Declare the state graphs this governance model uses. Called once
   * at daemon start. Each graph defines the valid states and
   * transitions for one governance item kind.
   *
   * The harness registers these graphs with the
   * {@link GovernanceStateStore} and validates every subsequent
   * transition against them.
   */
  stateGraphs(): readonly GovernanceStateGraph[];

  /**
   * Called after every wake that produces governance events. The
   * plugin inspects the events (with read-only state access) and
   * returns routing decisions. If the plugin wants to record a new
   * governance item, it attaches a `create` request to the decision
   * and the daemon performs the write.
   */
  onEventsEmitted(
    batch: GovernanceEventBatch,
    reader: GovernanceStateReader,
  ): Promise<readonly GovernanceRoutingDecision[]>;

  /**
   * Go/no-go ruling before a consequential action. Read-only — plugins
   * consult current state (e.g. "is there an approved governance item
   * for this action?") but cannot mutate it. Returning `{ allow: false }`
   * is the only way to influence execution.
   */
  evaluateAction(
    agentId: AgentId,
    action: string,
    context: unknown,
    reader: GovernanceStateReader,
  ): Promise<GovernanceDecision>;

  /**
   * Optional notification when a governance item transitions to a
   * new state. Called after the store has been updated. The plugin
   * can use this to trigger side-effect-free logging or to update
   * its own internal state.
   */
  onTransition?(item: GovernanceItem, transition: GovernanceStateTransition): void;

  /**
   * After a group meeting produces a tally recommendation, the daemon
   * calls this hook to decide whether the referenced governance items
   * should transition to a terminal state. Generic daemon code cannot
   * know what "resolve" / "ratify" / "approve" mean in every governance
   * model, so the plugin owns the decision.
   *
   * Return `true` when the recommendation implies the item is done;
   * the daemon will walk the plugin's own state graph to find the
   * nearest terminal transition. Return `false` (or omit the hook)
   * to leave items in their current state — the daemon will not
   * auto-resolve anything it can't attribute to the plugin.
   *
   * S3 interprets "ratify" / "approve" / "consent" / "resolve" /
   * "adopt" as resolving. Chain of Command interprets "approve" /
   * "execute". Parliamentary interprets "pass" / "adopt". None of
   * these vocabularies belong in core.
   */
  isResolvingRecommendation?(recommendation: string): boolean;

  /**
   * v0.7.0 — Compute the next state for a governance item given its
   * current state, the live GitHub issue snapshot, and the named
   * circle members. The facilitator-agent calls this once per wake
   * for each open governance-typed issue.
   *
   * Returns the proposed transition + a human-readable reason. Returns
   * `null` when no transition applies (e.g. waiting on a named member's
   * position, or quorum not yet reached).
   *
   * Plugins that don't implement this leave items in their current
   * state — the facilitator will not advance items for plugins that
   * haven't opted in.
   *
   * @see ADR-0041 Part 2
   */
  computeNextState?(input: {
    readonly currentState: string;
    readonly itemKind: string;
    readonly issue: IssueSnapshot;
    readonly circleMembers: readonly AgentId[];
  }): Promise<{ readonly next: string; readonly reason: string } | null>;

  /**
   * v0.7.0 — Whether a state is terminal (closeable) for a given kind.
   * Convenience override; if absent, the harness derives this from the
   * plugin's `stateGraphs()` via {@link isTerminalState}. Plugins
   * normally don't need to override unless terminal-ness depends on
   * runtime conditions beyond the static graph.
   *
   * @see ADR-0041 Part 2
   */
  isTerminal?(state: string, kind: string): boolean;

  /**
   * v0.7.0 — Optional plugin-specific closure verification. The
   * harness always runs a default check that requires structural
   * change evidence (linked closed issue / commit ref / confirmation
   * comment / agreement entry). Plugins can layer additional checks
   * (e.g. consent quorum threshold, expert weighting, majority vote).
   *
   * Return `{ ok: true }` to allow closure. Return `{ ok: false; reason }`
   * to block closure — the facilitator labels the issue
   * `verification-failed` and re-opens it for one retry; second
   * failure escalates to Source.
   *
   * @see ADR-0041 Part 3
   */
  verifyClosure?(input: {
    readonly issue: IssueSnapshot;
    readonly state: string;
    readonly itemKind: string;
    readonly evidence: ClosureEvidence;
  }): ClosureVerificationResult;

  /**
   * v0.7.0 — Build the human-readable agenda block for a circle
   * meeting given the current state machine snapshot. Plugins can
   * specialize the agenda format per governance style. If absent,
   * the facilitator produces a generic list grouped by state.
   *
   * @see ADR-0041 Part 1
   */
  buildAgenda?(input: {
    readonly circleId: string;
    readonly openItems: readonly { readonly issue: IssueSnapshot; readonly state: string }[];
  }): string;

  /**
   * v0.7.0 — Determine the default closer role for a given issue type
   * (`"[TENSION]"`, `"[PROPOSAL]"`, `"[*MEETING]"`, `"[DIRECTIVE]"`,
   * `"[other]"`, etc.). The harness has its own defaults; plugins can
   * override per governance style (e.g. parliamentary may want
   * `"facilitator"` for everything, chain-of-command may route most
   * closures to `"source"`).
   *
   * Returning `undefined` falls through to the harness default.
   *
   * @see ADR-0041 Part 3
   */
  closerFor?(issueType: string): CloserRole | undefined;

  /**
   * Optional hook called once when the daemon starts. Unlike
   * {@link onEventsEmitted} and {@link evaluateAction}, this receives the
   * full mutable store so the plugin can register state graphs via
   * {@link GovernanceStateStore.registerGraph}. Plugins **should not**
   * create or transition items here — that belongs in `onEventsEmitted`
   * via the {@link GovernanceRoutingDecision.create} channel. Runtime
   * isolation is relaxed for this hook because plugin code is
   * operator-trusted at startup.
   */
  onDaemonStart?(store: GovernanceStateStore): Promise<void>;

  /** Optional hook called once when the daemon stops. */
  onDaemonStop?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Default implementation — no governance (Phase 1/2 behavior)
// ---------------------------------------------------------------------------

/**
 * No-op governance plugin. Allows every action, discards every event,
 * declares no state graphs. This is the default when no governance
 * plugin is configured, preserving Phase 1/2 behavior.
 */
export class NoOpGovernancePlugin implements GovernancePlugin {
  public readonly name = "no-op";
  public readonly version = "1.0.0";

  public stateGraphs(): readonly GovernanceStateGraph[] {
    return [];
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  public async onEventsEmitted(
    _batch: GovernanceEventBatch,
    _reader: GovernanceStateReader,
  ): Promise<readonly GovernanceRoutingDecision[]> {
    return [];
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  public async evaluateAction(
    _agentId: AgentId,
    _action: string,
    _context: unknown,
    _reader: GovernanceStateReader,
  ): Promise<GovernanceDecision> {
    return { allow: true };
  }
}
