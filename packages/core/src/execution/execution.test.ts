import { describe, expect, it } from "vitest";

import {
  isCompleted,
  isFailed,
  parseSelfReflection,
  renderSignalForPrompt,
  validateWake,
  amendWakeSummaryWithValidation,
  isKilled,
  isTimedOut,
  makeAgentId,
  makeGroupId,
  makeWakeId,
  parseWakeActions,
  type AgentResult,
  type CostBudget,
  type ResolvedModel,
} from "./index.js";
import { SpawnError, HandleUnknownError, InternalExecutorError } from "./index.js";

describe("branded primitives", () => {
  it("makeAgentId produces a discriminated object", () => {
    const id = makeAgentId("08-editorial");
    expect(id.kind).toBe("agent-id");
    expect(id.value).toBe("08-editorial");
  });

  it("makeGroupId produces a discriminated object", () => {
    const id = makeGroupId("content");
    expect(id.kind).toBe("group-id");
    expect(id.value).toBe("content");
  });

  it("makeWakeId produces a discriminated object", () => {
    const id = makeWakeId("abc-123");
    expect(id.kind).toBe("wake-id");
    expect(id.value).toBe("abc-123");
  });
});

describe("error taxonomy", () => {
  it("SpawnError has spawn-failed code and preserves wakeId", () => {
    const wakeId = makeWakeId("w1");
    const err = new SpawnError("fork failed", { wakeId });
    expect(err.code).toBe("spawn-failed");
    expect(err.wakeId?.value).toBe("w1");
    expect(err.message).toBe("fork failed");
  });

  it("HandleUnknownError has handle-unknown code", () => {
    const err = new HandleUnknownError("no such handle");
    expect(err.code).toBe("handle-unknown");
  });

  it("InternalExecutorError is the escape hatch with internal code", () => {
    const err = new InternalExecutorError("something exploded");
    expect(err.code).toBe("internal");
  });

  it("errors expose cause when provided", () => {
    const root = new Error("original");
    const err = new SpawnError("wrapper", { cause: root });
    expect(err.cause).toBe(root);
  });
});

describe("outcome type guards", () => {
  const model: ResolvedModel = {
    tier: "fast",
    provider: "test",
    model: "test-model",
    maxTokens: 1024,
  };
  const budget: CostBudget = {
    maxInputTokens: 1000,
    maxOutputTokens: 1000,
    maxWallClockMs: 5000,
    model,
    maxCostMicros: 10_000,
  };
  const baseResult = {
    wakeId: makeWakeId("w-guard"),
    agentId: makeAgentId("guard-agent"),
    outputs: [],
    governanceEvents: [],
    cost: {
      inputTokens: 0,
      outputTokens: 0,
      wallClockMs: 100,
      costMicros: 0,
      budgetOverrunEvents: 0,
    },
    wakeSummary: "",
    actions: [],
    actionReceipts: [],
    startedAt: new Date(0),
    finishedAt: new Date(100),
  };

  it("isCompleted narrows correctly", () => {
    const result: AgentResult = {
      ...baseResult,
      outcome: { kind: "completed" },
    };
    expect(isCompleted(result)).toBe(true);
    expect(isFailed(result)).toBe(false);
    expect(isKilled(result)).toBe(false);
    expect(isTimedOut(result)).toBe(false);
  });

  it("isFailed narrows correctly", () => {
    const result: AgentResult = {
      ...baseResult,
      outcome: {
        kind: "failed",
        error: new InternalExecutorError("boom"),
      },
    };
    expect(isFailed(result)).toBe(true);
    expect(isCompleted(result)).toBe(false);
  });

  it("isTimedOut exposes budget via the narrowed type", () => {
    const result: AgentResult = {
      ...baseResult,
      outcome: { kind: "timed-out", budget },
    };
    expect(isTimedOut(result)).toBe(true);
    if (isTimedOut(result)) {
      expect(result.outcome.budget.maxWallClockMs).toBe(5000);
    }
  });

  it("isKilled exposes reason via the narrowed type", () => {
    const result: AgentResult = {
      ...baseResult,
      outcome: { kind: "killed", reason: "operator requested" },
    };
    expect(isKilled(result)).toBe(true);
    if (isKilled(result)) {
      expect(result.outcome.reason).toBe("operator requested");
    }
  });

  it("guards are mutually exclusive", () => {
    const results: AgentResult[] = [
      { ...baseResult, outcome: { kind: "completed" } },
      {
        ...baseResult,
        outcome: { kind: "failed", error: new InternalExecutorError("x") },
      },
      { ...baseResult, outcome: { kind: "killed", reason: "x" } },
      { ...baseResult, outcome: { kind: "timed-out", budget } },
    ];
    for (const result of results) {
      const trueCount = [isCompleted, isFailed, isKilled, isTimedOut].filter((guard) =>
        guard(result),
      ).length;
      expect(trueCount).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// parseWakeActions
// ---------------------------------------------------------------------------

describe("parseWakeActions", () => {
  it("parses actions from a fenced ```actions block", () => {
    const text = `Here is my output.

\`\`\`actions
[
  {"kind": "label-issue", "issueNumber": 42, "label": "priority:high"},
  {"kind": "close-issue", "issueNumber": 259}
]
\`\`\``;

    const actions = parseWakeActions(text);
    expect(actions).toHaveLength(2);
    expect(actions[0]?.kind).toBe("label-issue");
    expect(actions[1]?.kind).toBe("close-issue");
  });

  it("parses commit-file actions", () => {
    const text = `\`\`\`actions
[{"kind": "commit-file", "filePath": "drafts/article.md", "fileContent": "# Title\\n\\nBody"}]
\`\`\``;

    const actions = parseWakeActions(text);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.kind).toBe("commit-file");
    expect(actions[0]?.filePath).toBe("drafts/article.md");
  });

  it("returns empty array when no fenced block", () => {
    expect(parseWakeActions("no actions here")).toEqual([]);
  });

  it("filters invalid actions", () => {
    const text = `\`\`\`actions
[
  {"kind": "label-issue", "issueNumber": 1, "label": "ok"},
  {"kind": "nuke-repo"},
  {"kind": "commit-file"}
]
\`\`\``;

    const actions = parseWakeActions(text);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.kind).toBe("label-issue");
  });
});

// ---------------------------------------------------------------------------
// validateWake
// ---------------------------------------------------------------------------

describe("validateWake", () => {
  const emptyResult = { actions: [], outputs: [], governanceEvents: [], wakeSummary: "" };
  const emptyContext = { actionItems: [], signals: [] };

  const makeIssueSignal = (
    number: number,
    extraLabels: readonly string[] = ["action-item", "assigned:test"],
  ) => ({
    kind: "github-issue" as const,
    id: `github-issue:x/y#${String(number)}`,
    trust: "trusted" as const,
    fetchedAt: new Date(),
    number,
    title: `Issue ${String(number)}`,
    url: `https://x/${String(number)}`,
    labels: extraLabels,
    excerpt: "",
  });

  it("marks wake as idle when no artifacts produced and no action items", () => {
    const v = validateWake(emptyContext, emptyResult, []);
    expect(v.productive).toBe(false);
    expect(v.artifactCount).toBe(0);
    expect(v.directivesUnaddressed).toEqual([]);
    expect(v.reason).toContain("no artifacts");
  });

  it("marks wake as productive when actions succeed", () => {
    const receipts = [
      { action: { kind: "label-issue" as const, issueNumber: 1, label: "x" }, success: true },
    ];
    const v = validateWake(emptyContext, emptyResult, receipts);
    expect(v.productive).toBe(true);
    expect(v.artifactCount).toBe(1);
  });

  it("counts action items addressed by structured action receipt (Boundary 5: not by wakeSummary mention)", () => {
    const actionItems = [makeIssueSignal(259, ["action-item", "assigned:02-content-production"])];
    const result = { ...emptyResult, wakeSummary: "Addressed #259 — coordinated with team." };
    const receipts = [
      {
        action: { kind: "comment-issue" as const, issueNumber: 259, body: "done" },
        success: true,
      },
    ];
    const v = validateWake({ actionItems, signals: [] }, result, receipts);
    expect(v.actionItemsAssigned).toBe(1);
    expect(v.actionItemsAddressed).toBe(1);
    expect(v.productive).toBe(true);
  });

  it("does NOT count an action item as addressed when only mentioned in wakeSummary (Boundary 5)", () => {
    const actionItems = [makeIssueSignal(259, ["action-item", "assigned:test"])];
    const result = {
      ...emptyResult,
      wakeSummary: "I have addressed #259 — review complete.",
    };
    const v = validateWake({ actionItems, signals: [] }, result, []);
    expect(v.actionItemsAssigned).toBe(1);
    expect(v.actionItemsAddressed).toBe(0);
    expect(v.productive).toBe(false);
    expect(v.reason).toContain("none addressed");
  });

  it("flags unaddressed action items", () => {
    const actionItems = [makeIssueSignal(100, ["action-item", "assigned:test"])];
    const v = validateWake({ actionItems, signals: [] }, emptyResult, []);
    expect(v.productive).toBe(false);
    expect(v.actionItemsAssigned).toBe(1);
    expect(v.actionItemsAddressed).toBe(0);
    expect(v.reason).toContain("none addressed");
  });

  it("counts governance events as artifacts", () => {
    const result = { ...emptyResult, governanceEvents: [{ kind: "tension", payload: {} }] };
    const v = validateWake(emptyContext, result, []);
    expect(v.productive).toBe(true);
    expect(v.artifactCount).toBe(1);
  });

  it("handles mixed addressed and unaddressed action items via structured actions only", () => {
    const actionItems = [
      makeIssueSignal(10, ["action-item", "assigned:x"]),
      makeIssueSignal(20, ["action-item", "assigned:x"]),
    ];
    const receipts = [
      { action: { kind: "label-issue" as const, issueNumber: 10, label: "ok" }, success: true },
    ];
    const v = validateWake(
      { actionItems, signals: [] },
      { ...emptyResult, wakeSummary: "Addressed #10 but mentioned #20." },
      receipts,
    );
    expect(v.actionItemsAssigned).toBe(2);
    expect(v.actionItemsAddressed).toBe(1); // #20 mention does NOT count
    expect(v.productive).toBe(true); // #10 is addressed
  });

  // Boundary 5 Phase 1 — directive validation

  it("counts a directive as addressed when a successful comment-issue receipt targets it", () => {
    const directive = makeIssueSignal(592, [
      "source-directive",
      "tier: consent",
      "assigned:architecture-agent",
    ]);
    const receipts = [
      {
        action: { kind: "comment-issue" as const, issueNumber: 592, body: "CONSENT" },
        success: true,
      },
    ];
    const v = validateWake({ actionItems: [], signals: [directive] }, emptyResult, receipts);
    expect(v.directivesUnaddressed).toEqual([]);
    expect(v.productive).toBe(true);
  });

  it("flags a directive as unaddressed (narrative-only-claim) when wakeSummary mentions it but no action exists", () => {
    const directive = makeIssueSignal(592, ["source-directive", "assigned:architecture-agent"]);
    const result = {
      ...emptyResult,
      wakeSummary: "I have posted my CONSENT to the proposal on issue #592.",
    };
    const v = validateWake({ actionItems: [], signals: [directive] }, result, []);
    expect(v.directivesUnaddressed).toEqual([{ issueNumber: 592, reason: "narrative-only-claim" }]);
    expect(v.productive).toBe(false);
    expect(v.reason).toContain("not addressed by structured evidence");
  });

  it("flags a directive as no-structured-action when the wake produced nothing referring to it", () => {
    const directive = makeIssueSignal(571, ["source-directive", "assigned:architecture-agent"]);
    const v = validateWake({ actionItems: [], signals: [directive] }, emptyResult, []);
    expect(v.directivesUnaddressed).toEqual([{ issueNumber: 571, reason: "no-structured-action" }]);
    expect(v.productive).toBe(false);
  });

  it("flags a directive as no-successful-receipt when an action targeted it but the receipt failed", () => {
    const directive = makeIssueSignal(554, ["source-directive", "assigned:architecture-agent"]);
    const receipts = [
      {
        action: { kind: "comment-issue" as const, issueNumber: 554, body: "CONSENT" },
        success: false,
        error: "scope-violation",
      },
    ];
    const v = validateWake({ actionItems: [], signals: [directive] }, emptyResult, receipts);
    expect(v.directivesUnaddressed).toEqual([
      { issueNumber: 554, reason: "no-successful-receipt" },
    ]);
    expect(v.productive).toBe(false);
  });

  it("counts a directive as addressed when a governance event references the issue number (legitimate 'I cannot act' path)", () => {
    const directive = makeIssueSignal(592, ["source-directive", "assigned:test"]);
    const result = {
      ...emptyResult,
      governanceEvents: [
        {
          kind: "agent-governance-event" as const,
          payload: {
            topic: "TENSION: I cannot act on directive #592 because the github MCP is unavailable",
            observation: "tooling gap",
            effectiveness: "low" as const,
            agentId: makeAgentId("test-agent"),
            filedAt: "2026-04-30",
          },
          sourceAgentId: makeAgentId("test-agent"),
        },
      ],
    };
    const v = validateWake({ actionItems: [], signals: [directive] }, result, []);
    expect(v.directivesUnaddressed).toEqual([]);
    expect(v.productive).toBe(true);
  });

  it("dedupes a directive that appears in both signals and actionItems", () => {
    const directive = makeIssueSignal(592, ["source-directive", "assigned:test"]);
    const v = validateWake({ actionItems: [directive], signals: [directive] }, emptyResult, []);
    expect(v.directivesUnaddressed).toHaveLength(1);
    expect(v.directivesUnaddressed[0]?.issueNumber).toBe(592);
  });

  it("does not flag non-directive issues as unaddressed directives", () => {
    const actionItem = makeIssueSignal(100, ["action-item", "assigned:test"]);
    const v = validateWake({ actionItems: [actionItem], signals: [] }, emptyResult, []);
    expect(v.directivesUnaddressed).toEqual([]);
  });

  // Word-boundary regex: directive #5 must NOT be addressed by a governance
  // event mentioning #50, #54, or #592 (Kieran review finding).
  it("uses word-boundary matching: directive #5 is NOT satisfied by a governance event mentioning only #50", () => {
    const directive = makeIssueSignal(5, ["source-directive", "assigned:test"]);
    const result = {
      ...emptyResult,
      governanceEvents: [
        {
          kind: "agent-governance-event" as const,
          payload: {
            topic: "TENSION: review of #50 is blocked by tooling gap",
            observation: "noted",
            effectiveness: "low" as const,
            agentId: makeAgentId("test-agent"),
            filedAt: "2026-04-30",
          },
          sourceAgentId: makeAgentId("test-agent"),
        },
      ],
    };
    const v = validateWake({ actionItems: [], signals: [directive] }, result, []);
    expect(v.directivesUnaddressed).toEqual([{ issueNumber: 5, reason: "no-structured-action" }]);
  });

  it("uses word-boundary matching: directive #59 is NOT satisfied by a governance event mentioning only #592", () => {
    const directive = makeIssueSignal(59, ["source-directive", "assigned:test"]);
    const result = {
      ...emptyResult,
      governanceEvents: [
        {
          kind: "agent-governance-event" as const,
          payload: {
            topic: "TENSION on issue 592 about MCP gap",
            observation: "noted",
            effectiveness: "low" as const,
            agentId: makeAgentId("test-agent"),
            filedAt: "2026-04-30",
          },
          sourceAgentId: makeAgentId("test-agent"),
        },
      ],
    };
    const v = validateWake({ actionItems: [], signals: [directive] }, result, []);
    expect(v.directivesUnaddressed).toEqual([{ issueNumber: 59, reason: "no-structured-action" }]);
  });

  // Security review finding: a single multi-reference governance event must
  // satisfy at most one directive. An agent that lists 5 directive numbers
  // in one tension cannot silence validation for all 5.
  it("requires 1:1 directive-to-event matching: one multi-reference event satisfies at most one directive", () => {
    const dir1 = makeIssueSignal(592, ["source-directive", "assigned:test"]);
    const dir2 = makeIssueSignal(571, ["source-directive", "assigned:test"]);
    const dir3 = makeIssueSignal(554, ["source-directive", "assigned:test"]);
    const result = {
      ...emptyResult,
      governanceEvents: [
        {
          kind: "agent-governance-event" as const,
          payload: {
            topic:
              "TENSION: I cannot act on directives #592, #571, #554 because the github MCP is unavailable",
            observation: "tooling gap",
            effectiveness: "low" as const,
            agentId: makeAgentId("test-agent"),
            filedAt: "2026-04-30",
          },
          sourceAgentId: makeAgentId("test-agent"),
        },
      ],
    };
    const v = validateWake({ actionItems: [], signals: [dir1, dir2, dir3] }, result, []);
    // First directive (592) is claimed by the multi-reference event;
    // the other two are not claimed.
    expect(v.directivesUnaddressed).toHaveLength(2);
    expect(v.directivesUnaddressed.map((d) => d.issueNumber).sort((a, b) => a - b)).toEqual([
      554, 571,
    ]);
  });

  it("matches one event per directive: three separate per-directive tensions satisfy three directives", () => {
    const dir1 = makeIssueSignal(592, ["source-directive", "assigned:test"]);
    const dir2 = makeIssueSignal(571, ["source-directive", "assigned:test"]);
    const result = {
      ...emptyResult,
      governanceEvents: [
        {
          kind: "agent-governance-event" as const,
          payload: {
            topic: "TENSION: cannot act on directive #592 — tooling gap",
            observation: "noted",
            effectiveness: "low" as const,
            agentId: makeAgentId("test-agent"),
            filedAt: "2026-04-30",
          },
          sourceAgentId: makeAgentId("test-agent"),
        },
        {
          kind: "agent-governance-event" as const,
          payload: {
            topic: "TENSION: cannot act on directive #571 — same root cause",
            observation: "noted",
            effectiveness: "low" as const,
            agentId: makeAgentId("test-agent"),
            filedAt: "2026-04-30",
          },
          sourceAgentId: makeAgentId("test-agent"),
        },
      ],
    };
    const v = validateWake({ actionItems: [], signals: [dir1, dir2] }, result, []);
    expect(v.directivesUnaddressed).toEqual([]);
  });

  it("does not crash when a governance event payload is non-serializable (circular)", () => {
    const directive = makeIssueSignal(592, ["source-directive", "assigned:test"]);
    type CircularPayload = { readonly self?: CircularPayload; readonly note: string };
    const circular: { self?: CircularPayload; note: string } = { note: "x" };
    circular.self = circular as CircularPayload;
    const result = {
      ...emptyResult,
      governanceEvents: [
        {
          kind: "agent-governance-event" as const,
          payload: circular as unknown as Record<string, unknown>,
          sourceAgentId: makeAgentId("test-agent"),
        },
      ],
    };
    expect(() => validateWake({ actionItems: [], signals: [directive] }, result, [])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// amendWakeSummaryWithValidation (Boundary 5 Phase 1)
// ---------------------------------------------------------------------------

describe("amendWakeSummaryWithValidation", () => {
  const baseSummary = `[architecture-agent] wake abc12345
  model: gemini-2.5-pro
  input_tokens: 25953
  output_tokens: 2623
  steps: 1 / 256
  tool_calls: 0
  signal_count: 8
  effectiveness: high
  governance_event: REPORT: completed all assigned items.`;

  it("returns the summary unchanged when there are no unaddressed directives", () => {
    const v = {
      productive: true,
      artifactCount: 1,
      actionItemsAddressed: 0,
      actionItemsAssigned: 0,
      directivesUnaddressed: [],
    };
    expect(amendWakeSummaryWithValidation(baseSummary, v)).toBe(baseSummary);
  });

  it("inserts a directives_unaddressed line after signal_count", () => {
    const v = {
      productive: false,
      artifactCount: 0,
      actionItemsAddressed: 0,
      actionItemsAssigned: 0,
      directivesUnaddressed: [
        { issueNumber: 592, reason: "narrative-only-claim" as const },
        { issueNumber: 571, reason: "no-structured-action" as const },
      ],
    };
    const amended = amendWakeSummaryWithValidation(baseSummary, v);
    expect(amended).toContain(
      "directives_unaddressed: 2 (#592 narrative-only-claim, #571 no-structured-action)",
    );
    // It should appear AFTER the signal_count line and BEFORE effectiveness
    const signalIdx = amended.indexOf("signal_count:");
    const directivesIdx = amended.indexOf("directives_unaddressed:");
    const effIdx = amended.indexOf("effectiveness:");
    expect(signalIdx).toBeLessThan(directivesIdx);
    expect(directivesIdx).toBeLessThan(effIdx);
  });

  it("downgrades 'effectiveness: high' to 'low' with attribution when directives are unaddressed", () => {
    const v = {
      productive: false,
      artifactCount: 0,
      actionItemsAddressed: 0,
      actionItemsAssigned: 0,
      directivesUnaddressed: [{ issueNumber: 592, reason: "narrative-only-claim" as const }],
    };
    const amended = amendWakeSummaryWithValidation(baseSummary, v);
    expect(amended).toMatch(
      /effectiveness:\s+low \(downgraded from agent-reported 'high' due to 1 unaddressed directive\)/,
    );
    expect(amended).not.toMatch(/^\s+effectiveness:\s+high\s*$/m);
  });

  it("uses singular 'directive' for one and plural 'directives' for many in the downgrade attribution", () => {
    const v1 = {
      productive: false,
      artifactCount: 0,
      actionItemsAddressed: 0,
      actionItemsAssigned: 0,
      directivesUnaddressed: [{ issueNumber: 1, reason: "no-structured-action" as const }],
    };
    expect(amendWakeSummaryWithValidation(baseSummary, v1)).toContain("1 unaddressed directive)");

    const v2 = {
      ...v1,
      directivesUnaddressed: [
        { issueNumber: 1, reason: "no-structured-action" as const },
        { issueNumber: 2, reason: "narrative-only-claim" as const },
      ],
    };
    expect(amendWakeSummaryWithValidation(baseSummary, v2)).toContain("2 unaddressed directives)");
  });

  it("does not modify the effectiveness line when it is not 'high'", () => {
    const lowSummary = baseSummary.replace("effectiveness: high", "effectiveness: low");
    const v = {
      productive: false,
      artifactCount: 0,
      actionItemsAddressed: 0,
      actionItemsAssigned: 0,
      directivesUnaddressed: [{ issueNumber: 1, reason: "narrative-only-claim" as const }],
    };
    const amended = amendWakeSummaryWithValidation(lowSummary, v);
    expect(amended).toContain("effectiveness: low");
    expect(amended).not.toContain("downgraded");
  });

  it("appends directives_unaddressed line at the end when no signal_count line exists", () => {
    const minimalSummary = "[agent] wake xyz\n  model: test\n";
    const v = {
      productive: false,
      artifactCount: 0,
      actionItemsAddressed: 0,
      actionItemsAssigned: 0,
      directivesUnaddressed: [{ issueNumber: 1, reason: "no-structured-action" as const }],
    };
    const amended = amendWakeSummaryWithValidation(minimalSummary, v);
    expect(amended).toContain("directives_unaddressed: 1 (#1 no-structured-action)");
  });

  it("commit-file without fileContent is invalid", () => {
    const text = '```actions\n[{"kind": "commit-file", "filePath": "a.md"}]\n```';
    expect(parseWakeActions(text)).toHaveLength(0);
  });

  it("commit-file without filePath is invalid", () => {
    const text = '```actions\n[{"kind": "commit-file", "fileContent": "hello"}]\n```';
    expect(parseWakeActions(text)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// parseSelfReflection
// ---------------------------------------------------------------------------

describe("parseSelfReflection", () => {
  it("parses a standard self-reflection block", () => {
    const text = `Some output here.

## Self-Reflection
EFFECTIVENESS: high
OBSERVATION: All action items were addressed.
GOVERNANCE_EVENT: Editorial Calendar did not provide a brief.`;

    const r = parseSelfReflection(text);
    expect(r.effectiveness).toBe("high");
    expect(r.observation).toBe("All action items were addressed.");
    expect(r.governanceEvent).toBe("Editorial Calendar did not provide a brief.");
  });

  it("parses legacy TENSION format", () => {
    const text = `## Self-Reflection
EFFECTIVENESS: medium
OBSERVATION: Partially completed.
TENSION: Pipeline is blocked by missing QA artifact.`;

    const r = parseSelfReflection(text);
    expect(r.effectiveness).toBe("medium");
    expect(r.governanceEvent).toBe("Pipeline is blocked by missing QA artifact.");
  });

  it("returns null governanceEvent when none filed", () => {
    const text = `## Self-Reflection
EFFECTIVENESS: low
OBSERVATION: No signals received.
GOVERNANCE_EVENT: none`;

    const r = parseSelfReflection(text);
    expect(r.effectiveness).toBe("low");
    expect(r.governanceEvent).toBeNull();
  });

  it("returns unknown effectiveness when not parseable", () => {
    const r = parseSelfReflection("no self-reflection block at all");
    expect(r.effectiveness).toBe("unknown");
    expect(r.observation).toBe("");
    expect(r.governanceEvent).toBeNull();
  });

  it("prefers GOVERNANCE_EVENT over TENSION when both present", () => {
    const text = `## Self-Reflection
EFFECTIVENESS: high
OBSERVATION: Done.
GOVERNANCE_EVENT: Pipeline needs restructuring.
TENSION: Old tension format.`;

    const r = parseSelfReflection(text);
    expect(r.governanceEvent).toBe("Pipeline needs restructuring.");
  });
});

// ---------------------------------------------------------------------------
// renderSignalForPrompt
// ---------------------------------------------------------------------------

describe("renderSignalForPrompt", () => {
  const baseSignal = {
    kind: "github-issue" as const,
    id: "test-1",
    fetchedAt: new Date(),
    number: 1,
    title: "Test",
    url: "https://x",
    labels: [],
    excerpt: "",
  };

  it("renders trusted signals as bare JSON", () => {
    const result = renderSignalForPrompt({ ...baseSignal, trust: "trusted" });
    expect(result).not.toContain("<");
    expect(result).toContain('"kind"');
  });

  it("wraps untrusted signals in delimiters", () => {
    const result = renderSignalForPrompt({ ...baseSignal, trust: "untrusted" });
    expect(result).toContain("<untrusted-signal>");
    expect(result).toContain("</untrusted-signal>");
  });

  it("wraps unknown trust signals in untrusted delimiters", () => {
    const result = renderSignalForPrompt({ ...baseSignal, trust: "unknown" });
    expect(result).toContain("<untrusted-signal>");
  });

  it("wraps semi-trusted signals in semi-trusted delimiters", () => {
    const result = renderSignalForPrompt({ ...baseSignal, trust: "semi-trusted" });
    expect(result).toContain("<semi-trusted-signal>");
    expect(result).toContain("</semi-trusted-signal>");
  });
});
