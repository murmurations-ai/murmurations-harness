/**
 * Tests for `assembleExecutionContract` — Phase 4 PR 2 (ADR-0047, ADR-0048).
 *
 * Covers:
 *   - Missing-declaration path: contract still assembles from runtime context
 *   - Full declaration: every contract field maps through
 *   - actionItems mapping from SignalBundle to ActionItemRef (with/without sourceRef)
 *   - allowedSideEffects derived from githubWriteScopes (read-only vs read+write)
 *   - objective synthesis precedence: done_when[0] > wakeReason
 *   - approval policy switches on `approval_required_for`
 */

import { describe, expect, it } from "vitest";

import { assembleExecutionContract, contractDeclarationSchema } from "./execution-contract.js";
import type { Signal, SignalBundle } from "../execution/index.js";
import { makeAgentId, makeWakeId } from "../execution/index.js";

const wakeId = makeWakeId("wake-test");

const emptySignals: SignalBundle = {
  wakeId,
  assembledAt: new Date("2026-05-11T10:00:00Z"),
  signals: [],
  actionItems: [],
  warnings: [],
};

const baseBudget = {
  maxInputTokens: 0,
  maxOutputTokens: 0,
  maxWallClockMs: 60000,
  model: { tier: "balanced" as const, provider: "unknown", model: "unknown", maxTokens: 4096 },
  maxCostMicros: 0,
};

const emptyScopes = {
  issueComments: [],
  branchCommits: [],
  labels: [],
  issues: [],
};

const writeScopes = {
  issueComments: ["xeeban/emergent-praxis"],
  branchCommits: [{ repo: "xeeban/emergent-praxis", paths: ["drafts/**"] }],
  labels: ["xeeban/emergent-praxis"],
  issues: ["xeeban/emergent-praxis"],
};

describe("assembleExecutionContract", () => {
  it("returns a valid contract when no declaration is present", () => {
    const contract = assembleExecutionContract({
      wakeReason: { kind: "scheduled", cronExpression: "0 9 * * *" },
      wakeMode: "individual",
      declaration: undefined,
      signals: emptySignals,
      budget: baseBudget,
      githubWriteScopes: emptyScopes,
    });

    expect(contract.objective).toBe("Scheduled wake (0 9 * * *)");
    expect(contract.requiredOutputs).toEqual([]);
    expect(contract.actionItems).toEqual([]);
    expect(contract.completionConditions).toEqual([]);
    expect(contract.verification).toEqual([]);
    expect(contract.allowedSideEffects).toEqual(["read"]);
    expect(contract.approval).toEqual({ mode: "none" });
  });

  it("maps a full contract declaration through all five sub-fields", () => {
    const declaration = contractDeclarationSchema.parse({
      done_when: [
        "Commit at least one research artifact under drafts/",
        "OR post a substantive comment on an open issue",
      ],
      committed_artifacts: ["drafts/**/*.md", "docs/research/**/*.md"],
      runtime_artifacts: [".murmuration/runs/**/*.md"],
      verification_required_for: ["github.create_pull_request"],
      approval_required_for: ["admin"],
    });

    const contract = assembleExecutionContract({
      wakeReason: { kind: "manual", invokedBy: "source" },
      wakeMode: "individual",
      declaration,
      signals: emptySignals,
      budget: baseBudget,
      githubWriteScopes: writeScopes,
    });

    expect(contract.objective).toBe("Commit at least one research artifact under drafts/");
    expect(contract.requiredOutputs).toHaveLength(3);
    expect(contract.requiredOutputs[0]).toMatchObject({
      kind: "committed-artifact",
      path: "drafts/**/*.md",
    });
    expect(contract.requiredOutputs[2]).toMatchObject({
      kind: "runtime-artifact",
      path: ".murmuration/runs/**/*.md",
    });
    expect(contract.completionConditions).toHaveLength(2);
    expect(contract.completionConditions[0]?.id).toBe("done-when-0");
    expect(contract.verification).toHaveLength(1);
    expect(contract.verification[0]?.required).toBe(true);
    expect(contract.allowedSideEffects).toEqual(["read", "write"]);
    expect(contract.approval).toEqual({
      mode: "required",
      reason: "Source approval required for: admin",
    });
  });

  it("maps SignalBundle.actionItems to ActionItemRef with sourceRef for github-issue signals", () => {
    const issueSignal: Signal = {
      id: "github-issue:xeeban/emergent-praxis#861",
      kind: "github-issue",
      trust: "trusted",
      fetchedAt: new Date(),
      number: 861,
      title: "Action item: intelligence-agent — add conformant contract: block",
      url: "https://github.com/xeeban/emergent-praxis/issues/861",
      labels: ["assigned:intelligence-agent"],
      excerpt: "...",
    };
    const inboxSignal: Signal = {
      id: "inbox:msg-42",
      kind: "inbox-message",
      trust: "trusted",
      fetchedAt: new Date(),
      fromAgent: makeAgentId("memory-agent"),
      path: "agents/intelligence-agent/inbox/msg-42.md",
      excerpt: "...",
    };

    const signals: SignalBundle = {
      ...emptySignals,
      actionItems: [issueSignal, inboxSignal],
    };

    const contract = assembleExecutionContract({
      wakeReason: { kind: "scheduled", cronExpression: "0 9 * * *" },
      wakeMode: "individual",
      declaration: undefined,
      signals,
      budget: baseBudget,
      githubWriteScopes: emptyScopes,
    });

    expect(contract.actionItems).toHaveLength(2);
    expect(contract.actionItems[0]).toEqual({
      signalId: "github-issue:xeeban/emergent-praxis#861",
      sourceRef: "https://github.com/xeeban/emergent-praxis/issues/861",
    });
    // inbox-message has no url, so sourceRef is absent
    expect(contract.actionItems[1]).toEqual({ signalId: "inbox:msg-42" });
  });

  it("derives allowedSideEffects from write scopes (read-only when all empty)", () => {
    const contract = assembleExecutionContract({
      wakeReason: { kind: "manual", invokedBy: "source" },
      wakeMode: "individual",
      declaration: undefined,
      signals: emptySignals,
      budget: baseBudget,
      githubWriteScopes: emptyScopes,
    });
    expect(contract.allowedSideEffects).toEqual(["read"]);
  });

  it("synthesizes objective from wakeReason variant when no done_when present", () => {
    const scheduled = assembleExecutionContract({
      wakeReason: { kind: "scheduled", cronExpression: "0 9 * * *" },
      wakeMode: "individual",
      declaration: undefined,
      signals: emptySignals,
      budget: baseBudget,
      githubWriteScopes: emptyScopes,
    });
    expect(scheduled.objective).toBe("Scheduled wake (0 9 * * *)");

    const event = assembleExecutionContract({
      wakeReason: { kind: "event", eventType: "github.issue.opened", eventId: "issue-42" },
      wakeMode: "individual",
      declaration: undefined,
      signals: emptySignals,
      budget: baseBudget,
      githubWriteScopes: emptyScopes,
    });
    expect(event.objective).toBe("Event-triggered wake: github.issue.opened");

    const manual = assembleExecutionContract({
      wakeReason: { kind: "manual", invokedBy: "source" },
      wakeMode: "individual",
      declaration: undefined,
      signals: emptySignals,
      budget: baseBudget,
      githubWriteScopes: emptyScopes,
    });
    expect(manual.objective).toBe("Manual wake invoked by source");
  });

  it("preserves wakeMode and wakeReason on the assembled contract", () => {
    const contract = assembleExecutionContract({
      wakeReason: { kind: "scheduled", cronExpression: "0 23 * * *" },
      wakeMode: "group-facilitator",
      declaration: undefined,
      signals: emptySignals,
      budget: baseBudget,
      githubWriteScopes: emptyScopes,
    });
    expect(contract.wakeMode).toBe("group-facilitator");
    expect(contract.wakeReason).toEqual({ kind: "scheduled", cronExpression: "0 23 * * *" });
  });

  it("approval policy stays 'none' when approval_required_for is empty", () => {
    const declaration = contractDeclarationSchema.parse({
      done_when: ["do the thing"],
      approval_required_for: [],
    });

    const contract = assembleExecutionContract({
      wakeReason: { kind: "scheduled", cronExpression: "0 9 * * *" },
      wakeMode: "individual",
      declaration,
      signals: emptySignals,
      budget: baseBudget,
      githubWriteScopes: emptyScopes,
    });
    expect(contract.approval).toEqual({ mode: "none" });
  });
});
