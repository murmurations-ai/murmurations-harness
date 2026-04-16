/**
 * CollaborationProvider — pluggable abstraction for the coordination,
 * artifact, and signal layers (ADR-0021).
 *
 * The harness uses this interface for all collaborative state:
 * governance items, meeting minutes, directives, action items,
 * and agent artifact commits. GitHub is the default provider;
 * LocalCollaborationProvider ships for offline/testing.
 *
 * The provider targets the murmuration's governance repo by default.
 * Product repos are accessed by agents via MCP tools or explicit
 * write scopes — not through this interface.
 */

// ---------------------------------------------------------------------------
// References (opaque handles returned by the provider)
// ---------------------------------------------------------------------------

/** Reference to a coordination item (issue, ticket, file). */
export interface ItemRef {
  /** Provider-specific identifier (e.g. GitHub issue number, file path). */
  readonly id: string;
  /** Human-readable URL, if the provider exposes one. */
  readonly url?: string;
}

/** Reference to a comment on an item. */
export interface CommentRef {
  readonly id: string;
  readonly url?: string;
}

/** Reference to a committed artifact. */
export interface ArtifactRef {
  /** Provider-specific identifier (e.g. commit OID, file path). */
  readonly id: string;
  readonly url?: string;
  /** Path where the artifact was written. */
  readonly path: string;
}

// ---------------------------------------------------------------------------
// Domain objects
// ---------------------------------------------------------------------------

/** A coordination item (issue, ticket, YAML file). */
export interface CollaborationItem {
  readonly ref: ItemRef;
  readonly title: string;
  readonly body: string;
  readonly state: ItemState;
  readonly labels: readonly string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type ItemState = "open" | "closed";

/** Filter for listing coordination items. */
export interface ItemFilter {
  readonly state?: ItemState | "all";
  readonly labels?: readonly string[];
  /** Only items updated since this date. */
  readonly since?: Date;
  readonly limit?: number;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type CollaborationErrorCode =
  | "NOT_FOUND"
  | "PERMISSION_DENIED"
  | "INVALID_INPUT"
  | "RATE_LIMITED"
  | "TRANSPORT"
  | "UNKNOWN";

export class CollaborationError extends Error {
  readonly code: CollaborationErrorCode;
  readonly provider: string;

  constructor(
    provider: string,
    code: CollaborationErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "CollaborationError";
    this.code = code;
    this.provider = provider;
  }
}

// ---------------------------------------------------------------------------
// Result type (errors-as-values)
// ---------------------------------------------------------------------------

export type CollabResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: CollaborationError };

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

/**
 * CollaborationProvider — the abstraction boundary between the harness
 * and whatever coordination backend the murmuration uses.
 *
 * All methods return `CollabResult<T>` (errors-as-values). Providers
 * MUST enforce write-scope restrictions and return `PERMISSION_DENIED`
 * when an operation exceeds the configured access.
 */
export interface CollaborationProvider {
  /** Provider identifier (e.g. "github", "local", "gitlab"). */
  readonly id: string;
  /** Human-readable name for display. */
  readonly displayName: string;

  // --- Coordination (items / issues / tickets) ---

  /** Create a coordination item. */
  createItem(input: {
    readonly title: string;
    readonly body: string;
    readonly labels?: readonly string[];
  }): Promise<CollabResult<ItemRef>>;

  /** List items matching a filter. */
  listItems(filter?: ItemFilter): Promise<CollabResult<readonly CollaborationItem[]>>;

  /** Post a comment on an item. */
  postComment(ref: ItemRef, body: string): Promise<CollabResult<CommentRef>>;

  /** Update item state (open ↔ closed). */
  updateItemState(ref: ItemRef, state: ItemState): Promise<CollabResult<void>>;

  /** Add labels to an item. */
  addLabels(ref: ItemRef, labels: readonly string[]): Promise<CollabResult<void>>;

  /** Remove a label from an item. */
  removeLabel(ref: ItemRef, label: string): Promise<CollabResult<void>>;

  // --- Artifacts (committed files / persisted outputs) ---

  /** Write an artifact (file commit, direct write). */
  commitArtifact(input: {
    readonly path: string;
    readonly content: string;
    readonly message: string;
  }): Promise<CollabResult<ArtifactRef>>;

  // --- Signals (read coordination state for agent consumption) ---

  /**
   * Collect signals from the provider's coordination items.
   * Returns items formatted as Signal objects for the agent's wake bundle.
   */
  collectSignals(filter?: ItemFilter): Promise<readonly import("../execution/index.js").Signal[]>;
}
