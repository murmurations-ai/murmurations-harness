import { describe, expect, it } from "vitest";

import {
  isCompleted,
  isFailed,
  parseSelfReflection,
  validateWake,
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

  it("marks wake as idle when no artifacts produced and no action items", () => {
    const v = validateWake({ actionItems: [] }, emptyResult, []);
    expect(v.productive).toBe(false);
    expect(v.artifactCount).toBe(0);
    expect(v.reason).toContain("no artifacts");
  });

  it("marks wake as productive when actions succeed", () => {
    const receipts = [
      { action: { kind: "label-issue" as const, issueNumber: 1, label: "x" }, success: true },
    ];
    const v = validateWake({ actionItems: [] }, emptyResult, receipts);
    expect(v.productive).toBe(true);
    expect(v.artifactCount).toBe(1);
  });

  it("counts action items addressed by issue number in wake summary", () => {
    const actionItems = [
      {
        kind: "github-issue" as const,
        id: "github-issue:x/y#259",
        trust: "trusted" as const,
        fetchedAt: new Date(),
        number: 259,
        title: "Action item",
        url: "https://x",
        labels: ["action-item", "assigned:02-content-production"],
        excerpt: "",
      },
    ];
    const result = { ...emptyResult, wakeSummary: "Addressed #259 — coordinated with team." };
    const v = validateWake({ actionItems }, result, []);
    expect(v.actionItemsAssigned).toBe(1);
    expect(v.actionItemsAddressed).toBe(1);
    expect(v.productive).toBe(true);
  });

  it("flags unaddressed action items", () => {
    const actionItems = [
      {
        kind: "github-issue" as const,
        id: "github-issue:x/y#100",
        trust: "trusted" as const,
        fetchedAt: new Date(),
        number: 100,
        title: "Do something",
        url: "https://x",
        labels: ["action-item", "assigned:test"],
        excerpt: "",
      },
    ];
    const v = validateWake({ actionItems }, emptyResult, []);
    expect(v.productive).toBe(false);
    expect(v.actionItemsAssigned).toBe(1);
    expect(v.actionItemsAddressed).toBe(0);
    expect(v.reason).toContain("none addressed");
  });

  it("counts governance events as artifacts", () => {
    const result = { ...emptyResult, governanceEvents: [{ kind: "tension", payload: {} }] };
    const v = validateWake({ actionItems: [] }, result, []);
    expect(v.productive).toBe(true);
    expect(v.artifactCount).toBe(1);
  });

  it("handles mixed addressed and unaddressed action items", () => {
    const actionItems = [
      {
        kind: "github-issue" as const,
        id: "a",
        trust: "trusted" as const,
        fetchedAt: new Date(),
        number: 10,
        title: "A",
        url: "x",
        labels: ["action-item", "assigned:x"],
        excerpt: "",
      },
      {
        kind: "github-issue" as const,
        id: "b",
        trust: "trusted" as const,
        fetchedAt: new Date(),
        number: 20,
        title: "B",
        url: "x",
        labels: ["action-item", "assigned:x"],
        excerpt: "",
      },
    ];
    const result = { ...emptyResult, wakeSummary: "Addressed #10 but not the other." };
    const v = validateWake({ actionItems }, result, []);
    expect(v.actionItemsAssigned).toBe(2);
    expect(v.actionItemsAddressed).toBe(1);
    expect(v.productive).toBe(true);
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
});
