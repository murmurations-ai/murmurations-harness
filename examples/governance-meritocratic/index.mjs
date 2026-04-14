/**
 * Meritocratic Governance Plugin
 *
 * Expertise-weighted governance:
 *
 *   - Agents with domain expertise have more influence
 *   - Flags (issues) are reviewed by the most qualified agents
 *   - Domain experts can approve within their area; cross-domain needs Source
 *   - Proven track record (artifact rate, effectiveness) increases weight
 *   - 60-day review cadence
 *
 * State graphs:
 *   Flag:     raised → reviewed → approved | deferred | dismissed
 *   Standard: proposed → reviewed → adopted | rejected
 *
 * Terminology:
 *   S3 "tension"     → Meritocratic "flag"
 *   S3 "proposal"    → Meritocratic "standard"
 *   S3 "consent"     → Meritocratic "expert-approval"
 *   S3 "circle"      → Meritocratic "guild"
 *
 * Usage:
 *   murmuration start --root ../my-murmuration --governance examples/governance-meritocratic/index.mjs
 */

export const MERIT_FLAG = "flag";
export const MERIT_STANDARD = "standard";
export const MERIT_ENDORSEMENT = "endorsement";

const FLAG_GRAPH = {
  kind: "flag",
  initialState: "raised",
  terminalStates: ["approved", "dismissed"],
  defaultReviewDays: 60,
  transitions: [
    { from: "raised", to: "reviewed", trigger: "expert-review" },
    { from: "reviewed", to: "approved", trigger: "expert-approval" },
    { from: "reviewed", to: "deferred", trigger: "agent-action" },
    { from: "reviewed", to: "dismissed", trigger: "expert-rejection" },
    { from: "deferred", to: "reviewed", trigger: "agent-action" },
    { from: "raised", to: "dismissed", trigger: "agent-action" },
    // Timeout: unreviewed flags escalate after 5 days
    { from: "raised", to: "raised", trigger: "timeout", timeoutMs: 5 * 86_400_000 },
  ],
};

const STANDARD_GRAPH = {
  kind: "standard",
  initialState: "proposed",
  terminalStates: ["adopted", "rejected"],
  defaultReviewDays: 60,
  transitions: [
    { from: "proposed", to: "reviewed", trigger: "expert-review" },
    { from: "reviewed", to: "adopted", trigger: "expert-approval" },
    { from: "reviewed", to: "rejected", trigger: "expert-rejection" },
    { from: "reviewed", to: "proposed", trigger: "agent-action" },
    { from: "proposed", to: "rejected", trigger: "agent-action" },
  ],
};

/** @type {import('@murmurations-ai/core').GovernancePlugin} */
const MeritocraticPlugin = {
  name: "meritocratic",
  version: "0.1.0",

  terminology: {
    group: "guild",
    groupPlural: "guilds",
    governanceItem: "standard",
    governanceEvent: "flag",
  },

  stateGraphs() {
    return [FLAG_GRAPH, STANDARD_GRAPH];
  },

  async onEventsEmitted(batch, store) {
    const decisions = [];
    for (const event of batch.events) {
      switch (event.kind) {
        case MERIT_FLAG:
        case "agent-governance-event": {
          store.create("flag", batch.agentId, event.payload);
          // Flags route to the guild lead + Source
          const routes = [{ target: "source" }];
          if (event.targetAgentId) {
            routes.push({ target: "agent", agentId: event.targetAgentId });
          }
          decisions.push({ event, routes });
          break;
        }
        case MERIT_STANDARD: {
          store.create("standard", batch.agentId, event.payload);
          decisions.push({ event, routes: [{ target: "source" }] });
          break;
        }
        case MERIT_ENDORSEMENT: {
          // Endorsements route to the item's author
          if (event.targetAgentId) {
            decisions.push({ event, routes: [{ target: "agent", agentId: event.targetAgentId }] });
          } else {
            decisions.push({ event, routes: [{ target: "source" }] });
          }
          break;
        }
        default:
          decisions.push({ event, routes: [{ target: "discard" }] });
      }
    }
    return decisions;
  },

  async evaluateAction(agentId, action, context, store) {
    const ctx = typeof context === "object" && context !== null ? context : {};
    const tier = /** @type {string|undefined} */ (/** @type {any} */ (ctx).tier);

    if (!tier || tier === "autonomous") return { allow: true };

    if (tier === "source") {
      return {
        allow: false,
        reason: `Action "${action}" requires guild expert consensus (tier: source).`,
      };
    }

    if (tier === "consent" || tier === "expert") {
      // Check for an adopted standard covering this action
      const adopted = store.query({ kind: "standard", state: "adopted" });
      const covering = adopted.find((item) => {
        const payload =
          typeof item.payload === "object" && item.payload !== null ? item.payload : {};
        return /** @type {any} */ (payload).action === action;
      });
      if (covering) return { allow: true };
      return {
        allow: false,
        reason: `Action "${action}" requires an adopted guild standard or expert approval.`,
      };
    }

    return { allow: true };
  },

  async onDaemonStart(store) {
    const existing = store.query();
    if (existing.length > 0) {
      console.log(`[meritocratic] restored ${String(existing.length)} governance items`);
    }
  },
};

export default MeritocraticPlugin;
