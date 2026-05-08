/**
 * Phase 0 compile-time fixture tests for Proposal 07 boundary types.
 *
 * These tests verify that:
 *   1. All new boundary types are importable and constructable.
 *   2. The types are internally consistent (no circular failures).
 *   3. A mock wake's data maps cleanly to the new boundary shapes.
 *
 * There is no runtime behavior to test in Phase 0 — the types ship
 * without wiring. Phase 2+ tests will cover PromptAssembler, ToolRegistry,
 * and WakeValidator behavior.
 */

import { describe, expect, it } from "vitest";

import type {
  ActionItemRef,
  CompletionCondition,
  ExecutionContract,
  VerificationStep,
} from "./execution-contract.js";
import type { RunLedgerFilter } from "./run-ledger.js";
// Re-export tests — ensure the barrel exports compile
import type { AgentRuntime, Toolset } from "./agent-runtime.js";
import type { LangfuseMetricsSignal, WakeHealthMetrics } from "../validation/health.js";
import type { PromptBundle, PromptSegment } from "./prompt-assembler.js";
import type { ToolCallReceipt, ToolDescriptor, ToolGrant } from "../tools/index.js";
import type { EnvironmentSpec } from "../environment/index.js";
import { makeAgentId, makeWakeId } from "../execution/index.js";

// ---------------------------------------------------------------------------
// Helpers — zero-baseline values for types with many required fields
// ---------------------------------------------------------------------------

const zeroHealthMetrics: WakeHealthMetrics = {
  toolCalls: 0,
  mutatingToolCalls: 0,
  toolFailures: 0,
  toolErrorDensity: 0,
  actionItemsAssigned: 0,
  actionItemsAddressed: 0,
  verificationStepsRequired: 0,
  verificationStepsPassed: 0,
  idleWake: true,
};

const identitySegment: PromptSegment = {
  id: "identity",
  kind: "identity",
  trust: "trusted",
  content: "You are a test agent.",
  sourceRef: "murmuration/soul.md",
};

const signalsSegment: PromptSegment = {
  id: "signals",
  kind: "signals",
  trust: "untrusted",
  tokenBudget: 4000,
  content: "<untrusted-signal>{}</untrusted-signal>",
};

const minimalBundle: PromptBundle = {
  system: [identitySegment, signalsSegment],
  messages: [{ role: "user", content: "Begin wake." }],
  hash: "abc123",
  tokenEstimate: 100,
  cacheAnchorIndex: 1, // identitySegment is stable; signalsSegment is volatile
};

const minimalToolDescriptor: ToolDescriptor = {
  id: "internal__budget_remaining",
  name: "budget_remaining",
  provider: "internal",
  description: "Returns remaining token and cost budget for this wake.",
  inputSchema: {},
  permissions: ["read"],
  mutability: "read-only",
  trust: "trusted",
  timeoutMs: 1000,
  requiresVerification: false,
  approval: { mode: "none" },
};

const minimalGrant: ToolGrant = {
  toolId: "internal__budget_remaining",
  allowedAgentIds: ["test-agent"],
  allowedSecretGrantNames: [],
};

const minimalToolset: Toolset = {
  descriptors: [minimalToolDescriptor],
  grants: [minimalGrant],
};

const minimalEnv: EnvironmentSpec = {
  publicEnv: { MURMURATION_ENV: "test" },
  secretGrants: [],
  network: "none",
};

const actionItemRef: ActionItemRef = {
  signalId: "github-issue:xeeban/ep#1",
  sourceRef: "https://github.com/xeeban/ep/issues/1",
};

const completionCondition: CompletionCondition = {
  id: "has-comment",
  description: "At least one issue comment posted via WakeAction",
};

const verificationStep: VerificationStep = {
  id: "verify-comment",
  description: "Confirm comment WakeAction has a successful receipt",
  required: true,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Proposal 07 Phase 0 boundary types", () => {
  describe("PromptBundle", () => {
    it("constructs with stable/volatile segment split", () => {
      expect(minimalBundle.cacheAnchorIndex).toBe(1);
      expect(minimalBundle.system[0]?.kind).toBe("identity");
      expect(minimalBundle.system[1]?.trust).toBe("untrusted");
    });

    it("all segment kinds are valid discriminant values", () => {
      const kinds: PromptSegment["kind"][] = [
        "identity",
        "role",
        "wake-task",
        "signals",
        "memory",
        "skills",
        "tools",
        "contract",
        "governance",
        "health",
      ];
      expect(kinds).toHaveLength(10);
    });
  });

  describe("WakeHealthMetrics", () => {
    it("constructs at zero baseline", () => {
      expect(zeroHealthMetrics.idleWake).toBe(true);
      expect(zeroHealthMetrics.toolErrorDensity).toBe(0);
    });

    it("accepts optional fields", () => {
      const withOptionals: WakeHealthMetrics = {
        ...zeroHealthMetrics,
        selfReportedEffectiveness: "high",
        costPerArtifactMicros: 500,
        memorySegmentReferenced: true,
      };
      expect(withOptionals.selfReportedEffectiveness).toBe("high");
    });
  });

  describe("LangfuseMetricsSignal", () => {
    it("constructs correctly", () => {
      const signal: LangfuseMetricsSignal = {
        agentId: makeAgentId("test-agent"),
        windowDays: 7,
        metrics: { productive_rate: 0.85, idle_rate: 0.15 },
      };
      expect(signal.windowDays).toBe(7);
      expect(signal.metrics.productive_rate).toBe(0.85);
    });
  });

  describe("ToolDescriptor", () => {
    it("constructs for an internal read-only tool", () => {
      expect(minimalToolDescriptor.mutability).toBe("read-only");
      expect(minimalToolDescriptor.approval.mode).toBe("none");
    });

    it("models an MCP mutating tool with approval", () => {
      const mutatingTool: ToolDescriptor = {
        id: "mcp__github__push_files",
        name: "push_files",
        provider: "mcp",
        description: "Push files to a GitHub branch.",
        inputSchema: {},
        permissions: ["write", "network"],
        mutability: "mutating",
        trust: "trusted",
        timeoutMs: 30_000,
        requiresVerification: true,
        approval: {
          mode: "conditional",
          requiredFor: ["admin"],
        },
      };
      expect(mutatingTool.requiresVerification).toBe(true);
    });
  });

  describe("ToolCallReceipt", () => {
    it("constructs a minimal allowed receipt", () => {
      const receipt: ToolCallReceipt = {
        schemaVersion: 1,
        wakeId: makeWakeId("test-wake-001"),
        callerAgentId: makeAgentId("test-agent"),
        toolId: "internal__budget_remaining",
        permissions: ["read"],
        mutability: "read-only",
        policyVersion: "v1.0",
        policyDecision: "allowed",
        secretGrantNames: [],
        inputHash: "sha256:abc",
        startedAt: "2026-05-08T10:00:00.000Z",
        durationMs: 12,
        outcome: "success",
        redactionApplied: false,
      };
      expect(receipt.policyDecision).toBe("allowed");
      expect(receipt.outcome).toBe("success");
    });

    it("constructs a denied receipt", () => {
      const denied: ToolCallReceipt = {
        schemaVersion: 1,
        wakeId: makeWakeId("test-wake-002"),
        callerAgentId: makeAgentId("test-agent"),
        toolId: "mcp__filesystem__write_file",
        permissions: ["write"],
        mutability: "mutating",
        policyVersion: "v1.0",
        policyDecision: "denied",
        denialReason: "write permission not in allowedSideEffects for this wake",
        secretGrantNames: [],
        inputHash: "sha256:def",
        startedAt: "2026-05-08T10:00:01.000Z",
        durationMs: 0,
        outcome: "denied",
        redactionApplied: false,
      };
      expect(denied.policyDecision).toBe("denied");
      expect(denied.denialReason).toBeDefined();
    });
  });

  describe("EnvironmentSpec", () => {
    it("constructs at minimal (no-network, empty grants)", () => {
      expect(minimalEnv.network).toBe("none");
      expect(minimalEnv.secretGrants).toHaveLength(0);
    });

    it("models workspace + secret grant", () => {
      const full: EnvironmentSpec = {
        cwd: "/workspace",
        workspace: {
          root: "/workspace",
          writablePaths: ["agents/test-agent/"],
          readOnlyPaths: ["murmuration/"],
        },
        publicEnv: { NODE_ENV: "production" },
        secretGrants: [
          {
            name: "GITHUB_TOKEN",
            targetEnv: "GITHUB_TOKEN",
            allowedToolIds: ["mcp__github__push_files"],
          },
        ],
        network: "declared",
        resourceLimits: { wallClockMs: 600_000 },
      };
      expect(full.workspace?.writablePaths[0]).toBe("agents/test-agent/");
      expect(full.secretGrants[0]?.name).toBe("GITHUB_TOKEN");
    });
  });

  describe("ExecutionContract", () => {
    it("constructs a minimal individual wake contract", () => {
      const contract: ExecutionContract = {
        wakeReason: { kind: "scheduled", cronExpression: "0 23 * * *" },
        wakeMode: "individual",
        objective: "Review open action items and post one comment.",
        requiredOutputs: [{ kind: "comment", description: "At least one issue comment" }],
        actionItems: [actionItemRef],
        completionConditions: [completionCondition],
        verification: [verificationStep],
        allowedSideEffects: ["read", "write"],
        budget: {
          maxInputTokens: 100_000,
          maxOutputTokens: 8_000,
          maxWallClockMs: 540_000,
          model: {
            tier: "balanced",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            maxTokens: 8_000,
          },
          maxCostMicros: 3_000_000,
        },
        approval: { mode: "none" },
      };
      expect(contract.wakeMode).toBe("individual");
      expect(contract.allowedSideEffects).toContain("write");
      expect(contract.actionItems[0]?.signalId).toBe("github-issue:xeeban/ep#1");
    });
  });

  describe("RunLedgerFilter", () => {
    it("constructs as empty (match-all)", () => {
      const filter: RunLedgerFilter = {};
      expect(filter.status).toBeUndefined();
    });

    it("constructs with all fields", () => {
      const filter: RunLedgerFilter = {
        status: "committed",
        fromDate: new Date("2026-05-01"),
        toDate: new Date("2026-05-08"),
        minSequence: 10,
      };
      expect(filter.status).toBe("committed");
    });
  });

  describe("AgentRuntime shape", () => {
    it("all boundary fields are typed (compile-only assertion)", () => {
      // This is a type-level test. If AgentRuntime's fields change, this
      // object literal will produce a compile error, which is the intent.
      const _typeCheck: Omit<AgentRuntime, "ledger"> = {
        wakeId: makeWakeId("test-wake-003"),
        agentId: makeAgentId("test-agent"),
        model: {
          tier: "balanced",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          maxTokens: 8_000,
        },
        prompt: minimalBundle,
        toolset: minimalToolset,
        environment: minimalEnv,
        contract: {
          wakeReason: { kind: "manual", invokedBy: "test" },
          wakeMode: "individual",
          objective: "Test wake.",
          requiredOutputs: [],
          actionItems: [],
          completionConditions: [],
          verification: [],
          allowedSideEffects: [],
          budget: {
            maxInputTokens: 1000,
            maxOutputTokens: 1000,
            maxWallClockMs: 60_000,
            model: {
              tier: "fast",
              provider: "anthropic",
              model: "claude-haiku-4-5-20251001",
              maxTokens: 1000,
            },
            maxCostMicros: 10_000,
          },
          approval: { mode: "none" },
        },
      };
      // If TypeScript accepts this object without error, the type is correct.
      expect(_typeCheck.agentId.value).toBe("test-agent");
    });
  });
});
