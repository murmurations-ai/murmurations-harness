/**
 * Run ledger — Proposal 07 Phase 0 (types only, no wiring).
 *
 * `RunLedger` is the harness's durable wake history. Each entry is a
 * complete, independently-inspectable snapshot of one wake: prompt hash,
 * contract hash, tool receipts, action receipts, validation, health, cost,
 * and artifact refs. Hash-chained for tamper evidence.
 *
 * Phase 0: interface definitions only.
 * Phase 7: pluggable implementations (filesystem `runs.ts`, database).
 *
 * Design constraints:
 *   - Full snapshots, not deltas. Every entry is independently readable.
 *   - `status: "pending"` for approval-gated wakes (INTERRUPT/RESUME, Phase 7).
 *   - `WakeId` should use UUID v6 (time-ordered) in new wakes; existing UUID v4
 *     values in `AgentStateStore` remain valid — the runtime accepts both.
 *
 * The `RunLedgerHandle` is the narrow write interface given to the agent
 * runtime during a wake. The daemon holds the full `RunLedger`.
 */

import type {
  AgentId,
  ResolvedModel,
  WakeActionReceipt,
  WakeId,
  WakeValidationResult,
} from "../execution/index.js";
import type { WakeCostRecord } from "../cost/record.js";
import type { ToolCallReceipt } from "../tools/receipts.js";
import type { WakeHealthMetrics } from "../validation/health.js";

// ---------------------------------------------------------------------------
// RunLedgerHandle — narrow write interface given to the runtime per wake
// ---------------------------------------------------------------------------

/** Narrow interface the agent runtime uses to append to the ledger
 *  without holding a reference to the full `RunLedger`. */
export interface RunLedgerHandle {
  append(entry: RunLedgerEntry): Promise<void>;
}

// ---------------------------------------------------------------------------
// RunLedgerEntry — one complete wake record
// ---------------------------------------------------------------------------

/** One fully-committed wake record in the run ledger. */
export interface RunLedgerEntry {
  /** Schema version for forward-compatible readers. Currently 1. */
  readonly schemaVersion: 1;
  /** Monotonically increasing sequence number within this agent's ledger. */
  readonly sequence: number;
  /** SHA-256 of the previous entry's `entryHash`. Absent on the first entry. */
  readonly previousEntryHash?: string;
  /** SHA-256 of this entry's content (excluding `entryHash` itself). */
  readonly entryHash: string;
  /** UUID v6 (time-ordered) for new wakes; UUID v4 accepted for legacy wakes. */
  readonly wakeId: WakeId;
  /** Set on RESUME wakes that continue a prior INTERRUPT/RESUME sequence. */
  readonly parentWakeId?: WakeId;
  /** `pending` until all approval-gated actions are confirmed (Phase 7).
   *  `committed` is the normal terminal state. */
  readonly status: "pending" | "committed";
  readonly agentId: AgentId;
  /** SHA-256 of the serialized `PromptBundle`. */
  readonly promptHash: string;
  /** SHA-256 of the serialized `ExecutionContract`. */
  readonly contractHash: string;
  readonly model: ResolvedModel;
  /** Ordered by `startedAt` — enables sequencing validation. */
  readonly toolReceipts: readonly ToolCallReceipt[];
  readonly actionReceipts: readonly WakeActionReceipt[];
  readonly validation: WakeValidationResult;
  readonly health: WakeHealthMetrics;
  readonly cost: WakeCostRecord;
  /** Paths or refs to artifacts produced this wake. */
  readonly artifactRefs: readonly string[];
}

// ---------------------------------------------------------------------------
// RunLedgerFilter — query predicate
// ---------------------------------------------------------------------------

/** Filter for `RunLedger.list`. All fields are optional — omit to match all. */
export interface RunLedgerFilter {
  readonly status?: RunLedgerEntry["status"];
  readonly fromDate?: Date;
  readonly toDate?: Date;
  readonly minSequence?: number;
}

// ---------------------------------------------------------------------------
// RunLedger — pluggable storage interface (Phase 7)
// ---------------------------------------------------------------------------

/** Pluggable durable storage for wake records.
 *
 * Implementations:
 *   - In-memory (tests)
 *   - Filesystem via `packages/core/src/daemon/runs.ts` (Phase 7 migration)
 *   - Database (Phase 7+ production)
 */
export interface RunLedger {
  append(entry: RunLedgerEntry): Promise<void>;
  get(wakeId: WakeId): Promise<RunLedgerEntry | undefined>;
  list(
    agentId: AgentId,
    filter?: RunLedgerFilter,
    before?: WakeId,
    limit?: number,
  ): AsyncIterable<RunLedgerEntry>;
  delete(agentId: AgentId): Promise<void>;
}
