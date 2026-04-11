/**
 * Circle Wake Runner — convenes all members of a circle for a
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
 * where the circle convenes as a unit. The daemon schedules it
 * from circle config, not from individual agent role.md.
 */

import type { Signal } from "../execution/index.js";
import type { GovernanceItem } from "../governance/index.js";

// ---------------------------------------------------------------------------
// Circle configuration (parsed from circle docs)
// ---------------------------------------------------------------------------

export interface CircleConfig {
  readonly circleId: string;
  readonly name: string;
  readonly members: readonly string[]; // agent IDs
  readonly facilitator: string; // agent ID
  readonly operationalCron?: string;
  readonly governanceCron?: string;
  readonly backlogLabel?: string; // GitHub label for this circle's issues
  readonly backlogRepo?: string; // "owner/repo"
}

// ---------------------------------------------------------------------------
// Circle wake context + result
// ---------------------------------------------------------------------------

export type CircleWakeKind = "operational" | "governance";

export interface CircleWakeContext {
  readonly circleId: string;
  readonly kind: CircleWakeKind;
  readonly members: readonly string[];
  readonly facilitator: string;
  readonly signals: readonly Signal[];
  readonly governanceQueue: readonly GovernanceItem[];
  readonly directiveBody?: string; // if a Source directive triggered this
}

export interface MemberContribution {
  readonly agentId: string;
  readonly content: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface CircleWakeResult {
  readonly circleId: string;
  readonly kind: CircleWakeKind;
  readonly contributions: readonly MemberContribution[];
  readonly synthesis: string;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly governanceEvents: readonly { kind: string; payload: unknown }[];
}

// ---------------------------------------------------------------------------
// Circle Wake Runner
// ---------------------------------------------------------------------------

export interface CircleWakeRunnerDeps {
  /** Call an LLM with system prompt + user prompt, return the response text + token counts. */
  readonly callLLM: (opts: {
    systemPrompt: string;
    userPrompt: string;
    agentId: string;
    signal?: AbortSignal | undefined;
  }) => Promise<{ content: string; inputTokens: number; outputTokens: number }>;
}

/**
 * Run a circle wake session. This is the core group-wake primitive.
 *
 * Phase 1 (member round): each member is called sequentially with
 * the circle context. Each member sees the contributions of members
 * who spoke before them (accumulating context).
 *
 * Phase 2 (facilitator synthesis): the facilitator sees ALL member
 * contributions and produces the synthesized output — decisions,
 * priorities, meeting minutes.
 */
export const runCircleWake = async (
  context: CircleWakeContext,
  deps: CircleWakeRunnerDeps,
  signal?: AbortSignal,
): Promise<CircleWakeResult> => {
  const contributions: MemberContribution[] = [];
  let totalInput = 0;
  let totalOutput = 0;

  const circleContext = context.kind === "governance"
    ? `This is a GOVERNANCE MEETING for the ${context.circleId} circle.\n\nGovernance queue (${String(context.governanceQueue.length)} items):\n${context.governanceQueue.map((item) => `  - [${item.id.slice(0, 8)}] ${item.kind} | state: ${item.currentState} | ${JSON.stringify(item.payload)}`).join("\n") || "  (empty)"}`
    : `This is an OPERATIONAL MEETING for the ${context.circleId} circle.`;

  const directiveSection = context.directiveBody
    ? `\n\nSOURCE DIRECTIVE:\n${context.directiveBody}\n\nRespond to the Source directive as part of your contribution.`
    : "";

  const signalSummary = context.signals.length > 0
    ? `\n\nRecent signals (${String(context.signals.length)} items):\n${context.signals.slice(0, 10).map((s) => `  - [${s.kind}] ${JSON.stringify(s).slice(0, 100)}`).join("\n")}`
    : "";

  // Phase 1: Member round
  for (const memberId of context.members) {
    if (signal?.aborted) break;
    if (memberId === context.facilitator) continue; // facilitator speaks last

    const priorContributions = contributions.length > 0
      ? `\n\nPrior contributions from circle members:\n${contributions.map((c) => `### ${c.agentId}\n${c.content}`).join("\n\n")}`
      : "";

    const userPrompt = `${circleContext}${directiveSection}${signalSummary}${priorContributions}

---

You are ${memberId}, a member of the ${context.circleId} circle. Provide your contribution to this ${context.kind} meeting.

${context.kind === "governance" ? "For each governance item: state your position (consent / concern / objection) with reasoning." : "Share your perspective on the circle's current priorities, what's working, and what needs attention."}

Keep your contribution focused and concise (3-5 paragraphs).`;

    const response = await deps.callLLM({
      systemPrompt: `You are agent ${memberId} participating in a circle ${context.kind} meeting.`,
      userPrompt,
      agentId: memberId,
      ...(signal ? { signal } : {}),
    });

    contributions.push({
      agentId: memberId,
      content: response.content,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
    });
    totalInput += response.inputTokens;
    totalOutput += response.outputTokens;
  }

  // Phase 2: Facilitator synthesis
  const allContributions = contributions
    .map((c) => `### ${c.agentId}\n${c.content}`)
    .join("\n\n");

  const facilitatorPrompt = `${circleContext}${directiveSection}

## All member contributions

${allContributions}

---

You are ${context.facilitator}, the facilitator of the ${context.circleId} circle. Synthesize all member contributions into a meeting summary.

${context.kind === "governance"
    ? `For each governance item:
- Tally positions: how many consent, how many concern, how many objection
- If all consent (no objections): recommend RATIFY
- If objections exist: summarize each objection and recommend AMEND or ESCALATE
- Produce a clear decision recommendation for each item`
    : `Produce:
1. KEY DECISIONS — what the circle agreed on
2. ACTION ITEMS — who does what by when
3. TENSIONS — any new tensions to file for governance
4. NEXT MEETING — what to revisit`}

End with a one-paragraph meeting summary.`;

  const synthesis = await deps.callLLM({
    systemPrompt: `You are ${context.facilitator}, facilitator of the ${context.circleId} circle. You synthesize member contributions into clear meeting outcomes.`,
    userPrompt: facilitatorPrompt,
    agentId: context.facilitator,
    signal,
  });

  totalInput += synthesis.inputTokens;
  totalOutput += synthesis.outputTokens;

  return {
    circleId: context.circleId,
    kind: context.kind,
    contributions,
    synthesis: synthesis.content,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    governanceEvents: [], // populated by the caller based on synthesis parsing
  };
};
