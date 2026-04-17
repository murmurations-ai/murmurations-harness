/**
 * Parliamentary Governance Plugin
 *
 * Implements Robert's Rules of Order-inspired governance:
 *
 *   - Motions as the driver for all governance work
 *   - Majority vote for decisions (not unanimous consent)
 *   - Quorum requirement (>50% of group members must vote)
 *   - Amendments as first-class governance items
 *   - Formal debate period before voting
 *   - Tabling (defer to future session) as a valid outcome
 *   - 180-day default review cadence on passed motions
 *
 * State graphs:
 *   Motion:    introduced → debated → voted → passed | defeated | tabled | withdrawn
 *   Amendment: proposed → debated → voted → adopted | rejected | withdrawn
 *
 * Terminology:
 *   S3 "tension"     → Parliamentary "motion"
 *   S3 "consent"     → Parliamentary "aye"
 *   S3 "objection"   → Parliamentary "nay"
 *   S3 "circle"      → Parliamentary "committee"
 *   S3 "ratified"    → Parliamentary "passed"
 *
 * Usage:
 *   murmuration start --root ../my-murmuration --governance examples/governance-parliamentary/index.mjs
 */

// ---------------------------------------------------------------------------
// Parliamentary event kinds
// ---------------------------------------------------------------------------

export const PARL_MOTION = "motion";
export const PARL_AMENDMENT = "amendment";
export const PARL_POINT_OF_ORDER = "point-of-order";
export const PARL_TABLE = "table";

// ---------------------------------------------------------------------------
// State graphs
// ---------------------------------------------------------------------------

/** Motion lifecycle — the core parliamentary governance item. */
const MOTION_GRAPH = {
  kind: "motion",
  initialState: "introduced",
  terminalStates: ["passed", "defeated", "withdrawn"],
  defaultReviewDays: 180,
  transitions: [
    // Normal flow: introduce → debate → vote → outcome
    { from: "introduced", to: "debated", trigger: "agent-action" },
    { from: "debated", to: "voted", trigger: "agent-action" },
    { from: "voted", to: "passed", trigger: "majority-aye" },
    { from: "voted", to: "defeated", trigger: "majority-nay" },
    // Tabling: defer to a future session (non-terminal — can be revived)
    { from: "introduced", to: "tabled", trigger: "agent-action" },
    { from: "debated", to: "tabled", trigger: "agent-action" },
    { from: "tabled", to: "introduced", trigger: "agent-action" },
    // Withdrawal
    { from: "introduced", to: "withdrawn", trigger: "agent-action" },
    { from: "debated", to: "withdrawn", trigger: "agent-action" },
    // Timeout: motions stuck in debate for 14 days auto-table
    { from: "debated", to: "tabled", trigger: "timeout", timeoutMs: 14 * 86_400_000 },
    // Timeout: tabled motions expire after 90 days
    { from: "tabled", to: "withdrawn", trigger: "timeout", timeoutMs: 90 * 86_400_000 },
  ],
};

/** Amendment lifecycle — modifies a motion during debate. */
const AMENDMENT_GRAPH = {
  kind: "amendment",
  initialState: "proposed",
  terminalStates: ["adopted", "rejected", "withdrawn"],
  defaultReviewDays: 180,
  transitions: [
    { from: "proposed", to: "debated", trigger: "agent-action" },
    { from: "debated", to: "voted", trigger: "agent-action" },
    { from: "voted", to: "adopted", trigger: "majority-aye" },
    { from: "voted", to: "rejected", trigger: "majority-nay" },
    { from: "proposed", to: "withdrawn", trigger: "agent-action" },
    { from: "debated", to: "withdrawn", trigger: "agent-action" },
  ],
};

// ---------------------------------------------------------------------------
// Plugin implementation
// ---------------------------------------------------------------------------

/** @type {import('@murmurations-ai/core').GovernancePlugin} */
const ParliamentaryGovernancePlugin = {
  name: "parliamentary",
  version: "0.1.0",

  terminology: {
    group: "committee",
    groupPlural: "committees",
    governanceItem: "motion",
    governanceEvent: "motion",
  },

  stateGraphs() {
    return [MOTION_GRAPH, AMENDMENT_GRAPH];
  },

  async onEventsEmitted(batch, _reader) {
    const decisions = [];

    for (const event of batch.events) {
      switch (event.kind) {
        case PARL_MOTION:
        case "agent-governance-event": {
          // Motions go to the chair (Source) for scheduling
          /** @type {import('@murmurations-ai/core').GovernanceRouteTarget[]} */
          const routes = [{ target: "source" }];
          if (event.targetAgentId) {
            routes.push({ target: "agent", agentId: event.targetAgentId });
          }
          decisions.push({
            event,
            routes,
            create: { kind: "motion", payload: event.payload },
          });
          break;
        }

        case PARL_AMENDMENT: {
          // Amendments attach to a motion
          decisions.push({
            event,
            routes: [{ target: "source" }],
            create: { kind: "amendment", payload: event.payload },
          });
          break;
        }

        case PARL_POINT_OF_ORDER: {
          // Points of order go directly to Source (the chair)
          decisions.push({
            event,
            routes: [{ target: "source" }],
          });
          break;
        }

        case PARL_TABLE: {
          // Tabling request — Source decides
          decisions.push({
            event,
            routes: [{ target: "source" }],
          });
          break;
        }

        default: {
          decisions.push({ event, routes: [{ target: "discard" }] });
        }
      }
    }

    return decisions;
  },

  async evaluateAction(agentId, action, context, store /* GovernanceStateReader */) {
    // Parliamentary authorization:
    //   - Actions covered by a passed motion → allow
    //   - Actions requiring a vote → deny until motion passes
    //   - Source (the chair) can always act
    const ctx = typeof context === "object" && context !== null ? context : {};
    const tier = /** @type {string|undefined} */ (/** @type {any} */ (ctx).tier);

    if (!tier || tier === "autonomous") {
      return { allow: true };
    }

    if (tier === "source") {
      return {
        allow: false,
        reason: `Action "${action}" requires the chair's ruling (tier: source).`,
      };
    }

    if (tier === "consent" || tier === "vote") {
      // Check for a passed motion covering this action
      const passed = store.query({ kind: "motion", state: "passed" });
      const covering = passed.find((item) => {
        const payload =
          typeof item.payload === "object" && item.payload !== null ? item.payload : {};
        return /** @type {any} */ (payload).action === action;
      });

      if (covering) {
        return { allow: true };
      }

      return {
        allow: false,
        reason: `Action "${action}" requires a passed motion (tier: vote). Introduce a motion to proceed.`,
      };
    }

    return { allow: true };
  },

  async onDaemonStart(store) {
    const existing = store.query();
    if (existing.length > 0) {
      console.log(`[parliamentary] restored ${String(existing.length)} governance items`);
    }

    const tabled = store.query({ state: "tabled" });
    if (tabled.length > 0) {
      console.log(`[parliamentary] ${String(tabled.length)} motions are tabled — awaiting revival`);
    }

    const due = store.query({ reviewDue: true });
    if (due.length > 0) {
      console.warn(
        `[parliamentary] ${String(due.length)} passed motions are past their review date`,
      );
    }
  },
};

export default ParliamentaryGovernancePlugin;
