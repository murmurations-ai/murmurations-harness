/**
 * Label vocabulary library — single source of truth for every label
 * string the harness writes or matches on GitHub issues.
 *
 * Why this exists:
 *
 * Before this module, label strings drifted across the codebase. Eight
 * separate sites wrote `"source-directive"` as a literal. Two packages
 * each defined their own `AWAITING_SOURCE_CLOSE_LABEL` constant — and
 * one of them was already misspelled relative to the other. The cost
 * showed up at runtime: directives written with `scope:agent:<id>` were
 * invisible to a signal aggregator filter looking for `assigned:<id>`,
 * because the two halves of the codebase had drifted to incompatible
 * vocabularies (chinook-wind live test, 2026-05-05).
 *
 * Rule going forward:
 *
 * **NO PACKAGE MAY HARDCODE A LABEL STRING.** Import from this module —
 * either a constant for fixed labels, a factory for parameterized labels,
 * or a predicate for matching. If a new label is needed, add it here
 * first, then use it. The lint rule (Workstream — TBD) will eventually
 * fail any source file that contains a label-shaped literal.
 *
 * Scope:
 *
 * The labels in this module are *harness-universal* — they apply to
 * every murmuration regardless of governance plugin. Plugin-specific
 * labels (e.g. S3's `tier:autonomous`/`tier:notify`/`tier:consent`)
 * are exposed here for now because they're written by enough call
 * sites that drift was a real risk; v0.8.0 will migrate them into the
 * S3 plugin via `GovernancePlugin.labelVocabulary()` (added v0.7.1,
 * harness#337).
 */

// ---------------------------------------------------------------------------
// Static labels — fixed strings with no parameters.
// ---------------------------------------------------------------------------

/** Source-issued directive (filed via `murmuration directive`). */
export const SOURCE_DIRECTIVE_LABEL = "source-directive";

/** Work assignment for an agent — used by signal aggregator action-item partitioning. */
export const ACTION_ITEM_LABEL = "action-item";

/** Item is closed by the agent but waiting for Source to confirm/close. */
export const AWAITING_SOURCE_CLOSE_LABEL = "awaiting:source-close";

/** Directive scope: every agent in the murmuration. */
export const SCOPE_ALL_LABEL = "scope:all";

/** Onboarding kickoff workflow (used by #332 source-onboarding skill). */
export const KICKOFF_LABEL = "kickoff";

/**
 * Closure verification ladder: applied when a facilitator attempts to
 * close an action item but the agent's `done_when` evidence didn't
 * verify. Second consecutive failure escalates to `awaiting:source-close`.
 */
export const VERIFICATION_FAILED_LABEL = "verification-failed";

// ---------------------------------------------------------------------------
// Factories — labels parameterized by agent / group / kind.
// ---------------------------------------------------------------------------

/**
 * Action-item routing label. Issues tagged with this label appear in
 * the agent's `actionItems` partition of its signal bundle.
 *
 * @example assignedLabel("rentals-agent") → "assigned:rentals-agent"
 */
export const assignedLabel = (agentId: string): string => `assigned:${agentId}`;

/**
 * Per-agent directive scope label. Routes a Source directive to a
 * specific agent's signal bundle.
 *
 * @example scopeAgentLabel("rentals-agent") → "scope:agent:rentals-agent"
 */
export const scopeAgentLabel = (agentId: string): string => `scope:agent:${agentId}`;

/**
 * Per-group directive scope label. Routes a Source directive to every
 * agent that lists the group in its `role.md` `group_memberships`.
 *
 * @example scopeGroupLabel("partnership") → "scope:group:partnership"
 */
export const scopeGroupLabel = (groupId: string): string => `scope:group:${groupId}`;

/**
 * Circle-membership label. Written by Source or agents when filing a
 * governance proposal meant for a specific group (e.g. S3 consent round,
 * tension, meeting agenda item). Matched by every agent that lists the
 * group in its `group_memberships` via the routing OR-set.
 *
 * NOT reserved — agents may write this label to file circle-scoped
 * proposals without requiring Source to fan out `assigned:<member>`
 * labels for each member individually.
 *
 * @example circleLabel("engineering") → "circle:engineering"
 */
export const circleLabel = (groupId: string): string => `circle:${groupId}`;

// ---------------------------------------------------------------------------
// Predicates + parsers — for matching and extraction.
// ---------------------------------------------------------------------------

/** True if the label is any kind of `assigned:<...>` action-item routing label. */
export const isAssignedLabel = (label: string): boolean => label.startsWith("assigned:");

/** True if the label is any kind of `scope:<...>` directive routing label. */
export const isScopeLabel = (label: string): boolean => label.startsWith("scope:");

/** True if the label is any kind of `circle:<...>` group-membership proposal label. */
export const isCircleLabel = (label: string): boolean => label.startsWith("circle:");

/**
 * True if the label is reserved for Source / harness-internal use and
 * MUST NOT be written by an agent action.
 *
 * Reserved set:
 *   - `source-directive` — promotes an issue to directive trust at every
 *     downstream agent in the routing OR-set. Only Source (via the
 *     `murmuration directive` CLI) writes this.
 *   - `kickoff` — onboarding workflow trigger; only Source / Spirit writes.
 *   - `scope:*` — routing labels for directive distribution. Combined with
 *     `source-directive` they form the lateral-movement channel; agents
 *     route work via `assigned:<id>` / `action-item` instead.
 *
 * Allowed for agent writes (NOT reserved):
 *   - `assigned:<id>` and `action-item` — the legitimate work-routing
 *     vocabulary used by group facilitators and the closure ladder.
 *   - `awaiting:source-close`, `verification-failed` — written by the
 *     closure verification ladder during normal agent operation.
 *
 * Lateral-movement defense (security review H1, harness#331 follow-up):
 * the membership-aware aggregator now actively listens for `scope:*`
 * labels, so the write-side must refuse agent-originated writes of those
 * labels to prevent agent-to-agent directive forgery.
 */
export const isReservedLabel = (label: string): boolean =>
  label === SOURCE_DIRECTIVE_LABEL || label === KICKOFF_LABEL || isScopeLabel(label);

/**
 * Returns the subset of `labels` that are reserved per `isReservedLabel`.
 * Used by WakeAction / MeetingAction dispatchers to reject agent-originated
 * writes of routing labels.
 */
export const findReservedLabels = (labels: readonly string[]): readonly string[] =>
  labels.filter(isReservedLabel);

/** Returns the agent-id from `assigned:<agent-id>`, or null if not a match. */
export const parseAssignedLabel = (label: string): string | null =>
  label.startsWith("assigned:") ? label.slice("assigned:".length) : null;

/** Returns the agent-id from `scope:agent:<agent-id>`, or null if not a match. */
export const parseScopeAgentLabel = (label: string): string | null =>
  label.startsWith("scope:agent:") ? label.slice("scope:agent:".length) : null;

/** Returns the group-id from `scope:group:<group-id>`, or null if not a match. */
export const parseScopeGroupLabel = (label: string): string | null =>
  label.startsWith("scope:group:") ? label.slice("scope:group:".length) : null;

/** Returns the group-id from `circle:<group-id>`, or null if not a match. */
export const parseCircleLabel = (label: string): string | null =>
  label.startsWith("circle:") ? label.slice("circle:".length) : null;

// ---------------------------------------------------------------------------
// Routing — membership-aware label set for an agent.
// ---------------------------------------------------------------------------

/**
 * The complete set of routing labels that an agent should match on
 * when polling GitHub for relevant work. Used by the signal aggregator
 * to filter issues membership-aware (chinook-wind live-test fix,
 * harness#331 / #235).
 *
 * Order: most-specific first (action items addressed to this agent),
 * then directive scopes (per-agent, per-group, broadcast). The
 * `circle:<groupId>` labels follow `scope:group:<groupId>` — they
 * match governance proposals filed by Source or agents with the
 * `circle:` convention (tension #788: proposals bypassing the
 * directive CLI weren't reaching circle members).
 *
 * The aggregator queries each label independently and dedupes by issue
 * number, so the order here doesn't affect correctness — it only
 * affects which query fires first when scopes are batched.
 *
 * @example buildAgentRoutingLabels("rentals-agent", ["partnership"])
 *   → ["assigned:rentals-agent", "scope:agent:rentals-agent",
 *      "scope:group:partnership", "circle:partnership", "scope:all"]
 */
export const buildAgentRoutingLabels = (
  agentId: string,
  groupIds: readonly string[],
): readonly string[] => [
  assignedLabel(agentId),
  scopeAgentLabel(agentId),
  ...groupIds.map(scopeGroupLabel),
  ...groupIds.map(circleLabel),
  SCOPE_ALL_LABEL,
];

// ---------------------------------------------------------------------------
// S3-flavored governance labels.
//
// These labels are written and matched by enough sites in core +
// signals + cli that drift was a real risk before this module. They
// live here for now even though they're S3-specific (`tier:*` is an
// S3 vocabulary; other governance plugins use their own decision
// taxonomies). Plugin-owned label vocabularies are a v0.8.0+ design
// item — they will migrate to the S3 plugin's `labelVocabulary()` in v0.8.0.
// ---------------------------------------------------------------------------

/** S3 decision tier: agent acts without notifying Source. */
export const TIER_AUTONOMOUS_LABEL = "tier:autonomous";

/** S3 decision tier: agent acts, then notifies Source. */
export const TIER_NOTIFY_LABEL = "tier:notify";

/** S3 decision tier: agent proposes, Source must consent before action. */
export const TIER_CONSENT_LABEL = "tier:consent";
