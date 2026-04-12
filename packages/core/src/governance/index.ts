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
  onCreate?(item: GovernanceItem): void;
  onTransition?(item: GovernanceItem, transition: GovernanceStateTransition): void;
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
export class GovernanceStateStore {
  readonly #items = new Map<string, GovernanceItem>();
  readonly #graphs = new Map<string, GovernanceStateGraph>();
  readonly #now: () => Date;
  readonly #persistDir: string | undefined;
  readonly #onSync: GovernanceSyncCallbacks | undefined;
  #persistPending: Promise<void> | null = null;

  public constructor(options: {
    readonly now?: () => Date;
    readonly persistDir?: string | undefined;
    readonly onSync?: GovernanceSyncCallbacks | undefined;
  } = {}) {
    this.#now = options.now ?? ((): Date => new Date());
    this.#persistDir = options.persistDir;
    this.#onSync = options.onSync;
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
        // Rehydrate dates from ISO strings.
        const item: GovernanceItem = {
          ...raw,
          createdBy: { kind: "agent-id", value: raw.createdBy.value } as AgentId,
          createdAt: new Date(raw.createdAt as unknown as string),
          reviewAt: raw.reviewAt ? new Date(raw.reviewAt) : null,
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
    try { this.#onSync?.onCreate?.(item); } catch { /* fire-and-forget */ }
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
    void this.#persist(updated);
    try { this.#onSync?.onTransition?.(updated, transition); } catch { /* fire-and-forget */ }
    return updated;
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

/** Pairs one governance event with its routing decision(s). */
export interface GovernanceRoutingDecision {
  readonly event: EmittedGovernanceEvent;
  readonly routes: readonly GovernanceRouteTarget[];
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
export interface GovernancePlugin {
  /** Human-readable name for logging (e.g. "self-organizing", "chain-of-command", "meritocratic", "consensus", "parliamentary"). */
  readonly name: string;
  /** Semver version of the plugin implementation. */
  readonly version: string;

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
   * plugin inspects the events and returns routing instructions.
   * It may also create or advance governance items in the store.
   */
  onEventsEmitted(
    batch: GovernanceEventBatch,
    store: GovernanceStateStore,
  ): Promise<readonly GovernanceRoutingDecision[]>;

  /**
   * Go/no-go ruling before a consequential action. The plugin may
   * consult the state store (e.g. "is there an approved governance
   * item for this action?") or apply model-specific logic.
   */
  evaluateAction(
    agentId: AgentId,
    action: string,
    context: unknown,
    store: GovernanceStateStore,
  ): Promise<GovernanceDecision>;

  /**
   * Optional notification when a governance item transitions to a
   * new state. Called after the store has been updated. The plugin
   * can use this to trigger side-effect-free logging or to update
   * its own internal state.
   */
  onTransition?(item: GovernanceItem, transition: GovernanceStateTransition): void;

  /** Optional hook called once when the daemon starts. */
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
    _store: GovernanceStateStore,
  ): Promise<readonly GovernanceRoutingDecision[]> {
    return [];
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  public async evaluateAction(
    _agentId: AgentId,
    _action: string,
    _context: unknown,
    _store: GovernanceStateStore,
  ): Promise<GovernanceDecision> {
    return { allow: true };
  }
}
