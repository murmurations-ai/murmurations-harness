/**
 * Consensus Governance Plugin
 *
 * Full-consensus governance — every member must agree:
 *
 *   - Proposals require unanimous agreement (not just no objections)
 *   - Any member can block, and blocks must be addressed
 *   - Longer deliberation periods (consensus takes time)
 *   - Stand-aside (disagree but don't block) is a valid position
 *   - Temperature checks before formal consensus rounds
 *   - 120-day review cadence (longer — consensus is hard-won)
 *
 * State graphs:
 *   Proposal: raised → temperature-check → deliberation → consensus-round → agreed | blocked | withdrawn
 *   Concern:  raised → addressed → resolved | withdrawn
 *
 * Key difference from S3: S3 uses consent (no objections = pass).
 * Consensus requires active agreement from every member. A single
 * block halts progress until the concern is addressed.
 *
 * Terminology:
 *   S3 "tension"     → Consensus "concern"
 *   S3 "proposal"    → Consensus "proposal"
 *   S3 "consent"     → Consensus "agree"
 *   S3 "objection"   → Consensus "block"
 *   S3 "circle"      → Consensus "assembly"
 *
 * Usage:
 *   murmuration start --root ../my-murmuration --governance examples/governance-consensus/index.mjs
 */

export const CONS_PROPOSAL = "proposal";
export const CONS_CONCERN = "concern";
export const CONS_BLOCK = "block";
export const CONS_STAND_ASIDE = "stand-aside";

const PROPOSAL_GRAPH = {
  kind: "proposal",
  initialState: "raised",
  terminalStates: ["agreed", "withdrawn"],
  defaultReviewDays: 120,
  transitions: [
    { from: "raised", to: "temperature-check", trigger: "agent-action" },
    { from: "temperature-check", to: "deliberation", trigger: "agent-action" },
    { from: "temperature-check", to: "withdrawn", trigger: "agent-action" },
    { from: "deliberation", to: "consensus-round", trigger: "agent-action" },
    { from: "consensus-round", to: "agreed", trigger: "unanimous-agreement" },
    { from: "consensus-round", to: "deliberation", trigger: "block-raised" },
    { from: "consensus-round", to: "withdrawn", trigger: "agent-action" },
    { from: "deliberation", to: "withdrawn", trigger: "agent-action" },
    // Timeout: deliberation stuck for 21 days triggers temperature re-check
    { from: "deliberation", to: "temperature-check", trigger: "timeout", timeoutMs: 21 * 86_400_000 },
  ],
};

const CONCERN_GRAPH = {
  kind: "concern",
  initialState: "raised",
  terminalStates: ["resolved", "withdrawn"],
  defaultReviewDays: 120,
  transitions: [
    { from: "raised", to: "addressed", trigger: "agent-action" },
    { from: "addressed", to: "resolved", trigger: "agent-action" },
    { from: "addressed", to: "raised", trigger: "agent-action" },
    { from: "raised", to: "withdrawn", trigger: "agent-action" },
    // Timeout: unaddressed concerns escalate after 10 days
    { from: "raised", to: "raised", trigger: "timeout", timeoutMs: 10 * 86_400_000 },
  ],
};

/** @type {import('@murmuration/core').GovernancePlugin} */
const ConsensusPlugin = {
  name: "consensus",
  version: "0.1.0",

  terminology: {
    group: "assembly",
    groupPlural: "assemblies",
    governanceItem: "proposal",
    governanceEvent: "concern",
  },

  stateGraphs() {
    return [PROPOSAL_GRAPH, CONCERN_GRAPH];
  },

  async onEventsEmitted(batch, store) {
    const decisions = [];
    for (const event of batch.events) {
      switch (event.kind) {
        case CONS_PROPOSAL:
        case "agent-governance-event": {
          store.create("proposal", batch.agentId, event.payload);
          // Proposals go to the full assembly
          const routes = [{ target: "source" }];
          if (event.targetAgentId) {
            routes.push({ target: "agent", agentId: event.targetAgentId });
          }
          decisions.push({ event, routes });
          break;
        }
        case CONS_CONCERN: {
          store.create("concern", batch.agentId, event.payload);
          decisions.push({ event, routes: [{ target: "source" }] });
          break;
        }
        case CONS_BLOCK: {
          // Blocks are urgent — go to Source and all members
          decisions.push({ event, routes: [{ target: "source" }] });
          break;
        }
        case CONS_STAND_ASIDE: {
          // Stand-asides are noted but don't block
          decisions.push({ event, routes: [{ target: "source" }] });
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
      return { allow: false, reason: `Action "${action}" requires the full assembly's consensus (tier: source).` };
    }

    if (tier === "consent" || tier === "consensus") {
      // Consensus requires an agreed proposal
      const agreed = store.query({ kind: "proposal", state: "agreed" });
      const covering = agreed.find((item) => {
        const payload = typeof item.payload === "object" && item.payload !== null ? item.payload : {};
        return /** @type {any} */ (payload).action === action;
      });
      if (covering) return { allow: true };
      return {
        allow: false,
        reason: `Action "${action}" requires unanimous consensus. Raise a proposal for the assembly.`,
      };
    }

    return { allow: true };
  },

  async onDaemonStart(store) {
    const existing = store.query();
    if (existing.length > 0) {
      console.log(`[consensus] restored ${String(existing.length)} governance items`);
    }
    const blocked = existing.filter((i) => i.currentState === "deliberation");
    if (blocked.length > 0) {
      console.log(`[consensus] ${String(blocked.length)} proposals in deliberation — may need attention`);
    }
  },
};

export default ConsensusPlugin;
