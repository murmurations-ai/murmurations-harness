/**
 * Governance plugin runtime — pluggable boundary for full decision lifecycle.
 *
 * STUB: the final GovernancePlugin interface is being designed under
 * Issue #2 (GovernancePlugin interface hardening). Do not rely on the
 * shape of these types. TypeScript / Runtime Agent (#24) owns closing
 * the tension before Phase 3 begins.
 *
 * Current sketch (from spec §8.1):
 *   - onTension, onProposalOpened, onAgentResponse, onNotify,
 *     onAutonomousAction, onHeld
 *   - runConsentRound
 *   - getTimeoutPolicy
 *   - ratify
 *
 * Event types, round types, timeout policies, and error taxonomy
 * must be defined, pinned, and exported before Phase 3.
 */

export type EventType = "tension" | "proposal-opened" | "notify" | "autonomous-action" | "held";
// TODO(#2): expand; add discriminated unions per event type per kind.

/**
 * Placeholder GovernancePlugin interface.
 *
 * TODO(#2): finalize signatures, error semantics, and plugin-load
 * compatibility check before Phase 3 S3 plugin extraction.
 * TODO(#4): define capability declarations (Security #25 carry-forward).
 */
export interface GovernancePlugin {
  readonly name: string;
  readonly version: string;
  // TODO(#2): full lifecycle methods
  // TODO(#4): capabilities: Capability[]
}

export const GOVERNANCE_STUB_VERSION = "0.0.0-stub" as const;
