import { describe, expect, it } from "vitest";

import {
  accountabilitySchema,
  derivePeriod,
  doneConditionSchema,
  interpolate,
  validateAccountability,
  validateCondition,
  type Accountability,
  type CommentFilter,
  type DoneConditionContext,
  type IssueClosedFilter,
  type IssueExistsFilter,
  type IssueRef,
  type StateProbe,
} from "./index.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const wakeStartedAt = new Date("2026-05-04T07:00:00Z");

const baseCtx: DoneConditionContext = {
  self: { agentId: "chronicler-agent" },
  this: {},
  period: "2026-W18",
  wakeStartedAt,
};

/** A probe that responds with the canned answer for everything. Used
 *  to assert validators are wired correctly without simulating real
 *  state. Per-test probes override individual methods. */
const fakeProbe = (answer: boolean): StateProbe => ({
  // eslint-disable-next-line @typescript-eslint/require-await -- async to match interface
  fileCommitted: async () => answer,
  // eslint-disable-next-line @typescript-eslint/require-await -- async to match interface
  issueClosed: async () => answer,
  // eslint-disable-next-line @typescript-eslint/require-await -- async to match interface
  issueExists: async () => answer,
  // eslint-disable-next-line @typescript-eslint/require-await -- async to match interface
  commentExists: async () => answer,
  // eslint-disable-next-line @typescript-eslint/require-await -- async to match interface
  labelApplied: async () => answer,
  // eslint-disable-next-line @typescript-eslint/require-await -- async to match interface
  agreementExists: async () => answer,
});

// ---------------------------------------------------------------------------
// Schema tests
// ---------------------------------------------------------------------------

describe("doneConditionSchema", () => {
  it("accepts each of the 6 condition kinds", () => {
    expect(() => doneConditionSchema.parse({ kind: "file-committed", path: "x.md" })).not.toThrow();
    expect(() => doneConditionSchema.parse({ kind: "issue-closed", number: 1 })).not.toThrow();
    expect(() =>
      doneConditionSchema.parse({ kind: "issue-closed-or-blocker-filed", triggering_issue: "#1" }),
    ).not.toThrow();
    expect(() =>
      doneConditionSchema.parse({ kind: "comment-posted", on_issue: "#1" }),
    ).not.toThrow();
    expect(() =>
      doneConditionSchema.parse({ kind: "label-applied", on_issue: "#1", label: "x" }),
    ).not.toThrow();
    expect(() =>
      doneConditionSchema.parse({ kind: "agreement-registered", slug: "x" }),
    ).not.toThrow();
  });

  it("rejects unknown kinds", () => {
    expect(() => doneConditionSchema.parse({ kind: "make-coffee", target: "espresso" })).toThrow();
  });
});

describe("accountabilitySchema", () => {
  it("requires id to be a lowercase slug", () => {
    expect(() =>
      accountabilitySchema.parse({
        id: "WeeklyDigest",
        cadence: "weekly",
        description: "x",
        done_when: [{ kind: "file-committed", path: "x.md" }],
      }),
    ).toThrow();
    expect(() =>
      accountabilitySchema.parse({
        id: "weekly-digest",
        cadence: "weekly",
        description: "x",
        done_when: [{ kind: "file-committed", path: "x.md" }],
      }),
    ).not.toThrow();
  });

  it("requires at least one done_when condition", () => {
    expect(() =>
      accountabilitySchema.parse({
        id: "x",
        cadence: "weekly",
        description: "x",
        done_when: [],
      }),
    ).toThrow();
  });

  it("accepts free-form cadence strings (forward compat for plugin extensions)", () => {
    expect(() =>
      accountabilitySchema.parse({
        id: "x",
        cadence: "every-third-tuesday",
        description: "x",
        done_when: [{ kind: "file-committed", path: "x.md" }],
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------

describe("interpolate", () => {
  it("substitutes {period}", () => {
    expect(interpolate("digests/{period}.md", baseCtx)).toBe("digests/2026-W18.md");
  });

  it("substitutes ${self.agent_id} and ${self.agentId}", () => {
    expect(interpolate("hello ${self.agent_id}", baseCtx)).toBe("hello chronicler-agent");
    expect(interpolate("hello ${self.agentId}", baseCtx)).toBe("hello chronicler-agent");
  });

  it("substitutes ${this.X} from the per-accountability context", () => {
    const ctx: DoneConditionContext = { ...baseCtx, this: { assigned_issue: "#552" } };
    expect(interpolate("addresses ${this.assigned_issue}", ctx)).toBe("addresses #552");
  });

  it("substitutes unknown ${self.*} / ${this.*} variables to empty string (fail-loose)", () => {
    expect(interpolate("x=${self.unknown}", baseCtx)).toBe("x=");
    expect(interpolate("x=${this.missing}", baseCtx)).toBe("x=");
  });

  it("preserves literal text without placeholders", () => {
    expect(interpolate("plain text", baseCtx)).toBe("plain text");
  });
});

// ---------------------------------------------------------------------------
// derivePeriod
// ---------------------------------------------------------------------------

describe("derivePeriod", () => {
  it("derives ISO week for weekly cadence", () => {
    // 2026-05-04 is a Monday in ISO week 19 of 2026.
    expect(derivePeriod("weekly", new Date("2026-05-04T12:00:00Z"))).toBe("2026-W19");
  });

  it("derives YYYY-MM for monthly cadence", () => {
    expect(derivePeriod("monthly", new Date("2026-05-04T12:00:00Z"))).toBe("2026-05");
  });

  it("derives YYYY-Qq for quarterly cadence", () => {
    expect(derivePeriod("quarterly", new Date("2026-05-04T12:00:00Z"))).toBe("2026-Q2");
    expect(derivePeriod("quarterly", new Date("2026-01-01T12:00:00Z"))).toBe("2026-Q1");
    expect(derivePeriod("quarterly", new Date("2026-12-31T12:00:00Z"))).toBe("2026-Q4");
  });

  it("falls back to YYYY-MM-DD for daily / unknown cadences", () => {
    expect(derivePeriod("daily", new Date("2026-05-04T12:00:00Z"))).toBe("2026-05-04");
    expect(derivePeriod("every-third-tuesday", new Date("2026-05-04T12:00:00Z"))).toBe(
      "2026-05-04",
    );
  });
});

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

describe("validateCondition: file-committed", () => {
  it("met when probe says the file is committed since wake start", async () => {
    const r = await validateCondition(
      { kind: "file-committed", path: "chronicles/digests/{period}.md" },
      baseCtx,
      fakeProbe(true),
    );
    expect(r.met).toBe(true);
    expect(r.reason).toContain("2026-W18.md");
  });

  it("unmet when probe says no", async () => {
    const r = await validateCondition(
      { kind: "file-committed", path: "x.md" },
      baseCtx,
      fakeProbe(false),
    );
    expect(r.met).toBe(false);
    expect(r.reason).toContain("unmet");
  });

  it("interpolates path", async () => {
    let observed = "";
    const probe: StateProbe = {
      ...fakeProbe(true),
      // eslint-disable-next-line @typescript-eslint/require-await
      fileCommitted: async (path) => {
        observed = path;
        return true;
      },
    };
    await validateCondition(
      { kind: "file-committed", path: "chronicles/{period}/${self.agent_id}.md" },
      baseCtx,
      probe,
    );
    expect(observed).toBe("chronicles/2026-W18/chronicler-agent.md");
  });
});

describe("validateCondition: issue-closed", () => {
  it("passes the filter through to the probe", async () => {
    let observed: IssueClosedFilter | undefined;
    const probe: StateProbe = {
      ...fakeProbe(true),
      // eslint-disable-next-line @typescript-eslint/require-await
      issueClosed: async (f) => {
        observed = f;
        return true;
      },
    };
    await validateCondition({ kind: "issue-closed", number: 552 }, baseCtx, probe);
    expect(observed).toEqual({ number: 552 });
  });

  it("interpolates filter.author for ${self.agent_id} matches", async () => {
    let observed: IssueClosedFilter | undefined;
    const probe: StateProbe = {
      ...fakeProbe(true),
      // eslint-disable-next-line @typescript-eslint/require-await
      issueClosed: async (f) => {
        observed = f;
        return true;
      },
    };
    await validateCondition(
      { kind: "issue-closed", filter: { author: "${self.agent_id}", type: "[TENSION]" } },
      baseCtx,
      probe,
    );
    expect(observed).toEqual({ author: "chronicler-agent", type: "[TENSION]" });
  });
});

describe("validateCondition: issue-closed-or-blocker-filed", () => {
  it("met when triggering issue is closed", async () => {
    const probe: StateProbe = {
      ...fakeProbe(false),
      // eslint-disable-next-line @typescript-eslint/require-await
      issueClosed: async (f: IssueClosedFilter) => f.number === 552,
    };
    const r = await validateCondition(
      { kind: "issue-closed-or-blocker-filed", triggering_issue: "#552" },
      baseCtx,
      probe,
    );
    expect(r.met).toBe(true);
    expect(r.reason).toContain("issue-closed");
  });

  it("met when a TENSION references the triggering issue", async () => {
    const probe: StateProbe = {
      ...fakeProbe(false),
      // eslint-disable-next-line @typescript-eslint/require-await
      issueExists: async (f: IssueExistsFilter) =>
        f.type === "[TENSION]" && f.references === "#552",
    };
    const r = await validateCondition(
      { kind: "issue-closed-or-blocker-filed", triggering_issue: "#552" },
      baseCtx,
      probe,
    );
    expect(r.met).toBe(true);
    expect(r.reason).toContain("blocker filed");
  });

  it("unmet when neither path satisfied", async () => {
    const r = await validateCondition(
      { kind: "issue-closed-or-blocker-filed", triggering_issue: "#999" },
      baseCtx,
      fakeProbe(false),
    );
    expect(r.met).toBe(false);
  });
});

describe("validateCondition: comment-posted", () => {
  it("met when probe finds a matching comment", async () => {
    let observed: CommentFilter | undefined;
    const probe: StateProbe = {
      ...fakeProbe(true),
      // eslint-disable-next-line @typescript-eslint/require-await
      commentExists: async (f) => {
        observed = f;
        return true;
      },
    };
    const r = await validateCondition(
      { kind: "comment-posted", on_issue: "#552", contains_link_to: "${this.committed_file}" },
      { ...baseCtx, this: { committed_file: "drafts/x.md" } },
      probe,
    );
    expect(r.met).toBe(true);
    expect(observed?.issueRef.number).toBe(552);
    expect(observed?.authorAgentId).toBe("chronicler-agent");
    expect(observed?.containsLinkTo).toBe("drafts/x.md");
  });

  it("unmet when issue ref cannot be parsed", async () => {
    const r = await validateCondition(
      { kind: "comment-posted", on_issue: "not-a-ref" },
      baseCtx,
      fakeProbe(true),
    );
    expect(r.met).toBe(false);
  });
});

describe("validateCondition: label-applied", () => {
  it("met when probe says the label is on the issue", async () => {
    const probe: StateProbe = {
      ...fakeProbe(false),
      // eslint-disable-next-line @typescript-eslint/require-await
      labelApplied: async (ref: IssueRef, label: string) =>
        ref.number === 553 && label === "awaiting:source-close",
    };
    const r = await validateCondition(
      { kind: "label-applied", on_issue: "#553", label: "awaiting:source-close" },
      baseCtx,
      probe,
    );
    expect(r.met).toBe(true);
  });
});

describe("validateCondition: agreement-registered", () => {
  it("met when probe says the agreement file exists", async () => {
    const r = await validateCondition(
      { kind: "agreement-registered", slug: "course-1-bundle" },
      baseCtx,
      fakeProbe(true),
    );
    expect(r.met).toBe(true);
  });

  it("interpolates the slug", async () => {
    let observed = "";
    const probe: StateProbe = {
      ...fakeProbe(true),
      // eslint-disable-next-line @typescript-eslint/require-await -- async to match interface
      agreementExists: async (s: string) => {
        observed = s;
        return true;
      },
    };
    await validateCondition(
      { kind: "agreement-registered", slug: "${this.topic}" },
      { ...baseCtx, this: { topic: "course-1-bundle" } },
      probe,
    );
    expect(observed).toBe("course-1-bundle");
  });
});

// ---------------------------------------------------------------------------
// Accountability-level validation
// ---------------------------------------------------------------------------

describe("validateAccountability", () => {
  it("met = true when ALL conditions met (AND-semantics)", async () => {
    const acc: Accountability = {
      id: "weekly-digest",
      cadence: "weekly",
      description: "Synthesize the week",
      done_when: [
        { kind: "file-committed", path: "digests/{period}.md" },
        { kind: "issue-closed", number: 100 },
      ],
    };
    const result = await validateAccountability(acc, baseCtx, fakeProbe(true));
    expect(result.met).toBe(true);
    expect(result.conditions).toHaveLength(2);
    expect(result.conditions.every((c) => c.met)).toBe(true);
  });

  it("met = false when ANY condition unmet", async () => {
    const acc: Accountability = {
      id: "weekly-digest",
      cadence: "weekly",
      description: "x",
      done_when: [
        { kind: "file-committed", path: "x.md" },
        { kind: "issue-closed", number: 100 },
      ],
    };
    const probe: StateProbe = {
      ...fakeProbe(true),
      // eslint-disable-next-line @typescript-eslint/require-await -- async to match interface
      issueClosed: async () => false, // second condition unmet
    };
    const result = await validateAccountability(acc, baseCtx, probe);
    expect(result.met).toBe(false);
    expect(result.conditions[0]?.met).toBe(true);
    expect(result.conditions[1]?.met).toBe(false);
  });

  it("returns the accountability id for telemetry", async () => {
    const acc: Accountability = {
      id: "tension-resolution",
      cadence: "continuous",
      description: "x",
      done_when: [{ kind: "agreement-registered", slug: "x" }],
    };
    const result = await validateAccountability(acc, baseCtx, fakeProbe(true));
    expect(result.accountabilityId).toBe("tension-resolution");
  });
});
