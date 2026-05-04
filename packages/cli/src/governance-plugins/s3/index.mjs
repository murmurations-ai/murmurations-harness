/**
 * Self-Organizing (S3) Governance Plugin
 *
 * First concrete governance plugin for the Murmuration Harness.
 * Implements Sociocracy 3.0 patterns:
 *
 *   - Tensions as the driver for all governance work
 *   - Consent rounds for decision-making (no objections = approved)
 *   - Circle-based routing (tensions route to circle lead or Source)
 *   - 90-day default review cadence on all ratified decisions
 *
 * State graph:
 *   open → deliberating → consent-round → resolved | withdrawn
 *
 * Usage:
 *   murmuration start --root ../my-murmuration --governance examples/governance-s3/index.mjs
 *
 * This is an example plugin — it lives in examples/ because the
 * governance model is a choice the operator makes, not a harness
 * default. The harness ships with NoOpGovernancePlugin; the operator
 * opts into S3 (or any other model) via the --governance flag.
 */

// ---------------------------------------------------------------------------
// S3 event kinds
// ---------------------------------------------------------------------------

/** Well-known S3 governance event kinds. Agents emit these via the
 *  `::governance::<kind>:: <payload>` subprocess protocol or via
 *  the in-process runner's governanceEvents return value. */
export const S3_TENSION = "tension";
export const S3_PROPOSAL = "proposal-opened";
export const S3_NOTIFY = "notify";
export const S3_AUTONOMOUS_ACTION = "autonomous-action";
export const S3_HELD = "held";

// ---------------------------------------------------------------------------
// S3 state graphs
// ---------------------------------------------------------------------------

/**
 * Tension lifecycle — the driver for governance work.
 * A tension is NOT decided on directly — it's resolved when a
 * proposal addressing it is ratified. The tension tracks awareness,
 * not decisions.
 *
 *   open → proposal-needed → resolved (proposal ratified)
 *        → withdrawn
 */
const TENSION_GRAPH = {
  kind: "tension",
  initialState: "open",
  terminalStates: ["resolved", "withdrawn"],
  defaultReviewDays: 90,
  transitions: [
    { from: "open", to: "proposal-needed", trigger: "agent-action" },
    { from: "proposal-needed", to: "resolved", trigger: "agent-action" },
    { from: "open", to: "resolved", trigger: "agent-action" },
    { from: "open", to: "withdrawn", trigger: "agent-action" },
    { from: "proposal-needed", to: "withdrawn", trigger: "agent-action" },
    // Timeout: tensions without a proposal for 7 days escalate to Source
    {
      from: "proposal-needed",
      to: "proposal-needed",
      trigger: "timeout",
      timeoutMs: 7 * 86_400_000,
    },
  ],
};

/**
 * Proposal lifecycle — a formalized response to a tension.
 * This is where consent happens. The circle deliberates, then
 * runs a consent round. No objections = ratified.
 *
 *   drafted → deliberating → consent-round → ratified
 *                           ↗ (objection)  ← consent-round → back to deliberating
 *           → rejected
 *           → withdrawn
 */
const PROPOSAL_GRAPH = {
  kind: "proposal",
  initialState: "drafted",
  terminalStates: ["ratified", "rejected", "withdrawn"],
  defaultReviewDays: 90,
  transitions: [
    { from: "drafted", to: "deliberating", trigger: "agent-action" },
    { from: "deliberating", to: "consent-round", trigger: "agent-action" },
    { from: "consent-round", to: "ratified", trigger: "consent-achieved" },
    { from: "consent-round", to: "deliberating", trigger: "objection-raised" },
    { from: "consent-round", to: "rejected", trigger: "agent-action" },
    { from: "drafted", to: "withdrawn", trigger: "agent-action" },
    { from: "deliberating", to: "withdrawn", trigger: "agent-action" },
    // Timeout: deliberation stuck for 7 days escalates
    { from: "deliberating", to: "deliberating", trigger: "timeout", timeoutMs: 7 * 86_400_000 },
  ],
};

// ---------------------------------------------------------------------------
// S3 Plugin implementation
// ---------------------------------------------------------------------------

/** @type {import('@murmurations-ai/core').GovernancePlugin} */
const S3GovernancePlugin = {
  name: "self-organizing",
  version: "0.1.0",

  terminology: {
    group: "circle",
    groupPlural: "circles",
    governanceItem: "proposal",
    governanceEvent: "tension",
  },

  stateGraphs() {
    return [TENSION_GRAPH, PROPOSAL_GRAPH];
  },

  /**
   * S3 treats these verbs in a tally recommendation as resolving a
   * governance item. Substring match so "we ratify" / "will approve" /
   * "consent with concern" all trigger. Used by the daemon to decide
   * whether to advance the item to its terminal state.
   */
  isResolvingRecommendation(recommendation) {
    const verbs = ["resolve", "ratif", "approve", "adopt", "agree", "pass", "consent"];
    const lower = String(recommendation).toLowerCase();
    return verbs.some((v) => lower.includes(v));
  },

  async onEventsEmitted(batch, _reader) {
    const decisions = [];

    for (const event of batch.events) {
      // Generic "agent-governance-event" from core: parse the model-
      // specific prefix from payload.topic to decide the item kind.
      // "PROPOSAL:" → proposal-opened, "TENSION:" → tension,
      // "REPORT:" → report. Unprefixed defaults to tension (the
      // zero-ceremony path for agents who don't know the taxonomy).
      let resolvedKind = event.kind;
      let resolvedPayload = event.payload;
      if (event.kind === "agent-governance-event") {
        const topic =
          typeof event.payload === "object" &&
          event.payload !== null &&
          typeof event.payload.topic === "string"
            ? event.payload.topic
            : "";
        let kind = S3_TENSION;
        let trimmed = topic;
        if (topic.startsWith("PROPOSAL:")) {
          kind = S3_PROPOSAL;
          trimmed = topic.slice("PROPOSAL:".length).trim();
        } else if (topic.startsWith("TENSION:")) {
          kind = S3_TENSION;
          trimmed = topic.slice("TENSION:".length).trim();
        } else if (topic.startsWith("REPORT:")) {
          kind = "report";
          trimmed = topic.slice("REPORT:".length).trim();
        }
        resolvedKind = kind;
        resolvedPayload = { ...event.payload, topic: trimmed };
      }

      switch (resolvedKind) {
        case S3_TENSION: {
          // Route to Source for visibility + to any targeted agent.
          /** @type {import('@murmurations-ai/core').GovernanceRouteTarget[]} */
          const routes = [{ target: "source" }];
          if (event.targetAgentId) {
            routes.push({ target: "agent", agentId: event.targetAgentId });
          }
          decisions.push({
            event,
            routes,
            create: { kind: "tension", payload: resolvedPayload },
          });
          break;
        }

        case S3_PROPOSAL: {
          // Proposals route to Source for consent round initiation.
          decisions.push({
            event,
            routes: [{ target: "source" }],
            create: { kind: "proposal", payload: resolvedPayload },
          });
          break;
        }

        case S3_NOTIFY: {
          // Notify events go to the targeted agent (or Source if no target).
          if (event.targetAgentId) {
            decisions.push({
              event,
              routes: [{ target: "agent", agentId: event.targetAgentId }],
            });
          } else {
            decisions.push({
              event,
              routes: [{ target: "source" }],
            });
          }
          break;
        }

        case S3_AUTONOMOUS_ACTION: {
          // Autonomous actions are logged for Source audit trail.
          decisions.push({
            event,
            routes: [{ target: "source" }],
          });
          break;
        }

        case S3_HELD: {
          // Held items escalate to Source immediately.
          decisions.push({
            event,
            routes: [{ target: "source" }],
          });
          break;
        }

        default: {
          // Unknown governance event kind — discard silently.
          // The harness is extensible; other plugins may handle this kind.
          decisions.push({ event, routes: [{ target: "discard" }] });
        }
      }
    }

    return decisions;
  },

  async evaluateAction(agentId, action, context, store /* GovernanceStateReader */) {
    // S3 authorization: check whether a ratified governance item
    // covers the requested action.
    //
    // The `context` object may carry a `tier` field ("autonomous",
    // "notify", "consent", "source") from the agent's role.md
    // decision-tiers section. The plugin uses this to decide whether
    // the store needs a ratified item or the agent can proceed.
    //
    // Flow:
    //   tier "autonomous" → always allow
    //   tier "notify"     → allow + (caller logs)
    //   tier "consent"    → check store for ratified proposal
    //                       covering this action → allow if found,
    //                       deny if not
    //   tier "source"     → deny (requires explicit Source approval)
    //   no tier specified → allow (backward compat / NoOp fallback)

    const ctx = typeof context === "object" && context !== null ? context : {};
    const tier = /** @type {string|undefined} */ (/** @type {any} */ (ctx).tier);

    if (!tier || tier === "autonomous" || tier === "notify") {
      return { allow: true };
    }

    if (tier === "source") {
      return {
        allow: false,
        reason: `action "${action}" requires explicit Source approval (tier: source)`,
      };
    }

    if (tier === "consent") {
      // Look for a ratified proposal that covers this action.
      // We match on `payload.action` in the governance item.
      const ratified = store.query({ kind: "proposal", state: "ratified" });
      const covering = ratified.find((item) => {
        const payload =
          typeof item.payload === "object" && item.payload !== null ? item.payload : {};
        return /** @type {any} */ (payload).action === action;
      });

      if (covering) {
        return { allow: true };
      }

      return {
        allow: false,
        reason: `action "${action}" requires a ratified consent-round proposal (tier: consent). Open a [CONSENT] issue to start the round.`,
      };
    }

    // Unknown tier — allow with a warning (forward compatibility).
    return { allow: true };
  },

  async onDaemonStart(store) {
    // Log how many governance items survived from a previous session
    // (will be zero until the durable store is implemented).
    const existing = store.query();
    if (existing.length > 0) {
      console.log(`[s3-governance] restored ${String(existing.length)} governance items`);
    }

    // Check for items due for review.
    const due = store.query({ reviewDue: true });
    if (due.length > 0) {
      console.warn(
        `[s3-governance] ${String(due.length)} governance items are past their review date`,
      );
    }
  },

  // ---------------------------------------------------------------------
  // v0.7.0 — facilitator-callable methods (ADR-0041)
  // ---------------------------------------------------------------------

  /**
   * S3 default closer assignments per issue type.
   * - [TENSION]: filer closes their own when resolved
   * - [PROPOSAL]: facilitator closes after consent quorum + verification
   * - [*MEETING]: facilitator closes after agenda items advance
   * - [DIRECTIVE]: Source closes (facilitator labels awaiting:source-close)
   * - [other]: agent named in `assigned:` label closes when done
   */
  closerFor(issueType) {
    if (issueType === "[TENSION]") return "filer";
    if (issueType === "[PROPOSAL]") return "facilitator";
    if (issueType === "[OPERATIONAL MEETING]") return "facilitator";
    if (issueType === "[GOVERNANCE MEETING]") return "facilitator";
    if (issueType === "[RETROSPECTIVE MEETING]") return "facilitator";
    if (issueType === "[DIRECTIVE]") return "source";
    return "responsible";
  },

  /**
   * Compute next state for an S3 governance item.
   *
   * Tensions advance when filer comments resolution evidence; proposals
   * advance when the comment thread reflects a consent round outcome
   * (quorum consents → ratified; any unintegrated objection → back to
   * deliberating).
   *
   * Returns null when no transition applies (waiting on positions,
   * quorum not reached, etc.).
   */
  async computeNextState(input) {
    const { currentState, itemKind, issue, circleMembers } = input;
    const positions = collectS3Positions(issue.comments);

    if (itemKind === "tension") {
      // Filer's own resolution comment with linked closed issue → resolved.
      const filerPositions = issue.authorAgentId
        ? positions.filter((p) => p.author === issue.authorAgentId.value)
        : [];
      const resolvedByFiler = filerPositions.some(
        (p) => p.position === "resolve" && p.cites.length > 0,
      );
      if (resolvedByFiler && currentState !== "resolved") {
        return { next: "resolved", reason: "tension filer cited resolution evidence" };
      }
      // Any "withdraw" by filer → withdrawn.
      const withdrawnByFiler = filerPositions.some((p) => p.position === "withdraw");
      if (withdrawnByFiler && currentState !== "withdrawn") {
        return { next: "withdrawn", reason: "tension filer withdrew" };
      }
      return null;
    }

    if (itemKind === "proposal") {
      // Quorum-aware advancement. An unintegrated objection bounces
      // the proposal back to deliberating (where it waits for a new
      // round). Consent quorum (majority of named circle members)
      // proposes ratified.
      const memberValues = new Set(circleMembers.map((m) => m.value));
      const memberPositions = positions.filter((p) => memberValues.has(p.author));

      const objections = memberPositions.filter((p) => p.position === "object" && !p.integrated);
      if (objections.length > 0 && currentState === "consent-round") {
        return {
          next: "deliberating",
          reason: `${String(objections.length)} unintegrated objection(s) raised`,
        };
      }

      const consents = memberPositions.filter((p) => p.position === "consent");
      const quorum = Math.ceil(circleMembers.length / 2);
      if (
        consents.length >= quorum &&
        objections.length === 0 &&
        (currentState === "consent-round" || currentState === "deliberating")
      ) {
        return {
          next: "ratified",
          reason: `consent quorum reached (${String(consents.length)}/${String(circleMembers.length)})`,
        };
      }
      return null;
    }

    return null;
  },

  /**
   * S3 closure verification — layered on top of the harness default.
   *
   * For proposals: must be in `ratified` or `withdrawn` terminal state.
   * For tensions: must be in `resolved` or `withdrawn`. Plus the harness
   * default structural-evidence check (which the caller composes
   * separately).
   */
  verifyClosure(input) {
    const { state, itemKind, evidence } = input;
    const expectedTerminals = {
      proposal: ["ratified", "withdrawn", "rejected"],
      tension: ["resolved", "withdrawn"],
    };
    const validTerminals = expectedTerminals[itemKind];
    if (validTerminals && !validTerminals.includes(state)) {
      return {
        ok: false,
        reason: `S3 closure for ${itemKind} requires terminal state, got "${state}"`,
      };
    }
    if (evidence.verifications.length === 0) {
      return {
        ok: false,
        reason:
          "S3 closure requires at least one structural verification (linked closed issue, commit ref, confirming comment, or agreement entry)",
      };
    }
    return { ok: true };
  },
};

// ---------------------------------------------------------------------------
// S3 helper — parse positions from comment text
// ---------------------------------------------------------------------------

/**
 * @typedef {{author: string, position: "consent"|"object"|"amend"|"resolve"|"withdraw", integrated: boolean, cites: string[]}} S3Position
 */

/**
 * Extract S3 positions from a list of issue comments. One position per
 * comment when matched; comments without a clear position are ignored.
 * @param {ReadonlyArray<{authorAgentId?: {value: string}, body: string}>} comments
 * @returns {S3Position[]}
 */
function collectS3Positions(comments) {
  /** @type {S3Position[]} */
  const out = [];
  for (const c of comments) {
    if (!c.authorAgentId) continue;
    const text = String(c.body);
    const lower = text.toLowerCase();
    /** @type {S3Position["position"] | null} */
    let position = null;
    // Order matters: check object before consent because "no objection"
    // contains "object" but is not an objection.
    if (/(?<!no )(object|block|veto)/i.test(lower)) position = "object";
    else if (/withdraw/i.test(lower)) position = "withdraw";
    else if (/(consent|ratify|approve|adopt|agree)/i.test(lower)) position = "consent";
    else if (/(amend|integrate.*concern|with concern)/i.test(lower)) position = "amend";
    else if (/(resolved|resolution)/i.test(lower) && !/unresolved/i.test(lower))
      position = "resolve";
    if (!position) continue;
    const integrated = /\bintegrated\b|\baddressed\b|\bresolved\b/i.test(lower);
    const cites = (text.match(/#\d+/g) ?? []).map((s) => s.slice(1));
    out.push({ author: c.authorAgentId.value, position, integrated, cites });
  }
  return out;
}

export default S3GovernancePlugin;
