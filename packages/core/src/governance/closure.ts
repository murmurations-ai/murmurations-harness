/**
 * Closure rules + verification — Workstream C of v0.7.0 Agent Effectiveness.
 *
 * The harness owns two things:
 *
 *   1. A default closer-role table per issue type (who is allowed to
 *      close `[TENSION]`, `[PROPOSAL]`, `[DIRECTIVE]`, etc.). Plugins
 *      can override per-type via `GovernancePlugin.closerFor`.
 *
 *   2. A default closure-verification check — every close must cite at
 *      least one structural verification (linked closed issue, commit
 *      ref, confirming comment from a circle peer, or an entry in the
 *      agreement registry). Plugins can layer additional checks
 *      (consent quorum, expert weighting, majority tally) via
 *      `GovernancePlugin.verifyClosure`. The harness default runs first;
 *      a failing plugin override blocks closure even if the default
 *      passed.
 *
 * Closure attempt outcomes follow the verification ladder defined in
 * ADR-0041 §Risks:
 *
 *   - `ok`        — close the issue
 *   - `retry`     — apply `verification-failed` label, re-open for one
 *                   retry; the issue had no prior failed attempt
 *   - `escalate`  — second consecutive verification failure; apply
 *                   `awaiting:source-close` label and notify Source
 *
 * @see ADR-0041 Part 3 (closure rule table)
 * @see docs/specs/0001-agent-effectiveness.md §4.2 (closure rules)
 */

import type {
  ClosureEvidence,
  ClosureVerificationResult,
  CloserRole,
  GovernancePlugin,
  IssueSnapshot,
} from "./index.js";

// ---------------------------------------------------------------------------
// Issue-type closer table
// ---------------------------------------------------------------------------

/**
 * Harness default closer per canonical issue type. Mirrors ADR-0041
 * §Part 3. Plugins override per-type via `closerFor`; this map is the
 * fallback when the plugin returns `undefined` or omits the method.
 *
 * Meeting types collapse onto `[*MEETING]` lookups by prefix at
 * resolution time so plugins don't need to enumerate every variant.
 */
const DEFAULT_CLOSER_BY_TYPE: Readonly<Record<string, CloserRole>> = {
  "[TENSION]": "filer",
  "[PROPOSAL]": "facilitator",
  "[DIRECTIVE]": "source",
  "[OPERATIONAL MEETING]": "facilitator",
  "[GOVERNANCE MEETING]": "facilitator",
  "[RETROSPECTIVE MEETING]": "facilitator",
};

/** Fallback when neither plugin nor default-table has an entry. */
const FALLBACK_CLOSER: CloserRole = "responsible";

/**
 * Resolve the closer role for an issue type. Plugin override wins;
 * harness default fills the gap; unknown types fall back to
 * `responsible` (the agent in the `assigned:` label closes).
 *
 * Issue type strings are matched literally (e.g. `"[PROPOSAL]"`).
 * Callers are expected to extract the bracketed prefix before
 * calling — see `extractIssueType`.
 */
export const resolveCloserFor = (
  plugin: Pick<GovernancePlugin, "closerFor"> | undefined,
  issueType: string,
): CloserRole => {
  const fromPlugin = plugin?.closerFor?.(issueType);
  if (fromPlugin !== undefined) return fromPlugin;
  return DEFAULT_CLOSER_BY_TYPE[issueType] ?? FALLBACK_CLOSER;
};

/**
 * Extract the bracketed type prefix from an issue title.
 *
 *   "[PROPOSAL] adopt the new pricing"      → "[PROPOSAL]"
 *   "[OPERATIONAL MEETING] 2026-W18"        → "[OPERATIONAL MEETING]"
 *   "Just an issue with no prefix"          → undefined
 *
 * Bracketed prefix must be at the start of the title; whitespace
 * around the prefix is allowed.
 */
export const extractIssueType = (title: string): string | undefined => {
  const match = /^\s*(\[[^\]]+\])/.exec(title);
  return match?.[1];
};

// ---------------------------------------------------------------------------
// Closure verification
// ---------------------------------------------------------------------------

/**
 * Default verification: at least one structural verification entry is
 * required. The kinds are defined by `Verification` in ./index.ts.
 *
 * This is the harness's universal floor — no closure is allowed
 * without _some_ traceable evidence beyond a comment saying "done."
 * Plugins layer additional checks on top.
 */
export const defaultVerifyClosure = (evidence: ClosureEvidence): ClosureVerificationResult => {
  if (evidence.verifications.length === 0) {
    return {
      ok: false,
      reason:
        "closure requires structural evidence — at least one of: linked closed issue, commit ref, confirming comment, or agreement registry entry",
    };
  }
  return { ok: true };
};

/**
 * Compose the harness default with the plugin's optional override.
 *
 *   1. Run the harness default. If it fails, return immediately —
 *      we never let plugins relax the structural-evidence floor.
 *   2. If the plugin defines `verifyClosure`, run it. Plugin failure
 *      blocks closure even when the default passed.
 *
 * This is the canonical entry point the facilitator calls before
 * closing any issue.
 */
export const verifyClosure = (
  plugin: Pick<GovernancePlugin, "verifyClosure"> | undefined,
  input: {
    readonly issue: IssueSnapshot;
    readonly state: string;
    readonly itemKind: string;
    readonly evidence: ClosureEvidence;
  },
): ClosureVerificationResult => {
  const baseline = defaultVerifyClosure(input.evidence);
  if (!baseline.ok) return baseline;

  const pluginResult = plugin?.verifyClosure?.(input);
  if (pluginResult && !pluginResult.ok) return pluginResult;

  return { ok: true };
};

// ---------------------------------------------------------------------------
// Verification-failure ladder
// ---------------------------------------------------------------------------

/** Labels the facilitator applies in the verification ladder. */
export const VERIFICATION_FAILED_LABEL = "verification-failed";
export const AWAITING_SOURCE_CLOSE_LABEL = "awaiting:source-close";

/**
 * Outcome of a closure attempt — what the facilitator should do next.
 *
 *   - `close`     — verification passed; close the issue
 *   - `retry`     — first failure; apply `verification-failed`,
 *                   re-open or leave open, give the agent another wake
 *                   to gather evidence
 *   - `escalate`  — second consecutive failure; apply
 *                   `awaiting:source-close`, notify Source via
 *                   `[FACILITATOR LOG]`
 */
export type ClosureAttemptOutcome =
  | { readonly action: "close"; readonly evidence: ClosureEvidence }
  | { readonly action: "retry"; readonly reason: string }
  | { readonly action: "escalate"; readonly reason: string };

/**
 * Decide what to do with a closure attempt given the verification
 * result + the issue's prior label history.
 *
 * The "prior failure" signal is a label on the live issue: if the
 * issue already carries `verification-failed`, this is the second
 * (or later) attempt and we escalate. Otherwise we mark it failed
 * and the facilitator re-attempts on the next wake.
 *
 * Verification _passing_ when the issue still wears
 * `verification-failed` is treated as a clean close — the previous
 * failure is consumed by the successful attempt. The facilitator is
 * responsible for removing the label as part of the close.
 */
export const classifyClosureAttempt = (input: {
  readonly verification: ClosureVerificationResult;
  readonly issue: Pick<IssueSnapshot, "labels">;
  readonly evidence: ClosureEvidence;
}): ClosureAttemptOutcome => {
  if (input.verification.ok) {
    return { action: "close", evidence: input.evidence };
  }

  const hasPriorFailure = input.issue.labels.includes(VERIFICATION_FAILED_LABEL);
  if (hasPriorFailure) {
    return {
      action: "escalate",
      reason: `${input.verification.reason} (second consecutive verification failure — escalating)`,
    };
  }

  return {
    action: "retry",
    reason: input.verification.reason,
  };
};
