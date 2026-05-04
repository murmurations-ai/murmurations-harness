/**
 * Consensus Governance Plugin — STUB
 *
 * Status: interface satisfied; full consensus-building logic deferred.
 * Distinguished from S3 by requiring explicit affirmative agreement
 * from EVERY named member, not just absence of objection.
 *
 * State graph (sketch):
 *   proposed → discussion → voting → passed (unanimous) | failed
 */

const PROPOSAL_GRAPH = {
  kind: "proposal",
  initialState: "proposed",
  terminalStates: ["passed", "failed", "withdrawn"],
  defaultReviewDays: 90,
  transitions: [
    { from: "proposed", to: "discussion", trigger: "agent-action" },
    { from: "discussion", to: "voting", trigger: "agent-action" },
    { from: "voting", to: "passed", trigger: "unanimous-agreement" },
    { from: "voting", to: "discussion", trigger: "dissent-raised" },
    { from: "voting", to: "failed", trigger: "agent-action" },
    { from: "proposed", to: "withdrawn", trigger: "agent-action" },
    { from: "discussion", to: "withdrawn", trigger: "agent-action" },
  ],
};

/** @type {import('@murmurations-ai/core').GovernancePlugin} */
const ConsensusPlugin = {
  name: "consensus",
  version: "0.1.0-stub",

  terminology: {
    group: "circle",
    groupPlural: "circles",
    governanceItem: "proposal",
    governanceEvent: "concern",
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

export default ConsensusPlugin;
