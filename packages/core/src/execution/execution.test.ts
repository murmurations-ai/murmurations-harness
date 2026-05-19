import { describe, expect, it } from "vitest";

import {
  isCompleted,
  isFailed,
  parseSelfReflection,
  renderSignalForPrompt,
  validateBehavior,
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
  type Signal,
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
// validateWake
// ---------------------------------------------------------------------------

describe("validateWake", () => {
  const emptyResult = { actions: [], outputs: [], governanceEvents: [], wakeSummary: "" };

  // Context builder — defaults agentId to "test" with no groups so that
  // directives labeled "assigned:test" are counted as accountability.
  // Pass agentId explicitly when the directive label differs (e.g. "architecture-agent").
  const mkCtx = (
    opts: {
      actionItems?: readonly Signal[];
      signals?: readonly Signal[];
      agentId?: string;
      groupIds?: readonly string[];
    } = {},
  ) => ({
    actionItems: opts.actionItems ?? [],
    signals: opts.signals ?? [],
    agentId: opts.agentId ?? "test",
    groupIds: opts.groupIds ?? [],
  });

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
    const v = validateWake(mkCtx(), emptyResult, []);
    expect(v.productive).toBe(false);
    expect(v.artifactCount).toBe(0);
    expect(v.directivesUnaddressed).toEqual([]);
    expect(v.reason).toContain("no artifacts");
  });

  it("marks wake as productive when actions succeed", () => {
    const receipts = [
      { action: { kind: "label-issue" as const, issueNumber: 1, label: "x" }, success: true },
    ];
    const v = validateWake(mkCtx(), emptyResult, receipts);
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
    const v = validateWake(mkCtx({ actionItems }), result, receipts);
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
    const v = validateWake(mkCtx({ actionItems }), result, []);
    expect(v.actionItemsAssigned).toBe(1);
    expect(v.actionItemsAddressed).toBe(0);
    expect(v.productive).toBe(false);
    expect(v.reason).toContain("none addressed");
  });

  it("does NOT count an action item as addressed when its receipt failed (Boundary 5)", () => {
    // Same anti-pattern as a wakeSummary-only mention: the agent emitted
    // an action but it never landed (write-scope violation, GitHub error,
    // dry-run). Treat as not addressed.
    const actionItems = [makeIssueSignal(100, ["action-item", "assigned:test"])];
    const result = {
      ...emptyResult,
      actions: [{ kind: "comment-issue" as const, issueNumber: 100, body: "done" }],
    };
    const receipts = [
      {
        action: { kind: "comment-issue" as const, issueNumber: 100, body: "done" },
        success: false,
        error: "scope-violation",
      },
    ];
    const v = validateWake(mkCtx({ actionItems }), result, receipts);
    expect(v.actionItemsAssigned).toBe(1);
    expect(v.actionItemsAddressed).toBe(0);
    expect(v.productive).toBe(false);
  });

  it("does NOT count an action item as addressed when an action was returned but never executed (no receipt)", () => {
    // Intent without execution is the same Boundary 5 anti-pattern.
    const actionItems = [makeIssueSignal(101, ["action-item", "assigned:test"])];
    const result = {
      ...emptyResult,
      actions: [{ kind: "comment-issue" as const, issueNumber: 101, body: "done" }],
    };
    const v = validateWake(mkCtx({ actionItems }), result, []);
    expect(v.actionItemsAssigned).toBe(1);
    expect(v.actionItemsAddressed).toBe(0);
    expect(v.productive).toBe(false);
  });

  it("flags unaddressed action items", () => {
    const actionItems = [makeIssueSignal(100, ["action-item", "assigned:test"])];
    const v = validateWake(mkCtx({ actionItems }), emptyResult, []);
    expect(v.productive).toBe(false);
    expect(v.actionItemsAssigned).toBe(1);
    expect(v.actionItemsAddressed).toBe(0);
    expect(v.reason).toContain("none addressed");
  });

  it("counts governance events as artifacts", () => {
    const result = { ...emptyResult, governanceEvents: [{ kind: "tension", payload: {} }] };
    const v = validateWake(mkCtx(), result, []);
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
      mkCtx({ actionItems }),
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
    const v = validateWake(
      mkCtx({ signals: [directive], agentId: "architecture-agent" }),
      emptyResult,
      receipts,
    );
    expect(v.directivesUnaddressed).toEqual([]);
    expect(v.productive).toBe(true);
  });

  it("flags a directive as unaddressed (narrative-only-claim) when wakeSummary mentions it but no action exists", () => {
    const directive = makeIssueSignal(592, ["source-directive", "assigned:architecture-agent"]);
    const result = {
      ...emptyResult,
      wakeSummary: "I have posted my CONSENT to the proposal on issue #592.",
    };
    const v = validateWake(
      mkCtx({ signals: [directive], agentId: "architecture-agent" }),
      result,
      [],
    );
    expect(v.directivesUnaddressed).toEqual([{ issueNumber: 592, reason: "narrative-only-claim" }]);
    expect(v.productive).toBe(false);
    expect(v.reason).toContain("not addressed by structured evidence");
  });

  // -------------------------------------------------------------------------
  // GitHub issue URL counts as structural evidence
  // -------------------------------------------------------------------------

  it("treats a full GitHub issue URL in wakeSummary as structural evidence", () => {
    const directive = makeIssueSignal(845, ["source-directive", "assigned:engineering-agent"]);
    const result = {
      ...emptyResult,
      wakeSummary:
        "Posted consent at https://github.com/xeeban/emergent-praxis/issues/845#issuecomment-4438893756. Round complete.",
    };
    const v = validateWake(
      mkCtx({ signals: [directive], agentId: "engineering-agent" }),
      result,
      [],
    );
    expect(v.directivesUnaddressed).toEqual([]);
  });

  it("treats a bare issue URL (no comment anchor) as structural evidence", () => {
    const directive = makeIssueSignal(845, ["source-directive", "assigned:engineering-agent"]);
    const result = {
      ...emptyResult,
      wakeSummary: "Done — see https://github.com/xeeban/emergent-praxis/issues/845",
    };
    const v = validateWake(
      mkCtx({ signals: [directive], agentId: "engineering-agent" }),
      result,
      [],
    );
    expect(v.directivesUnaddressed).toEqual([]);
  });

  it("URL evidence works in governance event payloads too", () => {
    const directive = makeIssueSignal(845, ["source-directive", "assigned:engineering-agent"]);
    const result = {
      ...emptyResult,
      wakeSummary: "Round complete.",
      governanceEvents: [
        {
          kind: "report",
          payload: {
            note: "Posted consent at https://github.com/xeeban/emergent-praxis/issues/845",
          },
        },
      ],
    };
    const v = validateWake(
      mkCtx({ signals: [directive], agentId: "engineering-agent" }),
      result,
      [],
    );
    expect(v.directivesUnaddressed).toEqual([]);
  });

  it("URL word boundary: /issues/845 in the wake does not satisfy a directive on #84", () => {
    // Directive on #84, but wakeSummary mentions #84 narratively AND has a
    // URL pointing at #845 — the URL must NOT count as evidence for #84,
    // and the bare #84 mention should still be flagged narrative-only-claim.
    const directive = makeIssueSignal(84, ["source-directive", "assigned:engineering-agent"]);
    const result = {
      ...emptyResult,
      wakeSummary:
        "Reviewed #84 narratively. Filed related URL: https://github.com/xeeban/emergent-praxis/issues/845",
    };
    const v = validateWake(
      mkCtx({ signals: [directive], agentId: "engineering-agent" }),
      result,
      [],
    );
    expect(v.directivesUnaddressed).toEqual([{ issueNumber: 84, reason: "narrative-only-claim" }]);
  });

  it("URL word boundary: /issues/845 does not satisfy a directive on issue 8450", () => {
    const directive = makeIssueSignal(8450, ["source-directive", "assigned:engineering-agent"]);
    const result = {
      ...emptyResult,
      wakeSummary: "Posted at https://github.com/xeeban/emergent-praxis/issues/845",
    };
    const v = validateWake(
      mkCtx({ signals: [directive], agentId: "engineering-agent" }),
      result,
      [],
    );
    expect(v.directivesUnaddressed).toEqual([
      { issueNumber: 8450, reason: "no-structured-action" },
    ]);
  });

  it("bare #845 reference without URL is still narrative-only-claim (URLs are the load-bearing signal)", () => {
    const directive = makeIssueSignal(845, ["source-directive", "assigned:engineering-agent"]);
    const result = {
      ...emptyResult,
      wakeSummary: "I have posted my CONSENT to issue #845.",
    };
    const v = validateWake(
      mkCtx({ signals: [directive], agentId: "engineering-agent" }),
      result,
      [],
    );
    expect(v.directivesUnaddressed).toEqual([{ issueNumber: 845, reason: "narrative-only-claim" }]);
  });

  it("flags a directive as no-structured-action when the wake produced nothing referring to it", () => {
    const directive = makeIssueSignal(571, ["source-directive", "assigned:architecture-agent"]);
    const v = validateWake(
      mkCtx({ signals: [directive], agentId: "architecture-agent" }),
      emptyResult,
      [],
    );
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
    const v = validateWake(
      mkCtx({ signals: [directive], agentId: "architecture-agent" }),
      emptyResult,
      receipts,
    );
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
    const v = validateWake(mkCtx({ signals: [directive] }), result, []);
    expect(v.directivesUnaddressed).toEqual([]);
    expect(v.productive).toBe(true);
  });

  it("dedupes a directive that appears in both signals and actionItems", () => {
    const directive = makeIssueSignal(592, ["source-directive", "assigned:test"]);
    const v = validateWake(
      mkCtx({ actionItems: [directive], signals: [directive] }),
      emptyResult,
      [],
    );
    expect(v.directivesUnaddressed).toHaveLength(1);
    expect(v.directivesUnaddressed[0]?.issueNumber).toBe(592);
  });

  it("does not flag non-directive issues as unaddressed directives", () => {
    const actionItem = makeIssueSignal(100, ["action-item", "assigned:test"]);
    const v = validateWake(mkCtx({ actionItems: [actionItem] }), emptyResult, []);
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
    const v = validateWake(mkCtx({ signals: [directive] }), result, []);
    expect(v.directivesUnaddressed).toEqual([{ issueNumber: 5, reason: "no-structured-action" }]);
  });

  it("uses word-boundary matching for narrative-only-claim: directive #5 + wakeSummary mentioning only #592 classifies as no-structured-action, not narrative-only-claim", () => {
    // Without word-boundary matching, plain `wakeSummary.includes("#5")`
    // would false-positive on `#592` and misclassify the reason.
    const directive = makeIssueSignal(5, ["source-directive", "assigned:test"]);
    const result = {
      ...emptyResult,
      wakeSummary: "I have posted CONSENT on #592",
    };
    const v = validateWake(mkCtx({ signals: [directive] }), result, []);
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
    const v = validateWake(mkCtx({ signals: [directive] }), result, []);
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
    const v = validateWake(mkCtx({ signals: [dir1, dir2, dir3] }), result, []);
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
    const v = validateWake(mkCtx({ signals: [dir1, dir2] }), result, []);
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
    expect(() => validateWake(mkCtx({ signals: [directive] }), result, [])).not.toThrow();
  });

  // Routing filter tests

  it("skips a directive scoped to a different agent — does not count as unaddressed", () => {
    const directive = makeIssueSignal(100, ["source-directive", "assigned:other-agent"]);
    const v = validateWake(mkCtx({ signals: [directive] }), emptyResult, []);
    // Directive is not in this agent's routing set → not counted as accountability
    expect(v.directivesUnaddressed).toEqual([]);
  });

  it("counts a scope:all directive as this agent's accountability regardless of agentId", () => {
    const directive = makeIssueSignal(200, ["source-directive", "scope:all"]);
    const v = validateWake(mkCtx({ signals: [directive] }), emptyResult, []);
    expect(v.directivesUnaddressed).toEqual([{ issueNumber: 200, reason: "no-structured-action" }]);
  });

  it("counts a scope:group directive as accountability when agent is in that group", () => {
    const directive = makeIssueSignal(300, ["source-directive", "scope:group:circle-a"]);
    const v = validateWake(
      mkCtx({ signals: [directive], agentId: "alpha", groupIds: ["circle-a"] }),
      emptyResult,
      [],
    );
    expect(v.directivesUnaddressed).toEqual([{ issueNumber: 300, reason: "no-structured-action" }]);
  });

  it("skips a scope:group directive when agent is NOT in that group", () => {
    const directive = makeIssueSignal(300, ["source-directive", "scope:group:circle-b"]);
    const v = validateWake(
      mkCtx({ signals: [directive], agentId: "alpha", groupIds: ["circle-a"] }),
      emptyResult,
      [],
    );
    expect(v.directivesUnaddressed).toEqual([]);
  });

  it("multi-group agent: counts directives for any of its groups", () => {
    const d1 = makeIssueSignal(401, ["source-directive", "scope:group:circle-a"]);
    const d2 = makeIssueSignal(402, ["source-directive", "scope:group:circle-b"]);
    const d3 = makeIssueSignal(403, ["source-directive", "scope:group:circle-c"]);
    const v = validateWake(
      mkCtx({ signals: [d1, d2, d3], agentId: "alpha", groupIds: ["circle-a", "circle-b"] }),
      emptyResult,
      [],
    );
    // circle-c is not in this agent's groups → d3 skipped
    expect(v.directivesUnaddressed.map((d) => d.issueNumber).sort((a, b) => a - b)).toEqual([
      401, 402,
    ]);
  });

  // -------------------------------------------------------------------------
  // Contract obligation enforcement
  // -------------------------------------------------------------------------

  const baseBudget = {
    maxInputTokens: 0,
    maxOutputTokens: 0,
    maxWallClockMs: 60000,
    model: { tier: "balanced" as const, provider: "u", model: "u", maxTokens: 4096 },
    maxCostMicros: 0,
  };

  const mkContract = (
    requiredOutputs: readonly {
      readonly kind:
        | "summary"
        | "runtime-artifact"
        | "committed-artifact"
        | "comment"
        | "issue"
        | "commit"
        | "governance-event";
      readonly path?: string;
      readonly paths?: readonly string[];
      readonly description?: string;
    }[],
  ) => ({
    wakeReason: { kind: "scheduled" as const, cronExpression: "0 9 * * *" },
    wakeMode: "individual" as const,
    objective: "test objective",
    requiredOutputs: requiredOutputs.map((r) => ({
      kind: r.kind,
      ...(r.path !== undefined ? { path: r.path } : {}),
      ...(r.paths !== undefined ? { paths: r.paths } : {}),
      description: r.description ?? "test required output",
    })),
    actionItems: [],
    completionConditions: [],
    verification: [],
    allowedSideEffects: ["read" as const, "write" as const],
    budget: baseBudget,
    approval: { mode: "none" as const },
  });

  it("contract not-applicable when requiredOutputs is empty (heuristic still applies)", () => {
    const receipts = [
      { action: { kind: "label-issue" as const, issueNumber: 1, label: "x" }, success: true },
    ];
    const v = validateWake({ ...mkCtx(), contract: mkContract([]) }, emptyResult, receipts);
    expect(v.obligationStatus).toBe("not-applicable");
    expect(v.productive).toBe(true);
  });

  it("contract satisfied when all required outputs have matching successful evidence", () => {
    const contract = mkContract([
      { kind: "committed-artifact", path: "drafts/**/*.md" },
      { kind: "comment" },
    ]);
    const receipts = [
      {
        action: {
          kind: "commit-file" as const,
          filePath: "drafts/2026-05/article.md",
          fileContent: "x",
        },
        success: true,
      },
      {
        action: { kind: "comment-issue" as const, issueNumber: 100, body: "done" },
        success: true,
      },
    ];
    const v = validateWake({ ...mkCtx(), contract }, emptyResult, receipts);
    expect(v.obligationStatus).toBe("satisfied");
    expect(v.productive).toBe(true);
    expect(v.unmetRequiredOutputs).toBeUndefined();
  });

  it("contract unmet when a required output has no matching evidence — overrides heuristic productive", () => {
    const contract = mkContract([
      { kind: "committed-artifact", path: "drafts/**/*.md" },
      { kind: "comment" },
    ]);
    // Only the comment landed; the committed-artifact obligation is unmet.
    const receipts = [
      {
        action: { kind: "comment-issue" as const, issueNumber: 100, body: "done" },
        success: true,
      },
    ];
    const v = validateWake({ ...mkCtx(), contract }, emptyResult, receipts);
    expect(v.obligationStatus).toBe("unmet");
    expect(v.productive).toBe(false);
    expect(v.unmetRequiredOutputs).toHaveLength(1);
    expect(v.unmetRequiredOutputs?.[0]).toEqual({
      kind: "committed-artifact",
      path: "drafts/**/*.md",
    });
    expect(v.reason).toContain("contract obligation unmet");
  });

  it("path glob mismatch is unmet — commit to wrong directory does not satisfy", () => {
    const contract = mkContract([{ kind: "committed-artifact", path: "drafts/**/*.md" }]);
    const receipts = [
      {
        action: {
          kind: "commit-file" as const,
          filePath: "docs/legal/refund.md",
          fileContent: "x",
        },
        success: true,
      },
    ];
    const v = validateWake({ ...mkCtx(), contract }, emptyResult, receipts);
    expect(v.obligationStatus).toBe("unmet");
  });

  it("blob URL in wakeSummary satisfies a committed-artifact obligation", () => {
    const contract = mkContract([{ kind: "committed-artifact", path: "docs/research/**/*.md" }]);
    const result = {
      ...emptyResult,
      wakeSummary:
        "Filed research at https://github.com/xeeban/emergent-praxis/blob/main/docs/research/competitive-positioning-2026-05-14.md.",
    };
    const v = validateWake({ ...mkCtx(), contract }, result, []);
    expect(v.obligationStatus).toBe("satisfied");
  });

  it("blob URL with #L anchor strips to the path before matching", () => {
    const contract = mkContract([{ kind: "committed-artifact", path: "docs/**/*.md" }]);
    const result = {
      ...emptyResult,
      wakeSummary:
        "See https://github.com/xeeban/emergent-praxis/blob/main/docs/research/foo.md#L42 for details.",
    };
    const v = validateWake({ ...mkCtx(), contract }, result, []);
    expect(v.obligationStatus).toBe("satisfied");
  });

  it("blob URL whose path falls outside the glob does not satisfy", () => {
    const contract = mkContract([{ kind: "committed-artifact", path: "drafts/**/*.md" }]);
    const result = {
      ...emptyResult,
      wakeSummary:
        "Committed https://github.com/xeeban/emergent-praxis/blob/main/docs/legal/refund.md.",
    };
    const v = validateWake({ ...mkCtx(), contract }, result, []);
    expect(v.obligationStatus).toBe("unmet");
  });

  it("multiple blob URLs — one matching the glob is enough", () => {
    const contract = mkContract([{ kind: "committed-artifact", path: "drafts/**/*.md" }]);
    const result = {
      ...emptyResult,
      wakeSummary: [
        "Posted https://github.com/xeeban/emergent-praxis/blob/main/docs/legal/refund.md.",
        "Then drafted https://github.com/xeeban/emergent-praxis/blob/main/drafts/2026-05/article.md.",
      ].join(" "),
    };
    const v = validateWake({ ...mkCtx(), contract }, result, []);
    expect(v.obligationStatus).toBe("satisfied");
  });

  it("blob URL inside a governance event payload counts as evidence", () => {
    const contract = mkContract([{ kind: "committed-artifact", path: "docs/research/**/*.md" }]);
    const result = {
      ...emptyResult,
      wakeSummary: "Research complete.",
      governanceEvents: [
        {
          kind: "report",
          payload: {
            url: "https://github.com/xeeban/emergent-praxis/blob/main/docs/research/foo.md",
          },
        },
      ],
    };
    const v = validateWake({ ...mkCtx(), contract }, result, []);
    expect(v.obligationStatus).toBe("satisfied");
  });

  it("no receipt and no blob URL leaves a committed-artifact obligation unmet", () => {
    const contract = mkContract([{ kind: "committed-artifact", path: "drafts/**/*.md" }]);
    const result = {
      ...emptyResult,
      wakeSummary: "Drafted the article and was about to commit.",
    };
    const v = validateWake({ ...mkCtx(), contract }, result, []);
    expect(v.obligationStatus).toBe("unmet");
  });

  it("blob URL satisfies a committed-artifact obligation with no path declared", () => {
    const contract = mkContract([{ kind: "committed-artifact" }]);
    const result = {
      ...emptyResult,
      wakeSummary:
        "Committed https://github.com/xeeban/emergent-praxis/blob/main/anywhere/file.md.",
    };
    const v = validateWake({ ...mkCtx(), contract }, result, []);
    expect(v.obligationStatus).toBe("satisfied");
  });

  it("multi-path obligation: any matching commit-file receipt satisfies (OR semantics)", () => {
    const contract = mkContract([
      {
        kind: "committed-artifact",
        paths: ["drafts/**/*.md", "docs/research/**/*.md", "pipeline/**/*.md"],
      },
    ]);
    const receipts = [
      {
        action: {
          kind: "commit-file" as const,
          filePath: "docs/research/foo.md",
          fileContent: "x",
        },
        success: true,
      },
    ];
    const v = validateWake({ ...mkCtx(), contract }, emptyResult, receipts);
    expect(v.obligationStatus).toBe("satisfied");
  });

  it("multi-path obligation: any matching blob URL satisfies (URL fallback works with OR paths)", () => {
    const contract = mkContract([
      {
        kind: "committed-artifact",
        paths: ["drafts/**/*.md", "docs/research/**/*.md", "pipeline/**/*.md"],
      },
    ]);
    const result = {
      ...emptyResult,
      wakeSummary:
        "Filed at https://github.com/xeeban/emergent-praxis/blob/main/docs/research/digest.md.",
    };
    const v = validateWake({ ...mkCtx(), contract }, result, []);
    expect(v.obligationStatus).toBe("satisfied");
  });

  it("multi-path obligation: no matching path leaves the obligation unmet", () => {
    const contract = mkContract([
      {
        kind: "committed-artifact",
        paths: ["drafts/**/*.md", "docs/research/**/*.md", "pipeline/**/*.md"],
      },
    ]);
    const receipts = [
      {
        action: {
          kind: "commit-file" as const,
          filePath: "docs/legal/refund.md",
          fileContent: "x",
        },
        success: true,
      },
    ];
    const v = validateWake({ ...mkCtx(), contract }, emptyResult, receipts);
    expect(v.obligationStatus).toBe("unmet");
    expect(v.unmetRequiredOutputs).toHaveLength(1);
    expect(v.unmetRequiredOutputs?.[0]).toMatchObject({
      kind: "committed-artifact",
      paths: ["drafts/**/*.md", "docs/research/**/*.md", "pipeline/**/*.md"],
    });
  });

  it("paths wins over path when both are set on an obligation", () => {
    const contract = mkContract([
      {
        kind: "committed-artifact",
        path: "drafts/**/*.md",
        paths: ["docs/research/**/*.md"],
      },
    ]);
    // Receipt matches `paths[0]` but NOT `path` — should still satisfy (paths wins).
    const receipts = [
      {
        action: {
          kind: "commit-file" as const,
          filePath: "docs/research/foo.md",
          fileContent: "x",
        },
        success: true,
      },
    ];
    const v = validateWake({ ...mkCtx(), contract }, emptyResult, receipts);
    expect(v.obligationStatus).toBe("satisfied");
  });

  it("runtime-artifact required output is always satisfied (digest writer runs on completion)", () => {
    const contract = mkContract([{ kind: "runtime-artifact", path: ".murmuration/runs/**/*.md" }]);
    const v = validateWake({ ...mkCtx(), contract }, emptyResult, []);
    expect(v.obligationStatus).toBe("satisfied");
    // But the heuristic still flags zero artifacts, so productive stays false.
    expect(v.productive).toBe(false);
  });

  it("governance-event required output is satisfied when any governance event was emitted", () => {
    const contract = mkContract([{ kind: "governance-event" }]);
    const result = {
      ...emptyResult,
      governanceEvents: [{ kind: "test", payload: {} }],
    };
    const v = validateWake({ ...mkCtx(), contract }, result, []);
    expect(v.obligationStatus).toBe("satisfied");
  });

  it("obligationStatus is absent when no contract is passed (legacy callers unchanged)", () => {
    const v = validateWake(mkCtx(), emptyResult, []);
    expect(v.obligationStatus).toBeUndefined();
    expect(v.unmetRequiredOutputs).toBeUndefined();
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

  it("does not rewrite a body line that quotes 'effectiveness: high' from a prior digest", () => {
    // Header reports 'medium', body quotes a prior wake's `effectiveness: high`.
    // The downgrade attribution must touch only the header line; otherwise we
    // corrupt the persisted body and produce a lying attribution
    // ("downgraded from agent-reported 'high'" — agent reported 'medium').
    const summaryWithBody = `[agent] wake xyz
  model: test
  signal_count: 5
  effectiveness: medium
  governance_event: REPORT done

---

Last wake produced:
  signal_count: 8
  effectiveness: high
  governance_event: REPORT done
`;
    const v = {
      productive: false,
      artifactCount: 0,
      actionItemsAddressed: 0,
      actionItemsAssigned: 0,
      directivesUnaddressed: [{ issueNumber: 1, reason: "narrative-only-claim" as const }],
    };
    const amended = amendWakeSummaryWithValidation(summaryWithBody, v);
    expect(amended).toContain("\n  effectiveness: high\n");
    expect(amended).not.toContain("downgraded from agent-reported 'high'");
    expect(amended).toContain("  effectiveness: medium");
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

  it("does not parse bare TENSION: format (legacy format removed — use GOVERNANCE_EVENT:)", () => {
    const text = `## Self-Reflection
EFFECTIVENESS: medium
OBSERVATION: Partially completed.
TENSION: Pipeline is blocked by missing QA artifact.`;

    const r = parseSelfReflection(text);
    expect(r.effectiveness).toBe("medium");
    expect(r.governanceEvent).toBeNull();
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

  it("renders trusted signals as bare rich text (no XML wrapper)", () => {
    const result = renderSignalForPrompt({ ...baseSignal, trust: "trusted" });
    expect(result).not.toContain("<untrusted-signal>");
    expect(result).not.toContain("<semi-trusted-signal>");
    expect(result).toContain("[gh-issue #1]");
    expect(result).toContain("Test");
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

// ---------------------------------------------------------------------------
// validateBehavior (advisory warnings)
// ---------------------------------------------------------------------------

describe("validateBehavior", () => {
  const emptyResult = { actions: [], governanceEvents: [], wakeSummary: "" };

  it("returns no warnings when wake summary is empty", () => {
    const warnings = validateBehavior(emptyResult, []);
    expect(warnings).toEqual([]);
  });

  it("flags a 'posted to #N' narrative claim without a matching receipt", () => {
    const result = {
      ...emptyResult,
      wakeSummary: "Posted my consent position to #864. Round complete.",
    };
    const warnings = validateBehavior(result, []);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      kind: "narrative-action-without-evidence",
      issueNumber: 864,
      verb: "posted",
    });
  });

  it("does NOT flag when a successful comment-issue receipt matches", () => {
    const result = {
      ...emptyResult,
      wakeSummary: "Posted my consent position to #864.",
    };
    const warnings = validateBehavior(result, [
      {
        action: { kind: "comment-issue" as const, issueNumber: 864, body: "consent" },
        success: true,
      },
    ]);
    expect(warnings).toEqual([]);
  });

  it("does NOT flag when a GitHub URL for the issue is in the wake summary", () => {
    const result = {
      ...emptyResult,
      wakeSummary:
        "Posted consent at https://github.com/xeeban/emergent-praxis/issues/864#issuecomment-1234",
    };
    const warnings = validateBehavior(result, []);
    expect(warnings).toEqual([]);
  });

  it("does NOT flag when a GitHub URL is in a governance event payload", () => {
    const result = {
      ...emptyResult,
      wakeSummary: "Posted consent on #864.",
      governanceEvents: [
        {
          kind: "report",
          payload: { url: "https://github.com/xeeban/emergent-praxis/issues/864" },
        },
      ],
    };
    const warnings = validateBehavior(result, []);
    expect(warnings).toEqual([]);
  });

  it("flags a 'closed #N' claim without a matching close-issue receipt", () => {
    const result = {
      ...emptyResult,
      wakeSummary: "Closed #100 after Source ratified the proposal.",
    };
    const warnings = validateBehavior(result, []);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.verb).toBe("closed");
    expect(warnings[0]?.issueNumber).toBe(100);
  });

  it("flags a 'labeled #N' claim without a matching label-issue receipt", () => {
    const result = {
      ...emptyResult,
      wakeSummary: "Labeled #205 with priority:high.",
    };
    const warnings = validateBehavior(result, []);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.verb).toBe("labeled");
  });

  it("collects multiple warnings independently", () => {
    const result = {
      ...emptyResult,
      wakeSummary: "Posted on #100 and closed #200 and labeled #300 with done. None had receipts.",
    };
    const warnings = validateBehavior(result, []);
    expect(warnings).toHaveLength(3);
    expect(warnings.map((w) => w.issueNumber).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      100, 200, 300,
    ]);
  });

  it("word boundary: 'posted on #5' does NOT match a #50 receipt", () => {
    const result = {
      ...emptyResult,
      wakeSummary: "Posted on #5.",
    };
    const warnings = validateBehavior(result, [
      {
        action: { kind: "comment-issue" as const, issueNumber: 50, body: "x" },
        success: true,
      },
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.issueNumber).toBe(5);
  });
});

describe("validateWake — behaviorWarnings integration (warning-only)", () => {
  const ctx = { actionItems: [], signals: [], agentId: "test", groupIds: [] };

  it("includes behaviorWarnings on the validation result when narrative claims have no evidence", () => {
    const result = {
      actions: [],
      outputs: [],
      governanceEvents: [],
      wakeSummary: "Posted on #864 (no receipt, no URL).",
    };
    const v = validateWake(ctx, result, []);
    expect(v.behaviorWarnings).toBeDefined();
    expect(v.behaviorWarnings).toHaveLength(1);
  });

  it("does NOT mark wake non-productive when only behaviorWarnings fire (warning-only)", () => {
    const result = {
      actions: [],
      outputs: [],
      governanceEvents: [],
      // Successful action + a hallucinated claim on a different issue.
      wakeSummary: "Posted on #999 (hallucinated; no evidence).",
    };
    const receipts = [
      { action: { kind: "label-issue" as const, issueNumber: 1, label: "x" }, success: true },
    ];
    const v = validateWake(ctx, result, receipts);
    expect(v.productive).toBe(true);
    expect(v.behaviorWarnings).toHaveLength(1);
  });

  it("omits behaviorWarnings field when no warnings fire", () => {
    const result = {
      actions: [],
      outputs: [],
      governanceEvents: [],
      wakeSummary: "Routine wake, no issue references.",
    };
    const v = validateWake(ctx, result, []);
    expect(v.behaviorWarnings).toBeUndefined();
  });
});
