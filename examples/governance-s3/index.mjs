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
    { from: "proposal-needed", to: "proposal-needed", trigger: "timeout", timeoutMs: 7 * 86_400_000 },
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

/** @type {import('@murmuration/core').GovernancePlugin} */
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

  async onEventsEmitted(batch, store) {
    const decisions = [];

    for (const event of batch.events) {
      switch (event.kind) {
        case "agent-governance-event":
        case S3_TENSION: {
          // Create a tracked tension item in the store.
          const item = store.create("tension", batch.agentId, event.payload);

          // Route to Source for visibility + to any targeted agent.
          /** @type {import('@murmuration/core').GovernanceRouteTarget[]} */
          const routes = [{ target: "source" }];
          if (event.targetAgentId) {
            routes.push({ target: "agent", agentId: event.targetAgentId });
          }
          decisions.push({ event, routes });
          break;
        }

        case S3_PROPOSAL: {
          // Create a tracked proposal item.
          store.create("proposal", batch.agentId, event.payload);

          // Proposals route to Source for consent round initiation.
          decisions.push({
            event,
            routes: [{ target: "source" }],
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

  async evaluateAction(agentId, action, context, store) {
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
        const payload = typeof item.payload === "object" && item.payload !== null ? item.payload : {};
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
};

export default S3GovernancePlugin;
