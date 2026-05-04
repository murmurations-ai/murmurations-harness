/**
 * Priority-tiered signal bundle composer — Workstream E of v0.7.0
 * Agent Effectiveness.
 *
 * Replaces "15 most-recent" bundles with tiered selection so wake
 * budget goes to the highest-leverage work first. Pure functions over
 * `Signal[]`; integration into the aggregator is a separate change.
 *
 * The four tiers:
 *
 *   - `critical` — paramount items: priority:critical labels,
 *      source-directive + tier:consent in last 24h, awaiting:source-close
 *      (facilitator only)
 *   - `high`     — active consent rounds the agent is named in, fresh
 *      [DIRECTIVE]s with assigned:<self>, [*MEETING]s with the agent
 *      on the agenda
 *   - `normal`   — standard backlog: assigned:<self>, [TENSION] filed
 *      by self, work in flight
 *   - `low`      — open >14d with no recent activity, priority:low,
 *      informational
 *
 * Bundle composition (within total cap of 15):
 *
 *   critical: cap 5 (take all up to 5)
 *   high:     cap 6 (take all up to 6 of remaining budget)
 *   normal:   cap 4 (take most-recent up to remaining budget)
 *   low:      take only if budget remains (typical 0–2)
 *
 * Done-criteria interlock: items where the agent's `done_when`
 * conditions are satisfied are dropped from the candidate set before
 * tiering. This subsumes harness#298 (differential bundles).
 *
 * Priority bumping: skip-count per (agent, item) is tracked
 * externally; this module exposes `bumpTier(tier, skipCount)` so the
 * aggregator can raise an item's floor by one tier per skip.
 *
 * @see ADR-0042 §Part 2
 * @see docs/specs/0001-agent-effectiveness.md §4.2
 */

import type { Signal } from "@murmurations-ai/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The four priority tiers. Order matters — higher index = higher priority. */
export type PriorityTier = "low" | "normal" | "high" | "critical";

const TIER_RANK: Readonly<Record<PriorityTier, number>> = {
  low: 0,
  normal: 1,
  high: 2,
  critical: 3,
};

/** Default per-tier caps. ADR-0042 §Part 2; sum is 15 (the total cap). */
export const DEFAULT_TIER_CAPS: Readonly<Record<PriorityTier, number>> = {
  critical: 5,
  high: 6,
  normal: 4,
  low: 0, // budget-permitting only; see composeBundle
};

/** Default total cap across all tiers. */
export const DEFAULT_TOTAL_CAP = 15;

/**
 * Per-agent context the classifier consults to make tier decisions.
 * Pure data — the classifier never reaches out to GitHub. The
 * aggregator hydrates this once per wake.
 */
export interface ClassifierContext {
  /** This agent's id; used to interpret `assigned:<self>` labels. */
  readonly selfAgentId: string;
  /** The current wake start, used to age-classify items. */
  readonly wakeStartedAt: Date;
  /**
   * True when this agent is the facilitator. Only the facilitator
   * sees `awaiting:source-close` as critical (other agents see it
   * as low — Source's queue, not theirs).
   */
  readonly isFacilitator: boolean;
  /**
   * Issue numbers where this agent is named in an active consent
   * round (typically because they appear in a `members:` field on
   * the issue). Hydrated by the aggregator from the governance store.
   */
  readonly activeConsentRoundIssueNumbers: ReadonlySet<number>;
  /**
   * Issue numbers this agent filed (any type). Used to recognize
   * `[TENSION]` filed by self for `normal` tier.
   */
  readonly issuesFiledBySelf: ReadonlySet<number>;
}

// ---------------------------------------------------------------------------
// Label parsing
// ---------------------------------------------------------------------------

const PRIORITY_CRITICAL_LABEL = "priority:critical";
const PRIORITY_LOW_LABEL = "priority:low";
const SOURCE_DIRECTIVE_LABEL = "source-directive";
const TIER_CONSENT_LABEL = "tier:consent";
const AWAITING_SOURCE_CLOSE_LABEL = "awaiting:source-close";

const ASSIGNED_SELF = (agentId: string): string => `assigned:${agentId}`;

const hasLabel = (signal: Signal, label: string): boolean =>
  signal.kind === "github-issue" && signal.labels.includes(label);

/** Detect bracketed type prefix from issue title. Mirrors closure.ts. */
const extractIssueType = (title: string): string | undefined => {
  const match = /^\s*(\[[^\]]+\])/.exec(title);
  return match?.[1];
};

const isMeetingType = (issueType: string | undefined): boolean =>
  issueType === "[OPERATIONAL MEETING]" ||
  issueType === "[GOVERNANCE MEETING]" ||
  issueType === "[RETROSPECTIVE MEETING]";

const HOURS = 60 * 60 * 1000;
const DAYS = 24 * HOURS;

const ageMs = (signal: Signal, wakeStartedAt: Date): number =>
  wakeStartedAt.getTime() - signal.fetchedAt.getTime();

// ---------------------------------------------------------------------------
// Tier classifier
// ---------------------------------------------------------------------------

/**
 * Classify a single signal into a priority tier.
 *
 * Rules in declaration order — the first matching rule wins. This is
 * deterministic, explainable, and easy to reason about; if a label
 * combination produces an unexpected tier, the rule is in this file.
 *
 * Non-issue signals (private-note, inbox-message, etc.) default to
 * `normal` — they're useful but not paramount, and don't carry the
 * label semantics the rules depend on.
 */
export const classifyTier = (signal: Signal, ctx: ClassifierContext): PriorityTier => {
  if (signal.kind !== "github-issue") {
    return "normal";
  }

  // CRITICAL ----------------------------------------------------------
  if (hasLabel(signal, PRIORITY_CRITICAL_LABEL)) return "critical";

  // source-directive + tier:consent in last 24h
  if (
    hasLabel(signal, SOURCE_DIRECTIVE_LABEL) &&
    hasLabel(signal, TIER_CONSENT_LABEL) &&
    ageMs(signal, ctx.wakeStartedAt) <= 24 * HOURS
  ) {
    return "critical";
  }

  // awaiting:source-close — critical only for the facilitator (it's
  // their pipeline). Other agents see it as low; Source closes it
  // through Spirit, not through their wakes.
  if (hasLabel(signal, AWAITING_SOURCE_CLOSE_LABEL)) {
    return ctx.isFacilitator ? "critical" : "low";
  }

  // HIGH --------------------------------------------------------------
  // Active consent round the agent is named in.
  if (ctx.activeConsentRoundIssueNumbers.has(signal.number)) {
    return "high";
  }

  const issueType = extractIssueType(signal.title);
  const ageDays = ageMs(signal, ctx.wakeStartedAt) / DAYS;

  // [DIRECTIVE] assigned:<self> filed in last 7d
  if (
    issueType === "[DIRECTIVE]" &&
    hasLabel(signal, ASSIGNED_SELF(ctx.selfAgentId)) &&
    ageDays <= 7
  ) {
    return "high";
  }

  // [*MEETING] with the agent in scope. The harness can't easily
  // detect "on the agenda" without parsing the issue body; the
  // proxy is "assigned:<self> on a meeting issue."
  if (isMeetingType(issueType) && hasLabel(signal, ASSIGNED_SELF(ctx.selfAgentId))) {
    return "high";
  }

  // LOW ---------------------------------------------------------------
  if (hasLabel(signal, PRIORITY_LOW_LABEL)) return "low";

  // Open >14d with no recent activity. We approximate "no recent
  // activity" with `fetchedAt`; the aggregator should pass through
  // the issue's `updatedAt` via the signal's fetchedAt to make this
  // accurate. Rule: aged out → low.
  if (ageDays > 14) return "low";

  // NORMAL (default) ---------------------------------------------------
  // - assigned:<self> issues
  // - [TENSION] filed by self
  // - everything else that didn't match a more specific tier
  return "normal";
};

// ---------------------------------------------------------------------------
// Priority bumping
// ---------------------------------------------------------------------------

/**
 * Raise a tier by `skipCount` steps. Cap is `critical`. After two
 * skips at `critical`, the aggregator should escalate (file a
 * verification-failed / stale tension) rather than keep bumping —
 * this function only computes the floor; escalation lives elsewhere.
 *
 *   bumpTier("normal", 0) → "normal"
 *   bumpTier("normal", 1) → "high"
 *   bumpTier("normal", 2) → "critical"
 *   bumpTier("critical", 3) → "critical" (capped)
 */
export const bumpTier = (tier: PriorityTier, skipCount: number): PriorityTier => {
  if (skipCount <= 0) return tier;
  const tiers: readonly PriorityTier[] = ["low", "normal", "high", "critical"];
  const idx = TIER_RANK[tier];
  const bumped = Math.min(idx + skipCount, tiers.length - 1);
  return tiers[bumped] ?? "critical";
};

// ---------------------------------------------------------------------------
// Bundle composer
// ---------------------------------------------------------------------------

export interface BundleComposeOptions {
  /** Cap per tier. Defaults to {@link DEFAULT_TIER_CAPS}. */
  readonly tierCaps?: Readonly<Record<PriorityTier, number>>;
  /** Total cap across all tiers. Defaults to {@link DEFAULT_TOTAL_CAP}. */
  readonly totalCap?: number;
}

export interface TieredBundle {
  /** Picked signals, in tier order: critical → high → normal → low. */
  readonly signals: readonly Signal[];
  /** Per-tier counts of what was actually included. */
  readonly counts: Readonly<Record<PriorityTier, number>>;
  /** How many candidate signals were dropped because the budget filled up. */
  readonly droppedCount: number;
}

/**
 * Compose a tiered bundle from a candidate signal set.
 *
 * Algorithm:
 *
 *   1. Group signals by tier via `classifyTier`.
 *   2. Within each tier, preserve input order (caller is expected to
 *      pass signals sorted most-recent first).
 *   3. Walk tiers high-to-low, taking up to `tierCap` signals from
 *      each, stopping when `totalCap` is reached.
 *
 * `low` is included only if the budget hasn't been exhausted by
 * critical/high/normal — matching the rule "take ONLY if budget
 * remains."
 */
export const composeBundle = (
  candidates: readonly Signal[],
  ctx: ClassifierContext,
  options: BundleComposeOptions = {},
): TieredBundle => {
  const tierCaps = options.tierCaps ?? DEFAULT_TIER_CAPS;
  const totalCap = options.totalCap ?? DEFAULT_TOTAL_CAP;

  const buckets: Record<PriorityTier, Signal[]> = {
    critical: [],
    high: [],
    normal: [],
    low: [],
  };
  for (const signal of candidates) {
    const tier = classifyTier(signal, ctx);
    buckets[tier].push(signal);
  }

  const order: readonly PriorityTier[] = ["critical", "high", "normal", "low"];
  const picked: Signal[] = [];
  const counts: Record<PriorityTier, number> = {
    critical: 0,
    high: 0,
    normal: 0,
    low: 0,
  };

  for (const tier of order) {
    if (picked.length >= totalCap) break;
    // `low` is special: it fills with whatever budget remains rather
    // than respecting a hard tier cap. ADR-0042 §Part 2: "take ONLY
    // if budget remains (typical: 0–2)."
    const remaining = totalCap - picked.length;
    const cap = tier === "low" ? remaining : Math.min(tierCaps[tier], remaining);
    const bucket = buckets[tier];
    for (let i = 0; i < bucket.length && counts[tier] < cap; i++) {
      const sig = bucket[i];
      if (sig === undefined) continue;
      picked.push(sig);
      counts[tier] += 1;
    }
  }

  const droppedCount = candidates.length - picked.length;
  return { signals: picked, counts, droppedCount };
};

// ---------------------------------------------------------------------------
// Done-criteria filter
// ---------------------------------------------------------------------------

/**
 * Drop candidates the aggregator has already evaluated as "done."
 * The filter is just `Set` membership on signal id — the aggregator
 * runs the {@link import("@murmurations-ai/core").validateAccountability}
 * pass against current state and hands us the resulting "done" id
 * set. We don't import the validator here to keep this module
 * dependency-free (it's just signal shaping).
 *
 * Subsumes harness#298 (differential bundles): "differential" =
 * "not yet done", which is exactly the filter output.
 */
export const filterDoneItems = (
  candidates: readonly Signal[],
  doneSignalIds: ReadonlySet<string>,
): readonly Signal[] => candidates.filter((s) => !doneSignalIds.has(s.id));
