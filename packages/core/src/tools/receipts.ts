/**
 * Tool call receipt — Proposal 07 Phase 0 (types only, no wiring).
 *
 * A `ToolCallReceipt` is the immutable record of one tool invocation
 * within a wake. Receipts are collected by `ToolInvocationRecorder`
 * (Phase 3) and stored in `RunLedgerEntry.toolReceipts` for auditability,
 * policy replay, and supply-chain traceability.
 */

import type { AgentId, WakeId } from "../execution/index.js";
import type { ToolDescriptor, ToolPermission } from "./registry.js";

/** Full audit record for a single tool call. */
export interface ToolCallReceipt {
  /** Schema version for forward compatibility. Currently 1. */
  readonly schemaVersion: 1;
  readonly wakeId: WakeId;
  readonly callerAgentId: AgentId;
  /** References `ToolDescriptor.id`. */
  readonly toolId: string;
  /** Optional semver or commit hash of the tool's implementation. */
  readonly toolVersion?: string;
  /** Permissions the tool declared it required (from `ToolDescriptor`). */
  readonly permissions: readonly ToolPermission[];
  readonly mutability: ToolDescriptor["mutability"];
  /** Version string of the policy configuration that was evaluated. */
  readonly policyVersion: string;
  /** Policy decision reached before the tool was called (or denied). */
  readonly policyDecision: "allowed" | "denied" | "approval-required";
  /** Set when `policyDecision` is `denied`. */
  readonly denialReason?: string;
  /** Set when `policyDecision` is `approval-required` and approval was granted. */
  readonly approvalId?: string;
  readonly approvedBy?: string;
  readonly approvedAt?: string;
  readonly approvalScope?: string;
  /** Names of secrets that were injected for this call. Values are never recorded. */
  readonly secretGrantNames: readonly string[];
  /** SHA-256 of the serialized tool input (redacted secrets replaced with `[redacted]`). */
  readonly inputHash: string;
  /** SHA-256 of the serialized tool output. `undefined` when the call was denied. */
  readonly outputHash?: string;
  /** ISO-8601 timestamp when the tool was invoked. */
  readonly startedAt: string;
  /** Wall-clock time consumed by this invocation in milliseconds. */
  readonly durationMs: number;
  /** Terminal outcome of this call. */
  readonly outcome: "success" | "failure" | "timeout" | "denied";
  /** Machine-readable error code on `failure` or `timeout`. */
  readonly errorCode?: string;
  /** `true` when the output was sanitized to remove secret values. */
  readonly redactionApplied: boolean;
  /** Short human-readable summary of the output (never the raw output). */
  readonly resultSummary?: string;
  /** Paths or refs to any artifacts the tool produced. */
  readonly artifactRefs?: readonly string[];
  /** Correlation id in an external system (e.g. GitHub API request id). */
  readonly externalCorrelationId?: string;
}
