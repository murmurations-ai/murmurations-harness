import { describe, expect, it } from "vitest";

import {
  AWAITING_SOURCE_CLOSE_LABEL,
  VERIFICATION_FAILED_LABEL,
  classifyClosureAttempt,
  defaultVerifyClosure,
  extractIssueType,
  resolveCloserFor,
  verifyClosure,
} from "./closure.js";
import type { ClosureEvidence, GovernancePlugin, IssueSnapshot } from "./index.js";

import { makeAgentId, type AgentId } from "../execution/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const closerAgentId: AgentId = makeAgentId("facilitator-agent");

const evidenceWith = (...verifications: ClosureEvidence["verifications"]): ClosureEvidence => ({
  closerAgentId,
  reason: "fixture",
  verifications,
});

const issue = (overrides: Partial<IssueSnapshot> = {}): IssueSnapshot => ({
  number: 1,
  title: "[PROPOSAL] sample",
  body: "",
  labels: [],
  state: "open",
  comments: [],
  createdAt: "2026-05-01T00:00:00Z",
  updatedAt: "2026-05-01T00:00:00Z",
  ...overrides,
});

// ---------------------------------------------------------------------------
// extractIssueType
// ---------------------------------------------------------------------------

describe("extractIssueType", () => {
  it("returns the bracketed prefix", () => {
    expect(extractIssueType("[PROPOSAL] adopt new pricing")).toBe("[PROPOSAL]");
    expect(extractIssueType("[OPERATIONAL MEETING] 2026-W18")).toBe("[OPERATIONAL MEETING]");
    expect(extractIssueType("[TENSION] missed deadline")).toBe("[TENSION]");
  });

  it("tolerates leading whitespace", () => {
    expect(extractIssueType("   [DIRECTIVE] strategy ")).toBe("[DIRECTIVE]");
  });

  it("returns undefined when no prefix", () => {
    expect(extractIssueType("Just an issue")).toBeUndefined();
    expect(extractIssueType("")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveCloserFor
// ---------------------------------------------------------------------------

describe("resolveCloserFor", () => {
  it("uses the harness default table when plugin is absent", () => {
    expect(resolveCloserFor(undefined, "[TENSION]")).toBe("filer");
    expect(resolveCloserFor(undefined, "[PROPOSAL]")).toBe("facilitator");
    expect(resolveCloserFor(undefined, "[DIRECTIVE]")).toBe("source");
    expect(resolveCloserFor(undefined, "[OPERATIONAL MEETING]")).toBe("facilitator");
    expect(resolveCloserFor(undefined, "[GOVERNANCE MEETING]")).toBe("facilitator");
    expect(resolveCloserFor(undefined, "[RETROSPECTIVE MEETING]")).toBe("facilitator");
  });

  it("falls back to 'responsible' for unknown types", () => {
    expect(resolveCloserFor(undefined, "[UNKNOWN TYPE]")).toBe("responsible");
    expect(resolveCloserFor(undefined, "")).toBe("responsible");
  });

  it("plugin override wins over harness default", () => {
    const plugin: Pick<GovernancePlugin, "closerFor"> = {
      closerFor: (t) => (t === "[PROPOSAL]" ? "source" : undefined),
    };
    expect(resolveCloserFor(plugin, "[PROPOSAL]")).toBe("source");
  });

  it("plugin returning undefined falls through to harness default", () => {
    const plugin: Pick<GovernancePlugin, "closerFor"> = {
      closerFor: () => undefined,
    };
    expect(resolveCloserFor(plugin, "[TENSION]")).toBe("filer");
  });

  it("plugin without closerFor falls through to default", () => {
    const plugin: Pick<GovernancePlugin, "closerFor"> = {};
    expect(resolveCloserFor(plugin, "[PROPOSAL]")).toBe("facilitator");
  });
});

// ---------------------------------------------------------------------------
// defaultVerifyClosure
// ---------------------------------------------------------------------------

describe("defaultVerifyClosure", () => {
  it("ok when at least one verification is present", () => {
    expect(
      defaultVerifyClosure(evidenceWith({ kind: "linked-closed-issue", issueNumber: 5 })).ok,
    ).toBe(true);
    expect(
      defaultVerifyClosure(evidenceWith({ kind: "commit-ref", sha: "abc", path: "x.md" })).ok,
    ).toBe(true);
    expect(
      defaultVerifyClosure(
        evidenceWith({
          kind: "confirmation-comment",
          authorAgentId: makeAgentId("peer"),
          commentSha: "deadbeef",
        }),
      ).ok,
    ).toBe(true);
    expect(
      defaultVerifyClosure(evidenceWith({ kind: "agreement-entry", slug: "course-1" })).ok,
    ).toBe(true);
  });

  it("not-ok with named reason when zero verifications", () => {
    const r = defaultVerifyClosure(evidenceWith());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("structural evidence");
    }
  });
});

// ---------------------------------------------------------------------------
// verifyClosure (harness + plugin composition)
// ---------------------------------------------------------------------------

describe("verifyClosure", () => {
  const baseInput = {
    issue: issue(),
    state: "ratified",
    itemKind: "proposal",
  };

  it("plugin-less path runs the harness default", () => {
    expect(
      verifyClosure(undefined, {
        ...baseInput,
        evidence: evidenceWith({ kind: "linked-closed-issue", issueNumber: 1 }),
      }).ok,
    ).toBe(true);
    expect(verifyClosure(undefined, { ...baseInput, evidence: evidenceWith() }).ok).toBe(false);
  });

  it("default failure short-circuits — plugin override never runs", () => {
    let pluginCalled = false;
    const plugin: Pick<GovernancePlugin, "verifyClosure"> = {
      verifyClosure: () => {
        pluginCalled = true;
        return { ok: true };
      },
    };
    const r = verifyClosure(plugin, { ...baseInput, evidence: evidenceWith() });
    expect(r.ok).toBe(false);
    expect(pluginCalled).toBe(false);
  });

  it("plugin can block closure even when default passes", () => {
    const plugin: Pick<GovernancePlugin, "verifyClosure"> = {
      verifyClosure: () => ({ ok: false, reason: "consent quorum not reached" }),
    };
    const r = verifyClosure(plugin, {
      ...baseInput,
      evidence: evidenceWith({ kind: "linked-closed-issue", issueNumber: 1 }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("quorum");
  });

  it("ok when both default and plugin pass", () => {
    const plugin: Pick<GovernancePlugin, "verifyClosure"> = {
      verifyClosure: () => ({ ok: true }),
    };
    const r = verifyClosure(plugin, {
      ...baseInput,
      evidence: evidenceWith({ kind: "agreement-entry", slug: "x" }),
    });
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// classifyClosureAttempt — verification-failure ladder
// ---------------------------------------------------------------------------

describe("classifyClosureAttempt", () => {
  const goodEvidence = evidenceWith({ kind: "linked-closed-issue", issueNumber: 1 });

  it("returns close when verification passes", () => {
    const r = classifyClosureAttempt({
      verification: { ok: true },
      issue: issue(),
      evidence: goodEvidence,
    });
    expect(r.action).toBe("close");
    if (r.action === "close") {
      expect(r.evidence).toBe(goodEvidence);
    }
  });

  it("returns retry on first failure (no prior label)", () => {
    const r = classifyClosureAttempt({
      verification: { ok: false, reason: "no evidence" },
      issue: issue({ labels: [] }),
      evidence: evidenceWith(),
    });
    expect(r.action).toBe("retry");
    if (r.action === "retry") {
      expect(r.reason).toContain("no evidence");
    }
  });

  it("returns escalate on second failure (already labeled verification-failed)", () => {
    const r = classifyClosureAttempt({
      verification: { ok: false, reason: "still no evidence" },
      issue: issue({ labels: [VERIFICATION_FAILED_LABEL] }),
      evidence: evidenceWith(),
    });
    expect(r.action).toBe("escalate");
    if (r.action === "escalate") {
      expect(r.reason).toContain("second consecutive");
    }
  });

  it("close consumes the prior verification-failed label", () => {
    // Issue had a prior failure but this attempt verified; the result
    // is `close` and the facilitator is expected to remove the label
    // as part of the close. We verify the action here; label removal
    // is the caller's job (not pure logic).
    const r = classifyClosureAttempt({
      verification: { ok: true },
      issue: issue({ labels: [VERIFICATION_FAILED_LABEL] }),
      evidence: goodEvidence,
    });
    expect(r.action).toBe("close");
  });

  it("exposes the canonical label constants", () => {
    expect(VERIFICATION_FAILED_LABEL).toBe("verification-failed");
    expect(AWAITING_SOURCE_CLOSE_LABEL).toBe("awaiting:source-close");
  });
});
