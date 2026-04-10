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

/** Tension lifecycle — the core S3 governance item. */
const TENSION_GRAPH = {
  kind: "tension",
  initialState: "open",
  terminalStates: ["resolved", "withdrawn"],
  defaultReviewDays: 90,
  transitions: [
    { from: "open", to: "deliberating", trigger: "agent-action" },
    { from: "deliberating", to: "consent-round", trigger: "agent-action" },
    { from: "consent-round", to: "resolved", trigger: "consent-achieved" },
    { from: "consent-round", to: "deliberating", trigger: "objection-raised" },
    { from: "open", to: "withdrawn", trigger: "agent-action" },
    { from: "deliberating", to: "withdrawn", trigger: "agent-action" },
    // Timeout: tensions stuck in deliberating for 7 days auto-escalate
    // to Source via the "source" routing target.
    { from: "deliberating", to: "deliberating", trigger: "timeout", timeoutMs: 7 * 86_400_000 },
  ],
};

/** Proposal lifecycle — a formalized response to a tension. */
const PROPOSAL_GRAPH = {
  kind: "proposal",
  initialState: "drafted",
  terminalStates: ["ratified", "rejected", "withdrawn"],
  defaultReviewDays: 90,
  transitions: [
    { from: "drafted", to: "consent-round", trigger: "agent-action" },
    { from: "consent-round", to: "ratified", trigger: "consent-achieved" },
    { from: "consent-round", to: "drafted", trigger: "objection-raised" },
    { from: "consent-round", to: "rejected", trigger: "agent-action" },
    { from: "drafted", to: "withdrawn", trigger: "agent-action" },
  ],
};

// ---------------------------------------------------------------------------
// S3 Plugin implementation
// ---------------------------------------------------------------------------

/** @type {import('@murmuration/core').GovernancePlugin} */
const S3GovernancePlugin = {
  name: "self-organizing",
  version: "0.1.0",

  stateGraphs() {
    return [TENSION_GRAPH, PROPOSAL_GRAPH];
  },

  async onEventsEmitted(batch, store) {
    const decisions = [];

    for (const event of batch.events) {
      switch (event.kind) {
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
    // Phase 1 S3 authorization: simplified consent check.
    //
    // For actions that require consent (e.g. "publish-article",
    // "commit-to-main"), check if there's a ratified governance
    // item covering this action. If yes → allow. If no ratified
    // item exists, check whether the action falls under the agent's
    // autonomous tier (per the decision-tiers in their circle doc).
    //
    // For Phase 1, we allow everything and log the check. Real
    // consent rounds (blocking until all circle members respond)
    // are Phase 3 work.
    //
    // The store is available for future use: store.query({ kind: "proposal", state: "ratified" })
    // would find ratified proposals covering the requested action.

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
