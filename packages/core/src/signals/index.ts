/**
 * Signal Aggregator — interface only.
 *
 * The {@link SignalAggregator} interface lives in `@murmuration/core` so
 * the daemon can reference it without depending on any concrete source
 * package. The default implementation lives in `@murmuration/signals`
 * (which depends on `@murmuration/github`) to avoid a package cycle.
 *
 * Phase 1B step B4. Designed by Architecture Agent #23 with an interim
 * trust taxonomy pending Security #25's harness#4 ratification.
 *
 * ## Content/metadata trust separation (prompt-injection seam)
 *
 * Every {@link Signal} has a top-level `trust` field that describes
 * the trust level of its **metadata** (number, title, labels, url,
 * timestamps). Free-form user content fields (`excerpt` on
 * `github-issue` / `inbox-message`, `summary` on `private-note`)
 * must be treated **one step lower** than the metadata trust:
 *
 *   - `trusted`      → body is `semi-trusted`
 *   - `semi-trusted` → body is `untrusted`
 *   - `untrusted`    → body is `untrusted`
 *   - `unknown`      → body is `unknown`
 *
 * This is an **interim** convention pending Security #25's harness#4
 * trust-taxonomy ratification.
 */

import type {
  AgentId,
  AgentRoleFrontmatter,
  CircleId,
  SignalBundle,
  WakeId,
  WakeReason,
} from "../execution/index.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * Well-known signal source identifiers shipped with the harness. These
 * have typed `Signal` variants with structured fields. Operators can
 * declare additional custom source IDs as plain strings — they flow
 * through the `"custom"` Signal variant with an opaque `data` payload.
 */
export type WellKnownSignalSourceId =
  | "github-issue"
  | "private-note"
  | "inbox-message"
  | "pipeline-item"
  | "governance-round"
  | "stall-alert";

/**
 * Any signal source identifier — well-known or operator-defined.
 * Custom sources use the `"custom"` Signal variant and carry an
 * opaque `data` payload the agent interprets. The harness routes
 * them through the same aggregation and cost paths as built-in
 * sources.
 */
export type SignalSourceId = WellKnownSignalSourceId | (string & {});

export interface SignalAggregationContext {
  readonly wakeId: WakeId;
  readonly agentId: AgentId;
  readonly agentDir: string;
  readonly frontmatter: AgentRoleFrontmatter;
  readonly circleMemberships: readonly CircleId[];
  readonly wakeReason: WakeReason;
  readonly now: Date;
}

export type SignalAggregationResult =
  | { readonly ok: true; readonly bundle: SignalBundle }
  | { readonly ok: false; readonly error: SignalAggregatorError };

export type SignalAggregatorErrorCode = "configuration-invalid" | "internal";

export class SignalAggregatorError extends Error {
  public readonly code: SignalAggregatorErrorCode;
  public readonly wakeId: WakeId | undefined;
  public override readonly cause: unknown;
  public constructor(
    message: string,
    options: {
      readonly code: SignalAggregatorErrorCode;
      readonly wakeId?: WakeId;
      readonly cause?: unknown;
    },
  ) {
    super(message);
    this.name = new.target.name;
    this.code = options.code;
    this.wakeId = options.wakeId;
    this.cause = options.cause;
  }
}

export interface SignalAggregatorCapabilities {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly activeSources: readonly SignalSourceId[];
  readonly totalCap: number;
}

export interface SignalAggregator {
  aggregate(context: SignalAggregationContext): Promise<SignalAggregationResult>;
  capabilities(): SignalAggregatorCapabilities;
}

// Legacy re-export for backwards compatibility with the Phase 1A stub.
export const SIGNALS_STUB_VERSION = "0.0.0-phase1b-d" as const;
