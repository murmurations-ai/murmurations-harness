/**
 * Tests for `assembleExecutionContract`.
 *
 * Covers:
 *   - Missing-declaration path: contract still assembles from runtime context
 *   - Full declaration: every contract field maps through
 *   - requiredOutputs mapping from committed/runtime artifacts
 *   - allowedSideEffects derived from githubWriteScopes (read-only vs read+write)
 *   - objective synthesis precedence: done_when[0] > wakeReason
 *   - approval policy switches on `approval_required_for`
 */

import { describe, expect, it } from "vitest";

import {
  assembleExecutionContract,
  contractDeclarationSchema,
  renderContractForPrompt,
} from "./execution-contract.js";
import type { SignalBundle } from "../execution/index.js";
import { makeWakeId } from "../execution/index.js";

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

describe("contractDeclarationSchema", () => {
  it("rejects committed_artifacts entries containing `..` segments", () => {
    expect(() =>
      contractDeclarationSchema.parse({
        committed_artifacts: ["../../etc/**"],
      }),
    ).toThrow(/must not start with .* or contain/);
  });

  it("rejects committed_artifacts entries starting with `/`", () => {
    expect(() =>
      contractDeclarationSchema.parse({
        committed_artifacts: ["/absolute/path/**"],
      }),
    ).toThrow(/must not start with/);
  });

  it("rejects runtime_artifacts with `..` segments too", () => {
    expect(() =>
      contractDeclarationSchema.parse({
        runtime_artifacts: ["foo/../bar/**"],
      }),
    ).toThrow(/must not start with .* or contain/);
  });

  it("accepts normal relative globs", () => {
    const d = contractDeclarationSchema.parse({
      committed_artifacts: ["drafts/**/*.md", "docs/research/**/*.md"],
      runtime_artifacts: [".murmuration/runs/**/*.md"],
    });
    expect(d.committed_artifacts).toEqual(["drafts/**/*.md", "docs/research/**/*.md"]);
  });
});

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
    // Every path-bearing obligation uses the same `paths` shape — single-path
    // declarations carry `paths.length === 1`, multi-path declarations OR-fold
    // into one obligation whose `paths` is the full list.
    expect(contract.requiredOutputs).toHaveLength(2);
    expect(contract.requiredOutputs[0]).toMatchObject({
      kind: "committed-artifact",
      paths: ["drafts/**/*.md", "docs/research/**/*.md"],
    });
    expect(contract.requiredOutputs[1]).toMatchObject({
      kind: "runtime-artifact",
      paths: [".murmuration/runs/**/*.md"],
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

describe("renderContractForPrompt", () => {
  it("renders the no-obligations notice when only runtime context is present", () => {
    const contract = assembleExecutionContract({
      wakeReason: { kind: "scheduled", cronExpression: "0 9 * * *" },
      wakeMode: "individual",
      declaration: undefined,
      signals: emptySignals,
      budget: baseBudget,
      githubWriteScopes: emptyScopes,
    });

    const rendered = renderContractForPrompt(contract);
    expect(rendered).toMatch(/^# Execution Contract\n/);
    expect(rendered).toContain("**Objective:** Scheduled wake (0 9 * * *)");
    expect(rendered).toContain("_No explicit obligations declared");
    // Read-only contracts no longer render the Permitted side effects
    // section — the agent learns nothing actionable from "you may read".
    expect(rendered).not.toContain("## Permitted side effects");
    expect(rendered).not.toContain("## Completion conditions");
    expect(rendered).not.toContain("## Required outputs");
    expect(rendered).not.toContain("## Source approval");
  });

  it("renders all sections when the contract is fully populated", () => {
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

    const rendered = renderContractForPrompt(contract);
    expect(rendered).toContain(
      "**Objective:** Commit at least one research artifact under drafts/",
    );
    expect(rendered).toContain("## Completion conditions");
    expect(rendered).toContain("- Commit at least one research artifact under drafts/");
    expect(rendered).toContain("- OR post a substantive comment on an open issue");
    expect(rendered).toContain("## Required outputs");
    expect(rendered).toContain(
      "**committed-artifact** (any of: `drafts/**/*.md`, `docs/research/**/*.md`)",
    );
    expect(rendered).toContain("**runtime-artifact** `.murmuration/runs/**/*.md`");
    expect(rendered).toContain("## Verification required");
    expect(rendered).toContain("Verification required for: github.create_pull_request (required)");
    expect(rendered).toContain("## Permitted side effects");
    expect(rendered).toContain("`read, write`");
    expect(rendered).toContain("## Source approval");
    expect(rendered).toContain("**required** — Source approval required for: admin");
  });

  it("omits the verification section when no verification steps are declared", () => {
    const declaration = contractDeclarationSchema.parse({
      done_when: ["produce a digest"],
      committed_artifacts: ["digests/**/*.md"],
    });

    const contract = assembleExecutionContract({
      wakeReason: { kind: "scheduled", cronExpression: "0 9 * * *" },
      wakeMode: "individual",
      declaration,
      signals: emptySignals,
      budget: baseBudget,
      githubWriteScopes: emptyScopes,
    });

    const rendered = renderContractForPrompt(contract);
    expect(rendered).toContain("## Completion conditions");
    expect(rendered).toContain("## Required outputs");
    expect(rendered).not.toContain("## Verification required");
    expect(rendered).not.toContain("## Source approval");
  });

  it("omits the approval section when mode is 'none'", () => {
    const declaration = contractDeclarationSchema.parse({
      done_when: ["do the thing"],
    });

    const contract = assembleExecutionContract({
      wakeReason: { kind: "scheduled", cronExpression: "0 9 * * *" },
      wakeMode: "individual",
      declaration,
      signals: emptySignals,
      budget: baseBudget,
      githubWriteScopes: emptyScopes,
    });

    const rendered = renderContractForPrompt(contract);
    expect(rendered).not.toContain("## Source approval");
  });

  it("shows read+write when write scopes are present", () => {
    const contract = assembleExecutionContract({
      wakeReason: { kind: "manual", invokedBy: "source" },
      wakeMode: "individual",
      declaration: undefined,
      signals: emptySignals,
      budget: baseBudget,
      githubWriteScopes: writeScopes,
    });
    const rendered = renderContractForPrompt(contract);
    expect(rendered).toContain("`read, write`");
  });
});
