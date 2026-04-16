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

export type GroupWakeKind = "operational" | "governance" | "retrospective";

/** Per-agent metrics snapshot for retrospective meetings. */
export interface AgentMetricsSnapshot {
  readonly agentId: string;
  readonly totalWakes: number;
  readonly totalArtifacts: number;
  readonly idleWakes: number;
  readonly consecutiveFailures: number;
  /** Artifact rate: artifacts per wake. 0 if no wakes. */
  readonly artifactRate: number;
  /** Idle rate: idle wakes / total wakes. 0 if no wakes. */
  readonly idleRate: number;
}

/** Group-level metrics for retrospective context. */
export interface RetrospectiveMetrics {
  readonly agentMetrics: readonly AgentMetricsSnapshot[];
  /** Period this retrospective covers (e.g. "2026-04-07 to 2026-04-12"). */
  readonly period: string;
  /** Strategy alignment assessment, if a strategy plugin is configured. */
  readonly alignment?: import("../strategy/index.js").AlignmentAssessment;
}

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
  /** Metrics for retrospective meetings. Ignored for other kinds. */
  readonly retrospectiveMetrics?: RetrospectiveMetrics;
  /** Open issues / backlog context for agenda generation. */
  readonly backlogContext?: string;
}

/** A single agenda item for a circle meeting. */
export interface AgendaItem {
  readonly title: string;
  readonly description: string;
  /** "directive" = Source override, "governance" = from queue, "operational" = generated */
  readonly source: "directive" | "governance" | "operational";
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
  /** The meeting agenda (generated by facilitator or from Source directive). */
  readonly agenda: readonly AgendaItem[];
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

export const parseMeetingActions = (text: string): readonly MeetingAction[] =>
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
      if (Array.isArray(parsed))
        return { actions: parsed.filter(isValidMeetingAction), truncated: false };
    } catch {
      /* fall through to truncation recovery */
    }
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
    } catch {
      /* skip malformed */
    }
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
// Default retrospective prompts
// ---------------------------------------------------------------------------

const DEFAULT_RETRO_MEMBER_INSTRUCTIONS = `Review the metrics and your experience since the last retrospective. Respond with:

## KEEP
What's working well? What should we continue doing?

## STOP
What's not working? What should we stop doing?

## START
What should we try? What new practices, tools, or changes would help?

Be specific and reference concrete examples. Cite metrics where relevant.`;

const DEFAULT_RETRO_FACILITATOR_INSTRUCTIONS = `Synthesize all member contributions into a retrospective summary.

Produce:
1. **KEEP** — practices the group agrees to continue (with supporting evidence)
2. **STOP** — practices to discontinue (with the problem they cause)
3. **START** — new practices to try (with the expected improvement)
4. **GOVERNANCE EVENTS** — any findings that need structural change should be filed as governance events

For each START item, create a GitHub issue as an action item so it gets tracked.
For each finding that needs structural change (role changes, schedule changes, process changes), file it as a governance event in the actions block.`;

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
 * Run a group wake session — S3-aligned three-phase meeting.
 *
 * Phase 0 (agenda formation): If Source directive exists, it IS the agenda
 * (skip generation). Otherwise, the facilitator generates the agenda from
 * governance queue, backlog, and signals.
 *
 * Phase 1 (member round): each member contributes to the AGENDA ITEMS
 * specifically — not generic "what's working." Members see prior
 * contributions (accumulating context).
 *
 * Phase 2 (facilitator synthesis): the facilitator sees ALL member
 * contributions and produces decisions, action items, and meeting minutes
 * organized by agenda item.
 */
export const runGroupWake = async (
  context: GroupWakeContext,
  deps: GroupWakeRunnerDeps,
  signal?: AbortSignal,
): Promise<GroupWakeResult> => {
  const contributions: MemberContribution[] = [];
  let totalInput = 0;
  let totalOutput = 0;

  // =========================================================================
  // Phase 0: Agenda formation
  // =========================================================================

  let agenda: AgendaItem[];

  if (context.directiveBody) {
    // Source directive overrides everything — it IS the agenda
    agenda = [
      {
        title: "Source Directive",
        description: context.directiveBody,
        source: "directive",
      },
    ];
  } else {
    // Facilitator generates the agenda from governance queue + backlog + signals
    agenda = await generateAgenda(context, deps, signal);
    totalInput += agenda.length > 0 ? 0 : 0; // token tracking happens inside generateAgenda
  }

  // Format agenda for prompts
  const agendaBlock = formatAgendaBlock(agenda);

  // Build meeting context header
  const meetingHeader = buildMeetingHeader(context);

  // =========================================================================
  // Phase 1: Member round — driven by agenda
  // =========================================================================

  for (const memberId of context.members) {
    if (signal?.aborted) break;
    if (memberId === context.facilitator) continue; // facilitator speaks last

    const priorContributions =
      contributions.length > 0
        ? `\n\nPrior contributions from group members:\n${contributions.map((c) => `### ${c.agentId}\n${c.content}`).join("\n\n")}`
        : "";

    const memberInstructions =
      context.kind === "governance"
        ? (deps.governancePrompts?.memberInstructions ?? DEFAULT_GOV_MEMBER_INSTRUCTIONS)
        : context.kind === "retrospective"
          ? DEFAULT_RETRO_MEMBER_INSTRUCTIONS
          : buildOperationalMemberInstructions(agenda);

    const userPrompt = `${meetingHeader}

## Meeting Agenda

${agendaBlock}${priorContributions}

---

You are ${memberId}, a member of the ${context.groupId} group. Address EACH agenda item above from your domain perspective.

${memberInstructions}

Keep your contribution focused and concise (3-5 paragraphs). Structure your response by agenda item.`;

    const response = await deps.callLLM({
      systemPrompt: `You are agent ${memberId} participating in a ${context.kind} meeting of the ${context.groupId} circle. Your job is to address the meeting agenda — not to discuss anything outside of it.`,
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

  // =========================================================================
  // Phase 2: Facilitator synthesis — agenda-driven
  // =========================================================================

  const allContributions = contributions.map((c) => `### ${c.agentId}\n${c.content}`).join("\n\n");

  const facilitatorPrompt = `${meetingHeader}

## Meeting Agenda

${agendaBlock}

## All member contributions

${allContributions}

---

You are ${context.facilitator}, the facilitator of the ${context.groupId} circle. Synthesize all member contributions into a meeting summary ORGANIZED BY AGENDA ITEM.

${
  context.kind === "governance"
    ? (deps.governancePrompts?.facilitatorInstructions ?? DEFAULT_GOV_FACILITATOR_INSTRUCTIONS)
    : context.kind === "retrospective"
      ? DEFAULT_RETRO_FACILITATOR_INSTRUCTIONS
      : `For EACH agenda item, produce:
- DECISION — what the group decided (or "no decision — carried to next meeting")
- ACTION ITEMS — who does what (each becomes a GitHub issue)

Then at the end:
- TENSIONS — any new governance items to file
- NEXT MEETING — what to revisit`
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
Only reference issue numbers that exist. Do not invent issue numbers.`;

  const synthesis = await deps.callLLM({
    systemPrompt: `You are ${context.facilitator}, facilitator of the ${context.groupId} circle. Synthesize member contributions into clear decisions and action items organized by agenda item.`,
    userPrompt: facilitatorPrompt,
    agentId: context.facilitator,
    signal,
  });

  totalInput += synthesis.inputTokens;
  totalOutput += synthesis.outputTokens;

  // Parse governance positions from member contributions (governance only).
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
    agenda,
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

// ---------------------------------------------------------------------------
// Agenda helpers
// ---------------------------------------------------------------------------

/** Build a meeting context header based on meeting kind. */
function buildMeetingHeader(context: GroupWakeContext): string {
  if (context.kind === "governance") {
    return `This is a GOVERNANCE MEETING for the ${context.groupId} circle.\n\nGovernance queue (${String(context.governanceQueue.length)} items):\n${
      context.governanceQueue
        .map((item) => {
          const issueNum = context.governanceIssueMap?.get(item.id);
          const issueRef = issueNum ? ` (GitHub #${String(issueNum)})` : "";
          return `  - [${item.id.slice(0, 8)}]${issueRef} ${item.kind} | state: ${item.currentState} | ${JSON.stringify(item.payload)}`;
        })
        .join("\n") || "  (empty)"
    }`;
  }
  if (context.kind === "retrospective" && context.retrospectiveMetrics) {
    return `This is a RETROSPECTIVE for the ${context.groupId} circle.\n\nPeriod: ${context.retrospectiveMetrics.period}\n\n## Agent Metrics\n\n${context.retrospectiveMetrics.agentMetrics.map((m) => `  - ${m.agentId}: ${String(m.totalWakes)} wakes, ${String(m.totalArtifacts)} artifacts, ${String(m.idleWakes)} idle (${String(Math.round(m.idleRate * 100))}%), ${String(m.consecutiveFailures)} consecutive failures`).join("\n")}`;
  }
  return `This is an OPERATIONAL MEETING for the ${context.groupId} circle.`;
}

/** Format agenda items as a numbered list for prompts. */
function formatAgendaBlock(agenda: readonly AgendaItem[]): string {
  return agenda
    .map((item, i) => {
      const tag =
        item.source === "directive"
          ? " [SOURCE DIRECTIVE — mandatory]"
          : item.source === "governance"
            ? " [governance]"
            : "";
      return `${String(i + 1)}. **${item.title}**${tag}\n   ${item.description}`;
    })
    .join("\n\n");
}

/** Build member instructions for operational meetings with agenda. */
function buildOperationalMemberInstructions(agenda: readonly AgendaItem[]): string {
  const hasDirective = agenda.some((a) => a.source === "directive");
  if (hasDirective) {
    return `This meeting has a SOURCE DIRECTIVE. Address the directive ONLY. Do not discuss other topics, backlog items, or general status. The directive is your sole agenda item. Provide your domain-specific perspective on it.`;
  }
  return `Address each agenda item from your domain perspective. For each item:
- State your position or recommendation
- Identify risks or concerns from your area of expertise
- Propose concrete next steps if applicable

Do NOT discuss topics outside the agenda. Stay focused.`;
}

/**
 * Phase 0: Facilitator generates the meeting agenda.
 * Called only when no Source directive is present.
 */
async function generateAgenda(
  context: GroupWakeContext,
  deps: GroupWakeRunnerDeps,
  signal?: AbortSignal,
): Promise<AgendaItem[]> {
  // Build context for agenda generation
  const govSection =
    context.governanceQueue.length > 0
      ? `\n\n## Governance Queue (${String(context.governanceQueue.length)} items)\n${context.governanceQueue
          .map((item) => {
            const issueNum = context.governanceIssueMap?.get(item.id);
            const issueRef = issueNum ? ` (GitHub #${String(issueNum)})` : "";
            return `- [${item.id.slice(0, 8)}]${issueRef} ${item.kind} | state: ${item.currentState} | ${JSON.stringify(item.payload)}`;
          })
          .join("\n")}`
      : "";

  const backlogSection = context.backlogContext
    ? `\n\n## Open Issues\n\n${context.backlogContext}`
    : "";

  const signalSection =
    context.signals.length > 0
      ? `\n\nRecent signals (${String(context.signals.length)} items):\n${context.signals
          .slice(0, 10)
          .map((s) => `  - [${s.kind}] ${JSON.stringify(s).slice(0, 100)}`)
          .join("\n")}`
      : "";

  const userPrompt = `You are ${context.facilitator}, facilitator of the ${context.groupId} circle. Generate the meeting agenda.

Review the governance queue, open issues, and signals below. Propose 3-5 focused agenda items for this ${context.kind} meeting. Each item should be actionable — something the circle can decide or act on in this meeting.
${govSection}${backlogSection}${signalSection}

---

Output the agenda as a numbered list. For each item:
- A clear, specific title
- One sentence describing what the circle needs to decide or do

Format:
1. **Title**: Description
2. **Title**: Description
...

Keep it to 3-5 items maximum. Prioritize by urgency and impact.`;

  const response = await deps.callLLM({
    systemPrompt: `You are ${context.facilitator}, facilitator of the ${context.groupId} circle. Generate a focused meeting agenda. Be specific and actionable — no generic items.`,
    userPrompt,
    agentId: context.facilitator,
    ...(signal ? { signal } : {}),
  });

  // Parse agenda items from the facilitator's response
  const items = parseAgendaItems(response.content);

  // If parsing fails, create a single fallback item
  if (items.length === 0) {
    return [
      {
        title: "Open discussion",
        description:
          "Facilitator agenda generation did not produce structured items. Review governance queue and open issues.",
        source: "operational",
      },
    ];
  }

  return items;
}

/** Parse numbered agenda items from facilitator output. */
function parseAgendaItems(content: string): AgendaItem[] {
  const items: AgendaItem[] = [];
  // Match "1. **Title**: Description" or "1. **Title** — Description" patterns
  const regex = /^\d+\.\s+\*\*(.+?)\*\*[:\s—–-]+(.+)/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const title = match[1]?.trim() ?? "";
    const description = match[2]?.trim() ?? "";
    if (title) {
      items.push({ title, description, source: "operational" });
    }
  }
  return items;
}
