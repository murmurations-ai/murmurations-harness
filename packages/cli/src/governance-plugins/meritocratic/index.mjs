/**
 * Meritocratic Governance Plugin — STUB
 *
 * Status: interface satisfied; weighted-voting / expert-review logic
 * deferred. The model assigns weights to circle members based on
 * domain expertise; decisions reflect weighted majority.
 *
 * State graph (sketch):
 *   open → review → scored → accepted | rejected
 */

const PROPOSAL_GRAPH = {
  kind: "proposal",
  initialState: "open",
  terminalStates: ["accepted", "rejected", "withdrawn"],
  defaultReviewDays: 60,
  transitions: [
    { from: "open", to: "review", trigger: "agent-action" },
    { from: "review", to: "scored", trigger: "scoring-complete" },
    { from: "scored", to: "accepted", trigger: "weighted-majority" },
    { from: "scored", to: "rejected", trigger: "weighted-majority" },
    { from: "open", to: "withdrawn", trigger: "agent-action" },
    { from: "review", to: "withdrawn", trigger: "agent-action" },
  ],
};

/** @type {import('@murmurations-ai/core').GovernancePlugin} */
const MeritocraticPlugin = {
  name: "meritocratic",
  version: "0.1.0-stub",

  terminology: {
    group: "council",
    groupPlural: "councils",
    governanceItem: "proposal",
    governanceEvent: "submission",
  },

  stateGraphs() {
    return [PROPOSAL_GRAPH];
  },

  // eslint-disable-next-line @typescript-eslint/require-await
  async onEventsEmitted(_batch, _reader) {
    return [];
  },

  // eslint-disable-next-line @typescript-eslint/require-await
  async evaluateAction(_agentId, _action, _context, _reader) {
    return { allow: true };
  },

  // eslint-disable-next-line @typescript-eslint/require-await
  async computeNextState(_input) {
    return null;
  },

  closerFor(issueType) {
    if (issueType === "[PROPOSAL]") return "facilitator";
    if (issueType === "[TENSION]") return "filer";
    if (issueType === "[DIRECTIVE]") return "source";
    return "responsible";
  },
};

export default MeritocraticPlugin;
