/**
 * Chain of Command Governance Plugin
 *
 * Hierarchical authority-based governance:
 *
 *   - Directives flow down from Source (the authority)
 *   - Reports flow up from agents
 *   - Source approves or rejects — no group deliberation
 *   - Agents execute approved directives, report completion
 *   - Fast decision-making, clear accountability
 *   - 30-day default review cadence (shorter than S3/Parliamentary)
 *
 * State graphs:
 *   Directive: drafted → submitted → approved | rejected → executing → completed
 *   Report:    filed → acknowledged → resolved | escalated
 *
 * Terminology:
 *   S3 "tension"     → C&C "report"
 *   S3 "proposal"    → C&C "directive"
 *   S3 "consent"     → C&C "approved"
 *   S3 "circle"      → C&C "department"
 *
 * Usage:
 *   murmuration start --root ../my-murmuration --governance examples/governance-command/index.mjs
 */

export const CC_DIRECTIVE = "directive";
export const CC_REPORT = "report";
export const CC_ESCALATION = "escalation";

const DIRECTIVE_GRAPH = {
  kind: "directive",
  initialState: "drafted",
  terminalStates: ["completed", "rejected"],
  defaultReviewDays: 30,
  transitions: [
    { from: "drafted", to: "submitted", trigger: "agent-action" },
    { from: "submitted", to: "approved", trigger: "authority-approval" },
    { from: "submitted", to: "rejected", trigger: "authority-rejection" },
    { from: "approved", to: "executing", trigger: "agent-action" },
    { from: "executing", to: "completed", trigger: "agent-action" },
    // Timeout: submitted directives not acted on in 48h escalate
    { from: "submitted", to: "submitted", trigger: "timeout", timeoutMs: 2 * 86_400_000 },
  ],
};

const REPORT_GRAPH = {
  kind: "report",
  initialState: "filed",
  terminalStates: ["resolved", "escalated"],
  defaultReviewDays: 30,
  transitions: [
    { from: "filed", to: "acknowledged", trigger: "authority-acknowledgment" },
    { from: "acknowledged", to: "resolved", trigger: "agent-action" },
    { from: "filed", to: "escalated", trigger: "agent-action" },
    { from: "acknowledged", to: "escalated", trigger: "agent-action" },
    // Timeout: unacknowledged reports auto-escalate after 3 days
    { from: "filed", to: "escalated", trigger: "timeout", timeoutMs: 3 * 86_400_000 },
  ],
};

/** @type {import('@murmuration/core').GovernancePlugin} */
const ChainOfCommandPlugin = {
  name: "chain-of-command",
  version: "0.1.0",

  terminology: {
    group: "department",
    groupPlural: "departments",
    governanceItem: "directive",
    governanceEvent: "report",
  },

  stateGraphs() {
    return [DIRECTIVE_GRAPH, REPORT_GRAPH];
  },

  async onEventsEmitted(batch, store) {
    const decisions = [];
    for (const event of batch.events) {
      switch (event.kind) {
        case CC_DIRECTIVE:
        case CC_REPORT:
        case "agent-governance-event": {
          store.create(
            event.kind === CC_DIRECTIVE ? "directive" : "report",
            batch.agentId,
            event.payload,
          );
          // Everything goes to Source (the authority)
          decisions.push({ event, routes: [{ target: "source" }] });
          break;
        }
        case CC_ESCALATION: {
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

    if (tier === "source" || tier === "consent") {
      // In C&C, anything requiring consent needs an approved directive
      const approved = store.query({ kind: "directive", state: "approved" });
      const covering = approved.find((item) => {
        const payload = typeof item.payload === "object" && item.payload !== null ? item.payload : {};
        return /** @type {any} */ (payload).action === action;
      });
      if (covering) return { allow: true };
      return {
        allow: false,
        reason: `Action "${action}" requires an approved directive from the authority.`,
      };
    }

    return { allow: true };
  },

  async onDaemonStart(store) {
    const existing = store.query();
    if (existing.length > 0) {
      console.log(`[chain-of-command] restored ${String(existing.length)} governance items`);
    }
  },
};

export default ChainOfCommandPlugin;
