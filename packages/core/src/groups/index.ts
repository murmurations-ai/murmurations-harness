/**
 * Group Wake Runner — convenes all members of a group for a
 * shared session with a facilitator who synthesizes the output.
 *
 * Two wake kinds:
 *   - operational: process backlog, prioritize, plan, retrospect
 *   - governance: process consent rounds, review agreements
 *
 * The runner calls each member's LLM in sequence (round format),
 * then the facilitator sees all contributions and synthesizes.
 *
 * This is NOT an individual agent wake — it's a group session
 * where the group convenes as a unit. The daemon schedules it
 * from group config, not from individual agent role.md.
 */

import type { Signal } from "../execution/index.js";
import type { GovernanceItem } from "../governance/index.js";

// ---------------------------------------------------------------------------
// Group configuration (parsed from group docs)
// ---------------------------------------------------------------------------

export interface GroupConfig {
  readonly groupId: string;
  readonly name: string;
  readonly members: readonly string[]; // agent IDs
  readonly facilitator: string; // agent ID
  readonly operationalCron?: string;
  readonly governanceCron?: string;
  readonly backlogLabel?: string; // GitHub label for this group.s issues
  readonly backlogRepo?: string; // "owner/repo"
}

// ---------------------------------------------------------------------------
// Circle wake context + result
// ---------------------------------------------------------------------------

export type GroupWakeKind = "operational" | "governance";

export interface GroupWakeContext {
  readonly groupId: string;
  readonly kind: GroupWakeKind;
  readonly members: readonly string[];
  readonly facilitator: string;
  readonly signals: readonly Signal[];
  readonly governanceQueue: readonly GovernanceItem[];
  /** Map from governance item ID to GitHub issue number (for state-transition actions). */
  readonly governanceIssueMap?: ReadonlyMap<string, number>;
  readonly directiveBody?: string; // if a Source directive triggered this
}

// ---------------------------------------------------------------------------
// Structured actions — the harness executes these against GitHub
// ---------------------------------------------------------------------------

/** An action that changes GitHub state. Returned by LLM, executed by the runner. */
export interface MeetingAction {
  readonly kind: "label-issue" | "create-issue" | "close-issue" | "comment-issue";
  readonly issueNumber?: number;
  readonly label?: string;
  readonly removeLabel?: string;
  readonly title?: string;
  readonly body?: string;
  readonly labels?: readonly string[];
}

/** Result of executing a single MeetingAction against GitHub. */
export interface ActionReceipt {
  readonly action: MeetingAction;
  readonly success: boolean;
  readonly error?: string;
  /** For create-issue: the new issue number. */
  readonly issueNumber?: number;
}

// ---------------------------------------------------------------------------
// Member contributions
// ---------------------------------------------------------------------------

export interface MemberContribution {
  readonly agentId: string;
  readonly content: string;
  readonly actions: readonly MeetingAction[];
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * A member's position on a governance item. The position string is
 * governance-model-defined — S3 uses "consent"/"concern"/"objection",
 * Chain of Command uses "approve"/"reject", Parliamentary uses "aye"/"nay".
 * The harness treats these as opaque strings.
 */
export interface GovernancePosition {
  readonly agentId: string;
  readonly itemId: string;
  readonly position: string;
  readonly reasoning: string;
  /** Model-specific fields (e.g. S3 "harm"/"amendment" on objections). */
  readonly details?: Readonly<Record<string, string>>;
}

/**
 * Tally of positions for a single governance item. Position counts
 * are keyed by the model-defined position strings. The recommendation
 * is produced by the governance plugin's tally logic, not hardcoded.
 */
export interface GovernanceTally {
  readonly itemId: string;
  /** Count per position string (e.g. { consent: 3, objection: 1 }). */
  readonly counts: Readonly<Record<string, number>>;
  readonly positions: readonly GovernancePosition[];
  /** Plugin-determined recommendation (e.g. "ratify", "approve", "pass"). */
  readonly recommendation: string;
}

// Legacy aliases for backwards compatibility with existing tests/consumers
export type ConsentPosition = GovernancePosition;
export type ConsentTally = GovernanceTally;

export interface GroupWakeResult {
  readonly groupId: string;
  readonly kind: GroupWakeKind;
  readonly contributions: readonly MemberContribution[];
  readonly synthesis: string;
  /** Structured actions from the facilitator synthesis. */
  readonly actions: readonly MeetingAction[];
  /** Execution receipts — one per action attempted. */
  readonly receipts: readonly ActionReceipt[];
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly governanceEvents: readonly { kind: string; payload: unknown }[];
  /** Position tallies, one per governance item (governance meetings only). */
  readonly tallies: readonly GovernanceTally[];
}

// ---------------------------------------------------------------------------
// Action parsing — extract structured actions from LLM output
// ---------------------------------------------------------------------------

const VALID_ACTION_KINDS = new Set(["label-issue", "create-issue", "close-issue", "comment-issue"]);

/**
 * Parse structured actions from LLM output. Looks for a JSON array
 * in a ```actions or ```json fenced block, or a bare JSON array.
 * Returns empty array if no valid actions found (never throws).
 */
/** Result of parsing meeting actions, including truncation detection. */
export interface ParsedMeetingActions {
  readonly actions: readonly MeetingAction[];
  /** True if the actions block was truncated (maxOutputTokens hit). */
  readonly truncated: boolean;
}

export const parseMeetingActions = (text: string): MeetingAction[] =>
  parseMeetingActionsWithMeta(text).actions;

/**
 * Parse meeting actions with metadata (truncation detection).
 * Use this when you need to know if output was truncated.
 */
export const parseMeetingActionsWithMeta = (text: string): ParsedMeetingActions => {
  // Try fenced code block first: ```actions\n[...]\n``` or ```json\n[...]\n```
  const fencedMatch = /```(?:actions|json)\s*\n(\[[\s\S]*?\])\s*\n```/.exec(text);
  const jsonStr = fencedMatch?.[1] ?? extractBareJsonArray(text);
  if (jsonStr) {
    try {
      const parsed: unknown = JSON.parse(jsonStr);
      if (Array.isArray(parsed)) return { actions: parsed.filter(isValidMeetingAction), truncated: false };
    } catch { /* fall through to truncation recovery */ }
  }

  // Truncation recovery: if the actions block was cut off mid-JSON,
  // extract individual complete JSON objects from the text.
  const truncatedMatch = /```(?:actions|json)\s*\n\[([\s\S]*)$/.exec(text);
  if (truncatedMatch?.[1]) {
    return { actions: recoverTruncatedActions(truncatedMatch[1]), truncated: true };
  }

  return { actions: [], truncated: false };
};

/** Extract complete JSON objects from a truncated array body. */
const recoverTruncatedActions = (body: string): MeetingAction[] => {
  const actions: MeetingAction[] = [];
  // Match individual {...} objects — greedy within braces, non-nested
  const objectPattern = /\{[^{}]*\}/g;
  let match: RegExpExecArray | null;
  while ((match = objectPattern.exec(body)) !== null) {
    try {
      const obj: unknown = JSON.parse(match[0]);
      if (isValidMeetingAction(obj)) actions.push(obj);
    } catch { /* skip malformed */ }
  }
  return actions;
};

/** Try to extract a bare JSON array from the text (last [...] block). */
const extractBareJsonArray = (text: string): string | null => {
  // Find the last [...] block that looks like JSON
  const matches = text.match(/\[[\s\S]*?\]/g);
  if (!matches) return null;
  // Try from last to first (facilitator's action block is usually at the end)
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      const parsed: unknown = JSON.parse(matches[i]!);
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        typeof parsed[0] === "object" &&
        parsed[0] !== null &&
        "kind" in parsed[0]
      ) {
        return matches[i]!;
      }
    } catch {
      /* not valid JSON */
    }
  }
  return null;
};

const isValidMeetingAction = (item: unknown): item is MeetingAction => {
  if (typeof item !== "object" || item === null) return false;
  const obj = item as Record<string, unknown>;
  if (typeof obj.kind !== "string" || !VALID_ACTION_KINDS.has(obj.kind)) return false;
  // Validate required fields per kind
  switch (obj.kind) {
    case "label-issue":
      return typeof obj.issueNumber === "number" && typeof obj.label === "string";
    case "create-issue":
      return typeof obj.title === "string";
    case "close-issue":
      return typeof obj.issueNumber === "number";
    case "comment-issue":
      return typeof obj.issueNumber === "number" && typeof obj.body === "string";
    default:
      return false;
  }
};

// ---------------------------------------------------------------------------
// Default governance prompts (generic — not tied to any governance model)
// ---------------------------------------------------------------------------

const DEFAULT_GOV_MEMBER_INSTRUCTIONS = `For EACH governance item, state your position and reasoning.

ITEM: [item id]
POSITION: [your position — e.g. approve, reject, support, object, defer]
REASONING: [one sentence explaining your position]

Add any additional context relevant to your position.`;

const DEFAULT_GOV_FACILITATOR_INSTRUCTIONS = `For each governance item:
- Summarize the positions from all members
- Count positions by type
- Produce a clear recommendation based on the positions
- State whether the item should advance, be amended, or be tabled

For items that should advance to their next state, include state transition actions in your actions block:
  {"kind": "label-issue", "issueNumber": NNN, "label": "state:NEW_STATE", "removeLabel": "state:OLD_STATE"}
For items that are fully resolved, also close them:
  {"kind": "close-issue", "issueNumber": NNN}
For items that need amendments, post a comment with the required changes:
  {"kind": "comment-issue", "issueNumber": NNN, "body": "Amendment required: ..."}`;

// ---------------------------------------------------------------------------
// Group Wake Runner
// ---------------------------------------------------------------------------

/**
 * Governance-model-specific prompt templates for governance meetings.
 * The plugin provides these so the harness doesn't hardcode S3 terms.
 * If not provided, the runner uses generic defaults.
 */
export interface GovernanceMeetingPrompts {
  /** Prompt instructions for each member's governance contribution.
   *  Should tell the member what positions are valid and what format to use. */
  readonly memberInstructions: string;
  /** Prompt instructions for the facilitator's governance synthesis.
   *  Should tell the facilitator how to tally and what recommendations to produce. */
  readonly facilitatorInstructions: string;
  /** Parse positions from a member's contribution text. Returns positions for all items. */
  readonly parsePositions: (
    content: string,
    governanceQueue: readonly GovernanceItem[],
  ) => GovernancePosition[];
  /** Tally positions across all members and produce recommendations. */
  readonly tallyPositions: (
    positions: readonly GovernancePosition[],
    governanceQueue: readonly GovernanceItem[],
  ) => GovernanceTally[];
}

export interface GroupWakeRunnerDeps {
  /** Call an LLM with system prompt + user prompt, return the response text + token counts. */
  readonly callLLM: (opts: {
    systemPrompt: string;
    userPrompt: string;
    agentId: string;
    signal?: AbortSignal | undefined;
  }) => Promise<{ content: string; inputTokens: number; outputTokens: number }>;
  /** Governance-model-specific prompts and parsing. If omitted, a generic default is used. */
  readonly governancePrompts?: GovernanceMeetingPrompts;
}

/**
 * Run a group wake session. This is the core group-wake primitive.
 *
 * Phase 1 (member round): each member is called sequentially with
 * the group context. Each member sees the contributions of members
 * who spoke before them (accumulating context).
 *
 * Phase 2 (facilitator synthesis): the facilitator sees ALL member
 * contributions and produces the synthesized output — decisions,
 * priorities, meeting minutes.
 */
export const runGroupWake = async (
  context: GroupWakeContext,
  deps: GroupWakeRunnerDeps,
  signal?: AbortSignal,
): Promise<GroupWakeResult> => {
  const contributions: MemberContribution[] = [];
  let totalInput = 0;
  let totalOutput = 0;

  const groupContext =
    context.kind === "governance"
      ? `This is a GOVERNANCE MEETING for the ${context.groupId} group.\n\nGovernance queue (${String(context.governanceQueue.length)} items):\n${
          context.governanceQueue
            .map((item) => {
              const issueNum = context.governanceIssueMap?.get(item.id);
              const issueRef = issueNum ? ` (GitHub #${String(issueNum)})` : "";
              return `  - [${item.id.slice(0, 8)}]${issueRef} ${item.kind} | state: ${item.currentState} | ${JSON.stringify(item.payload)}`;
            })
            .join("\n") || "  (empty)"
        }`
      : `This is an OPERATIONAL MEETING for the ${context.groupId} group.`;

  const directiveSection = context.directiveBody
    ? `\n\nSOURCE DIRECTIVE:\n${context.directiveBody}\n\nRespond to the Source directive as part of your contribution.`
    : "";

  const signalSummary =
    context.signals.length > 0
      ? `\n\nRecent signals (${String(context.signals.length)} items):\n${context.signals
          .slice(0, 10)
          .map((s) => `  - [${s.kind}] ${JSON.stringify(s).slice(0, 100)}`)
          .join("\n")}`
      : "";

  // Phase 1: Member round
  for (const memberId of context.members) {
    if (signal?.aborted) break;
    if (memberId === context.facilitator) continue; // facilitator speaks last

    const priorContributions =
      contributions.length > 0
        ? `\n\nPrior contributions from group members:\n${contributions.map((c) => `### ${c.agentId}\n${c.content}`).join("\n\n")}`
        : "";

    const userPrompt = `${groupContext}${directiveSection}${signalSummary}${priorContributions}

---

You are ${memberId}, a member of the ${context.groupId} group. Provide your contribution to this ${context.kind} meeting.

${
  context.kind === "governance"
    ? (deps.governancePrompts?.memberInstructions ?? DEFAULT_GOV_MEMBER_INSTRUCTIONS)
    : "Share your perspective on the group.s current priorities, what's working, and what needs attention."
}

Keep your contribution focused and concise (3-5 paragraphs).`;

    const response = await deps.callLLM({
      systemPrompt: `You are agent ${memberId} participating in a group ${context.kind} meeting.`,
      userPrompt,
      agentId: memberId,
      ...(signal ? { signal } : {}),
    });

    contributions.push({
      agentId: memberId,
      content: response.content,
      actions: parseMeetingActions(response.content),
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
    });
    totalInput += response.inputTokens;
    totalOutput += response.outputTokens;
  }

  // Phase 2: Facilitator synthesis
  const allContributions = contributions.map((c) => `### ${c.agentId}\n${c.content}`).join("\n\n");

  const facilitatorPrompt = `${groupContext}${directiveSection}

## All member contributions

${allContributions}

---

You are ${context.facilitator}, the facilitator of the ${context.groupId} group. Synthesize all member contributions into a meeting summary.

${
  context.kind === "governance"
    ? (deps.governancePrompts?.facilitatorInstructions ?? DEFAULT_GOV_FACILITATOR_INSTRUCTIONS)
    : `Produce:
1. KEY DECISIONS — what the group agreed on
2. ACTION ITEMS — who does what by when (each becomes a GitHub issue)
3. TENSIONS — any new governance items to file
4. NEXT MEETING — what to revisit`
}

End with a one-paragraph meeting summary.

IMPORTANT: After your prose summary, you MUST include a structured actions block. This block will be executed against GitHub to make the meeting decisions real. Output a fenced JSON array like this:

\`\`\`actions
[
  {"kind": "label-issue", "issueNumber": 42, "label": "priority:high"},
  {"kind": "label-issue", "issueNumber": 42, "label": "assigned:01-research"},
  {"kind": "create-issue", "title": "Action item: ...", "body": "Context from meeting...", "labels": ["action-item", "assigned:02-content-production", "group:${context.groupId}"]},
  {"kind": "comment-issue", "issueNumber": 42, "body": "Meeting decision: ..."},
  {"kind": "close-issue", "issueNumber": 99}
]
\`\`\`

Action kinds: "label-issue" (add a label), "create-issue" (new issue with title+body+labels), "comment-issue" (post a comment), "close-issue".
For prioritization, use labels: priority:critical, priority:high, priority:medium, priority:low.
For assignments, use labels: assigned:<agent-id> (e.g. assigned:01-research).
Each action item MUST become a create-issue action with an "action-item" label and an "assigned:<who>" label.
Only reference issue numbers from the Open Issues list above. Do not invent issue numbers.`;

  const synthesis = await deps.callLLM({
    systemPrompt: `You are ${context.facilitator}, facilitator of the ${context.groupId} group. You synthesize member contributions into clear meeting outcomes.`,
    userPrompt: facilitatorPrompt,
    agentId: context.facilitator,
    signal,
  });

  totalInput += synthesis.inputTokens;
  totalOutput += synthesis.outputTokens;

  // Parse governance positions from member contributions (governance only).
  // The governance plugin provides the parser + tally logic. If none is
  // provided, positions are left empty — the facilitator's prose synthesis
  // is the authoritative output.
  let tallies: GovernanceTally[] = [];
  if (
    context.kind === "governance" &&
    context.governanceQueue.length > 0 &&
    deps.governancePrompts
  ) {
    const allPositions: GovernancePosition[] = [];
    for (const c of contributions) {
      const parsed = deps.governancePrompts.parsePositions(c.content, context.governanceQueue);
      for (const p of parsed) {
        allPositions.push({ ...p, agentId: c.agentId });
      }
    }
    tallies = deps.governancePrompts.tallyPositions(allPositions, context.governanceQueue);
  }

  // Parse structured actions from the facilitator's synthesis
  const parsed = parseMeetingActionsWithMeta(synthesis.content);
  const actions = parsed.actions;

  // Truncation creates a governance event — the system should know
  // actions were lost and address it in a retrospective.
  const governanceEvents: { kind: string; payload: unknown }[] = [];
  if (parsed.truncated) {
    governanceEvents.push({
      kind: "output-truncated",
      payload: {
        groupId: context.groupId,
        meetingKind: context.kind,
        recoveredActions: actions.length,
        description: `Facilitator output was truncated (maxOutputTokens hit). ${String(actions.length)} actions were recovered but some may have been lost. Consider increasing token limits or reducing meeting scope.`,
      },
    });
  }

  return {
    groupId: context.groupId,
    kind: context.kind,
    contributions,
    synthesis: synthesis.content,
    actions,
    receipts: [], // populated by the caller after executing actions
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    governanceEvents,
    tallies,
  };
};
