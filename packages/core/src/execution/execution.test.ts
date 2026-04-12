import { describe, expect, it } from "vitest";

import {
  isCompleted,
  isFailed,
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
