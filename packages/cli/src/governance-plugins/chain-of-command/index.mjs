/**
 * Chain-of-Command Governance Plugin — STUB
 *
 * Status: interface satisfied (the harness can load it); decision
 * logic deferred. Source authority is the load-bearing primitive;
 * a future PR will wire the actual transitions.
 *
 * State graph (sketch):
 *   drafted → submitted → reviewing → approved → executing → completed
 *                                   → rejected
 *                                   → vetoed (by Source)
 *
 * Closure rules:
 *   [DIRECTIVE] → source (always)
 *   [PROPOSAL]  → source (no consent rounds in this model)
 *   [TENSION]   → filer (with Source notification)
 *   everything else → responsible (named in assigned: label)
 */

const COMMAND_GRAPH = {
  kind: "directive",
  initialState: "drafted",
  terminalStates: ["completed", "rejected", "vetoed"],
  defaultReviewDays: 30,
  transitions: [
    { from: "drafted", to: "submitted", trigger: "agent-action" },
    { from: "submitted", to: "reviewing", trigger: "agent-action" },
    { from: "reviewing", to: "approved", trigger: "approval" },
    { from: "reviewing", to: "rejected", trigger: "rejection" },
    { from: "approved", to: "executing", trigger: "agent-action" },
    { from: "executing", to: "completed", trigger: "agent-action" },
    { from: "submitted", to: "vetoed", trigger: "source-veto" },
    { from: "reviewing", to: "vetoed", trigger: "source-veto" },
  ],
};

/** @type {import('@murmurations-ai/core').GovernancePlugin} */
const ChainOfCommandPlugin = {
  name: "chain-of-command",
  version: "0.1.0-stub",

  terminology: {
    group: "team",
    groupPlural: "teams",
    governanceItem: "directive",
    governanceEvent: "request",
  },

  stateGraphs() {
    return [COMMAND_GRAPH];
  },

  // eslint-disable-next-line @typescript-eslint/require-await
  async onEventsEmitted(_batch, _reader) {
    // Stub: no routing logic yet.
    return [];
  },

  // eslint-disable-next-line @typescript-eslint/require-await
  async evaluateAction(_agentId, _action, _context, _reader) {
    // Stub: defer to harness default (allow).
    return { allow: true };
  },

  // eslint-disable-next-line @typescript-eslint/require-await
  async computeNextState(_input) {
    // Stub: no state advancement logic yet.
    return null;
  },

  closerFor(issueType) {
    if (issueType === "[DIRECTIVE]") return "source";
    if (issueType === "[PROPOSAL]") return "source";
    if (issueType === "[TENSION]") return "filer";
    return "responsible";
  },
};

export default ChainOfCommandPlugin;
