/**
 * Daemon Protocol — single source of truth for all RPC methods.
 *
 * Every daemon method is defined here with its name, parameter/response
 * types, mutating flag, and parity matrix. CI validates that every method
 * marked "shipped" for a surface has a corresponding implementation.
 *
 * ADR-0018 §3: "Parity is enforced, not aspirational."
 */

// ---------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------

/**
 * Protocol schema version. Bump minor for additions (clients tolerate
 * unknown fields), major for incompatible changes (clients refuse).
 */
export const PROTOCOL_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Surface parity
// ---------------------------------------------------------------------------

export type SurfaceStatus = "shipped" | "planned" | "out-of-scope";

export interface SurfaceParity {
  readonly cliBatch: SurfaceStatus;
  readonly cliRepl: SurfaceStatus;
  readonly tuiDash: SurfaceStatus;
  readonly webDash: SurfaceStatus;
}

// ---------------------------------------------------------------------------
// Method definition
// ---------------------------------------------------------------------------

export interface ProtocolMethod {
  /** RPC method name (e.g., "status", "directive", "agents.list"). */
  readonly name: string;
  /** Human-readable one-line description for generated help. */
  readonly summary: string;
  /** Whether this method mutates state. Read-only attach rejects mutating methods. */
  readonly mutating: boolean;
  /** Which surfaces support this method. */
  readonly surfaces: SurfaceParity;
}

// ---------------------------------------------------------------------------
// Method registry
// ---------------------------------------------------------------------------

export const PROTOCOL_METHODS: readonly ProtocolMethod[] = [
  // -- Queries (read-only) --------------------------------------------------
  {
    name: "status",
    summary: "Daemon health, agent counts, governance, in-flight meetings",
    mutating: false,
    surfaces: { cliBatch: "shipped", cliRepl: "shipped", tuiDash: "shipped", webDash: "shipped" },
  },
  {
    name: "daemon.info",
    summary: "Daemon version, schema version, uptime, root directory",
    mutating: false,
    surfaces: { cliBatch: "planned", cliRepl: "planned", tuiDash: "planned", webDash: "planned" },
  },
  {
    name: "agents.list",
    summary: "List all agents with state, wakes, artifacts",
    mutating: false,
    // CLI verbs exist but call status RPC — real handler planned for v0.3
    surfaces: { cliBatch: "planned", cliRepl: "planned", tuiDash: "shipped", webDash: "shipped" },
  },
  {
    name: "agents.get",
    summary: "Agent detail: state, digests, action items",
    mutating: false,
    surfaces: { cliBatch: "planned", cliRepl: "planned", tuiDash: "planned", webDash: "shipped" },
  },
  {
    name: "groups.list",
    summary: "List all groups with member counts and stats",
    mutating: false,
    surfaces: { cliBatch: "planned", cliRepl: "planned", tuiDash: "shipped", webDash: "shipped" },
  },
  {
    name: "groups.get",
    summary: "Group detail: members, meetings, backlog",
    mutating: false,
    surfaces: { cliBatch: "planned", cliRepl: "planned", tuiDash: "planned", webDash: "shipped" },
  },
  {
    name: "groups.backlog",
    summary: "Group's GitHub work queue",
    mutating: false,
    surfaces: {
      cliBatch: "shipped",
      cliRepl: "planned",
      tuiDash: "planned",
      webDash: "out-of-scope",
    },
  },
  {
    name: "events.history",
    summary: "Recent daemon events (ring buffer dump)",
    mutating: false,
    surfaces: { cliBatch: "planned", cliRepl: "planned", tuiDash: "planned", webDash: "shipped" },
  },
  {
    name: "cost.summary",
    summary: "Cost summary by agent, day, or week",
    mutating: false,
    surfaces: { cliBatch: "planned", cliRepl: "planned", tuiDash: "shipped", webDash: "shipped" },
  },

  // -- Commands (mutating) --------------------------------------------------
  {
    name: "directive",
    summary: "Send a Source directive to agents or groups",
    mutating: true,
    surfaces: { cliBatch: "shipped", cliRepl: "shipped", tuiDash: "planned", webDash: "shipped" },
  },
  {
    name: "wake-now",
    summary: "Trigger an immediate agent wake",
    mutating: true,
    surfaces: { cliBatch: "shipped", cliRepl: "shipped", tuiDash: "planned", webDash: "shipped" },
  },
  {
    name: "group-wake",
    summary: "Convene a group meeting (operational/governance/retrospective)",
    mutating: true,
    surfaces: { cliBatch: "shipped", cliRepl: "shipped", tuiDash: "planned", webDash: "shipped" },
  },
  {
    name: "stop",
    summary: "Stop the daemon gracefully",
    mutating: true,
    surfaces: { cliBatch: "shipped", cliRepl: "shipped", tuiDash: "planned", webDash: "shipped" },
  },
  {
    name: "agents.pause",
    summary: "Pause an agent (suppress scheduler, set idle)",
    mutating: true,
    surfaces: {
      cliBatch: "planned",
      cliRepl: "planned",
      tuiDash: "out-of-scope",
      webDash: "out-of-scope",
    },
  },
  {
    name: "agents.resume",
    summary: "Resume a paused agent",
    mutating: true,
    surfaces: {
      cliBatch: "planned",
      cliRepl: "planned",
      tuiDash: "out-of-scope",
      webDash: "out-of-scope",
    },
  },
  {
    name: "wakes.cancel",
    summary: "Cancel an in-flight wake",
    mutating: true,
    surfaces: {
      cliBatch: "planned",
      cliRepl: "planned",
      tuiDash: "out-of-scope",
      webDash: "out-of-scope",
    },
  },
  {
    name: "meetings.cancel",
    summary: "Cancel an in-flight meeting",
    mutating: true,
    surfaces: {
      cliBatch: "planned",
      cliRepl: "planned",
      tuiDash: "out-of-scope",
      webDash: "out-of-scope",
    },
  },
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Look up a method by name. */
export const getMethod = (name: string): ProtocolMethod | undefined =>
  PROTOCOL_METHODS.find((m) => m.name === name);

/** All methods that are shipped for CLI batch. */
export const shippedBatchMethods = (): readonly ProtocolMethod[] =>
  PROTOCOL_METHODS.filter((m) => m.surfaces.cliBatch === "shipped");

/** All methods that are shipped for CLI REPL. */
export const shippedReplMethods = (): readonly ProtocolMethod[] =>
  PROTOCOL_METHODS.filter((m) => m.surfaces.cliRepl === "shipped");
