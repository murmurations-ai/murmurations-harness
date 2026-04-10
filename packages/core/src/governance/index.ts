/**
 * Governance plugin interface — the pluggable boundary for decision
 * lifecycle, event routing, and action authorization.
 *
 * The interface is governance-model-agnostic. It does not assume S3
 * (Sociocracy 3.0), command-and-control, consensus, meritocratic, or
 * any other specific governance model. Instead it exposes generic
 * lifecycle hooks that any model can implement:
 *
 *   - `onEventsEmitted` — after a wake, the daemon hands the plugin
 *     the emitted governance events and asks "where should these go?"
 *   - `evaluateAction` — before a consequential action, the daemon
 *     asks the plugin "should this agent proceed?"
 *
 * Plugins are **decision-makers, not actors.** They return routing
 * decisions and go/no-go rulings; the daemon executes them. This
 * keeps plugins free of infrastructure dependencies (no GitHub
 * clients, no signal aggregators, no network calls).
 *
 * The harness ships a `NoOpGovernancePlugin` that allows everything
 * and discards all events — the Phase 1/2 default. Concrete models
 * are supplied as separate packages or examples:
 *
 *   - S3 (teal): `examples/governance-s3/` — consent rounds, tensions,
 *     circle-based routing
 *   - Command-and-control (amber): orchestrator → sub-agent hierarchy,
 *     approval chains, directives
 *   - Meritocratic (orange): weighted voting, track-record-based
 *     authority, performance-gated autonomy
 *   - Flat consensus (green): unanimous or supermajority agreement
 *
 * @see https://github.com/murmurations-ai/murmurations-harness/issues/2
 */

import type { AgentId, WakeId, EmittedGovernanceEvent } from "../execution/index.js";

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
 * a governance model to the harness. The daemon calls the lifecycle
 * hooks at well-defined points; the plugin returns decisions
 * synchronously or asynchronously without performing side effects.
 */
export interface GovernancePlugin {
  /** Human-readable name for logging (e.g. "s3", "command-and-control"). */
  readonly name: string;
  /** Semver version of the plugin implementation. */
  readonly version: string;

  /**
   * Called after every wake that produces governance events. The
   * plugin inspects the events and returns routing instructions.
   * The daemon dispatches according to those instructions.
   *
   * If the plugin returns an empty array, all events are implicitly
   * discarded.
   */
  onEventsEmitted(batch: GovernanceEventBatch): Promise<readonly GovernanceRoutingDecision[]>;

  /**
   * Called when an agent (or the daemon itself) needs a go/no-go
   * ruling before a consequential action. The `action` string is a
   * free-form identifier (e.g. `"publish-article"`,
   * `"commit-to-main"`, `"spend-above-threshold"`). The `context`
   * carries model-specific metadata the plugin can interpret.
   *
   * S3 might run a consent round. Command-and-control might check
   * the approval chain. Meritocratic might consult track records.
   * Flat consensus might poll all agents. The harness doesn't care
   * which — it just awaits the decision.
   */
  evaluateAction(agentId: AgentId, action: string, context: unknown): Promise<GovernanceDecision>;

  /** Optional hook called once when the daemon starts. */
  onDaemonStart?(): Promise<void>;

  /** Optional hook called once when the daemon stops. */
  onDaemonStop?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Default implementation — no governance (Phase 1/2 behavior)
// ---------------------------------------------------------------------------

/**
 * No-op governance plugin. Allows every action and discards every
 * event. This is the default when no governance plugin is configured,
 * preserving the Phase 1/2 behavior where governance events are
 * collected and counted in logs but not routed or enforced.
 */
export class NoOpGovernancePlugin implements GovernancePlugin {
  public readonly name = "no-op";
  public readonly version = "1.0.0";

  // eslint-disable-next-line @typescript-eslint/require-await
  public async onEventsEmitted(
    _batch: GovernanceEventBatch,
  ): Promise<readonly GovernanceRoutingDecision[]> {
    return [];
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  public async evaluateAction(
    _agentId: AgentId,
    _action: string,
    _context: unknown,
  ): Promise<GovernanceDecision> {
    return { allow: true };
  }
}
