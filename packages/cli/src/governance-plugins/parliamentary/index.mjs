/**
 * Parliamentary Governance Plugin — STUB
 *
 * Status: interface satisfied; motion / second / debate / vote logic
 * deferred. Robert's-Rules-style structured deliberation with formal
 * majority voting.
 *
 * State graph (sketch):
 *   motion → seconded → debate → vote → passed | failed | tabled
 */

const MOTION_GRAPH = {
  kind: "motion",
  initialState: "motion",
  terminalStates: ["passed", "failed", "tabled", "withdrawn"],
  defaultReviewDays: 30,
  transitions: [
    { from: "motion", to: "seconded", trigger: "second-received" },
    { from: "seconded", to: "debate", trigger: "agent-action" },
    { from: "debate", to: "vote", trigger: "agent-action" },
    { from: "vote", to: "passed", trigger: "majority-yes" },
    { from: "vote", to: "failed", trigger: "majority-no" },
    { from: "vote", to: "tabled", trigger: "table-motion" },
    { from: "debate", to: "tabled", trigger: "table-motion" },
    { from: "motion", to: "withdrawn", trigger: "agent-action" },
  ],
};

/** @type {import('@murmurations-ai/core').GovernancePlugin} */
const ParliamentaryPlugin = {
  name: "parliamentary",
  version: "0.1.0-stub",

  terminology: {
    group: "assembly",
    groupPlural: "assemblies",
    governanceItem: "motion",
    governanceEvent: "point",
  },

  stateGraphs() {
    return [MOTION_GRAPH];
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

  closerFor(_issueType) {
    // Parliamentary routes everything through the chair (facilitator).
    return "facilitator";
  },
};

export default ParliamentaryPlugin;
