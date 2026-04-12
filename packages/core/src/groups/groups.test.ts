import { describe, expect, it } from "vitest";

import { parseMeetingActions, parseMeetingActionsWithMeta } from "./index.js";

describe("parseMeetingActions", () => {
  it("parses actions from a fenced ```actions block", () => {
    const text = `Here is my summary of the meeting.

\`\`\`actions
[
  {"kind": "label-issue", "issueNumber": 42, "label": "priority:high"},
  {"kind": "create-issue", "title": "Write Q2 roadmap", "labels": ["action-item", "assigned:01-research"]}
]
\`\`\`

That concludes the meeting.`;

    const actions = parseMeetingActions(text);
    expect(actions).toHaveLength(2);
    expect(actions[0]?.kind).toBe("label-issue");
    expect(actions[0]?.issueNumber).toBe(42);
    expect(actions[0]?.label).toBe("priority:high");
    expect(actions[1]?.kind).toBe("create-issue");
    expect(actions[1]?.title).toBe("Write Q2 roadmap");
  });

  it("parses actions from a fenced ```json block", () => {
    const text = `Summary here.

\`\`\`json
[{"kind": "close-issue", "issueNumber": 99}]
\`\`\``;

    const actions = parseMeetingActions(text);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.kind).toBe("close-issue");
    expect(actions[0]?.issueNumber).toBe(99);
  });

  it("returns empty array when no actions block found", () => {
    const text = "Just a regular meeting summary with no structured output.";
    expect(parseMeetingActions(text)).toEqual([]);
  });

  it("returns empty array for malformed JSON", () => {
    const text = "```actions\n{not valid json}\n```";
    expect(parseMeetingActions(text)).toEqual([]);
  });

  it("filters out invalid action kinds", () => {
    const text = `\`\`\`actions
[
  {"kind": "label-issue", "issueNumber": 1, "label": "priority:high"},
  {"kind": "delete-repo"},
  {"kind": "create-issue", "title": "Valid task"}
]
\`\`\``;

    const actions = parseMeetingActions(text);
    expect(actions).toHaveLength(2);
    expect(actions[0]?.kind).toBe("label-issue");
    expect(actions[1]?.kind).toBe("create-issue");
  });

  it("filters out actions missing required fields", () => {
    const text = `\`\`\`actions
[
  {"kind": "label-issue"},
  {"kind": "label-issue", "issueNumber": 1, "label": "ok"},
  {"kind": "create-issue"},
  {"kind": "close-issue"},
  {"kind": "comment-issue", "issueNumber": 1}
]
\`\`\``;

    const actions = parseMeetingActions(text);
    // Only the label-issue with all fields passes
    expect(actions).toHaveLength(1);
    expect(actions[0]?.kind).toBe("label-issue");
  });

  it("handles comment-issue with required body field", () => {
    const text = `\`\`\`actions
[{"kind": "comment-issue", "issueNumber": 5, "body": "Meeting decision: approved"}]
\`\`\``;

    const actions = parseMeetingActions(text);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.body).toBe("Meeting decision: approved");
  });

  it("extracts bare JSON array when no fenced block", () => {
    const text = `Here are the actions:
[{"kind": "label-issue", "issueNumber": 10, "label": "priority:medium"}]
Done.`;

    const actions = parseMeetingActions(text);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.issueNumber).toBe(10);
  });

  it("recovers actions from truncated output (maxOutputTokens hit)", () => {
    // Simulates LLM output that was cut off mid-array
    const text = `Here is the synthesis.

\`\`\`actions
[
  {"kind": "comment-issue", "issueNumber": 275, "body": "Resolved."},
  {"kind": "close-issue", "issueNumber": 275},
  {"kind": "comment-issue", "issueNumber": 259, "body": "This issue is a duplicate of #`;

    const actions = parseMeetingActions(text);
    // Should recover the 2 complete actions, skip the truncated 3rd
    expect(actions).toHaveLength(2);
    expect(actions[0]?.kind).toBe("comment-issue");
    expect(actions[0]?.issueNumber).toBe(275);
    expect(actions[1]?.kind).toBe("close-issue");
    expect(actions[1]?.issueNumber).toBe(275);
  });

  it("detects truncation and sets truncated flag", () => {
    const text =
      '```actions\n[\n  {"kind": "close-issue", "issueNumber": 1},\n  {"kind": "comment-issue", "issueNumber": 2, "body": "trun';
    const result = parseMeetingActionsWithMeta(text);
    expect(result.truncated).toBe(true);
    expect(result.actions).toHaveLength(1); // only the complete close-issue
    expect(result.actions[0]?.kind).toBe("close-issue");
  });

  it("sets truncated=false for complete output", () => {
    const text = '```actions\n[{"kind": "close-issue", "issueNumber": 1}]\n```';
    const result = parseMeetingActionsWithMeta(text);
    expect(result.truncated).toBe(false);
    expect(result.actions).toHaveLength(1);
  });

  it("parses removeLabel for state transition label swaps", () => {
    const text = `\`\`\`actions
[{"kind": "label-issue", "issueNumber": 42, "label": "state:ratified", "removeLabel": "state:deliberating"}]
\`\`\``;

    const actions = parseMeetingActions(text);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.label).toBe("state:ratified");
    expect(actions[0]?.removeLabel).toBe("state:deliberating");
  });
});
