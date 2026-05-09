# Research Note: Applying Lessons from LangGraph's Architecture

**Date:** 2026-05-07
**Context:** Based on langchain-ai/langgraph (GitHub), deepwiki.com/langchain-ai/langgraph/4.1-checkpointing-architecture,
and docs.langchain.com/langgraph/persistence. LangGraph is the most widely adopted production multi-agent
framework in 2026, using a Pregel/Bulk Synchronous Parallel (BSP) execution model. It is the most
architecturally sophisticated mainstream framework and the closest external reference point for
Proposal 07's Phase 7 (durable execution + RunLedger).

---

## 1. Checkpoint Contract — The Direct Analogue for RunLedger

**The Insight:** LangGraph's `BaseCheckpointSaver` defines a typed, pluggable contract for state persistence:

```python
class BaseCheckpointSaver:
    def get_tuple(config) -> CheckpointTuple  # restore by thread_id + optional checkpoint_id
    def list(config, filter, before, limit) -> Iterator[CheckpointTuple]  # paginated history
    def put(config, checkpoint, metadata, new_versions)  # save snapshot
    def put_writes(config, writes, task_id, task_path)  # save pending writes separately
    def delete_thread(config)  # remove thread + all checkpoints
```

A `Checkpoint` captures:

- `channel_values` — deserialized state per channel (the complete snapshot)
- `channel_versions` — version per channel (enables change detection)
- `versions_seen` — maps node IDs to processed channel versions (prevents duplicate execution)
- `updated_channels` — channels modified in this step
- `id` — monotonic UUID v6 (enables chronological sorting and time-travel)
- `ts` — ISO 8601 timestamp

**Harness Application:**

- **Phase 7 design input:** Proposal 07's `RunLedger` is conceptually analogous to LangGraph's `BaseCheckpointSaver`. The `RunLedgerEntry` type should follow the same pluggable contract pattern: an abstract `RunLedger` interface with `append(entry)`, `get(wakeId)`, `list(agentId, filter, before, limit)`, and `delete(agentId)` methods. This keeps the ledger storage-agnostic (in-memory for tests, SQLite for local, PostgreSQL for production).
- **The `versions_seen` pattern** maps to Proposal 07's need to avoid replaying already-processed action items. An `actionItemVersions` field in `SignalBundle` (recording which signal IDs were processed in the prior wake) would prevent the same directive from being acted on twice — a subtle correctness gap not yet named in Proposal 07.
- **The `channel_versions` pattern** maps to the `cacheAnchorIndex` optimization: stable channels (identity, role, contract) have versions that rarely increment; volatile channels (signals, health) increment every wake. An explicit channel version model makes cache-staleness detectable.

---

## 2. Two-Phase Write Model — Confirms RunLedger Design

**The Insight:** LangGraph separates pending writes from confirmed state via `put_writes` + `put`:

1. `put_writes` records what a task _intends_ to write, before the write is confirmed
2. `put` commits the full checkpoint after all writes in a superstep are applied

This enables: interrupt recovery (writes captured before crash are retrievable), human-in-the-loop approval (pending writes visible before application), and idempotent retry (reapply pending writes without re-executing the task).

Human-in-the-loop uses special write indices: `INTERRUPT (-3)` and `RESUME (-4)` constants pause/resume the graph at checkpoints, with pending writes capturing what would have happened — a human provides approval values stored as RESUME writes, injected on resumption.

**Harness Application:**

- **Proposal 07's RunLedger should distinguish pending and committed entries.** A `RunLedgerEntry` with `status: "pending" | "committed"` would enable the same pattern: an agent's `ToolCallReceipt` could be recorded as pending before external confirmation (e.g., a GitHub PR merge), then committed when confirmed. This is particularly relevant for approval-required tools.
- **Phase 7 `ContainerExecutor` design:** The INTERRUPT/RESUME pattern is the right model for `ApprovalPolicy: required` tools. Rather than blocking the entire executor, the wake should checkpoint at the approval request, surface pending writes to the human (Source), and resume with approved values. The ledger entry for that wake remains pending until approval completes.
- **Idempotent retry:** `RunLedgerEntry` should include a `requestId` per tool call, making repeated execution of the same action detectable. If a wake is retried (due to crash/timeout), the ledger prevents re-execution of already-committed actions.

---

## 3. Time-Travel Architecture — RunLedger Must Be Full Snapshots, Not Deltas

**The Insight:** LangGraph checkpoints are **complete state snapshots** (not deltas). Every superstep writes the full `channel_values`, not just what changed. This makes time-travel possible: any checkpoint can be loaded and execution resumed forward. Delta-based storage would require replay from the beginning.

Monotonic UUID v6 IDs ensure chronological ordering without a central counter. The `before` parameter in `list()` enables backward traversal for debugging.

**Harness Application:**

- **`RunLedgerEntry` must be a complete snapshot per wake**, not a diff from the prior wake. This is already implied by the proposal's interface design, but it should be stated explicitly as a constraint: the ledger stores complete wake records, not incremental updates. This makes individual wake inspection, rollback, and external audit possible without reconstructing state from a chain of diffs.
- **UUID v6 for WakeId:** The current `WakeId` type should use UUID v6 (time-ordered) rather than random UUID v4. This enables chronological ledger traversal without a separate sequence field and makes cross-wake ordering self-evident from the ID alone.
- **Post-Phase 7 direction:** LangGraph's `list(filter={"source": "update"})` capability enables filtering by checkpoint type. The Murmurations equivalent would be `RunLedger.list({ agentId, filter: { effectiveness: "low", idleWake: true } })` — filtering runs by health state for self-improvement analysis. This is the query surface a GEPA-equivalent loop would need.

---

## 4. Pregel/BSP Execution Model — The Parallel-with-Sync Insight

**The Insight:** LangGraph runs on the Pregel model: agents (nodes) communicate only through channels (shared state slots), and execution is divided into discrete **supersteps** where no node can observe another's writes during the same superstep. All writes become visible at the superstep boundary (the checkpoint). This prevents read-your-own-writes races in multi-agent graphs.

**Harness Application:**

- **Murmurations already uses GitHub as the equivalent of LangGraph's channels** — agents write to GitHub issues/files, and reads happen on the next wake. This is functionally a superstep model: writes are only visible after the wake completes and commits, not during. This is correct and should be stated explicitly as a design principle in ARCHITECTURE.md.
- **The harness#353 routing inversion bug** (CW agents received other agents' directives) is a violation of the superstep isolation principle: one agent's signal bundle contained items addressed to other nodes. The fix correctly filters at the aggregation stage. The Pregel model names why this must be at the aggregation stage, not the executor stage.
- **Cross-agent communication:** LangGraph uses channels for synchronous cross-agent state sharing. Murmurations uses GitHub issues for asynchronous cross-agent communication. Both are correct for their respective use cases (streaming vs. scheduled). The difference is latency (milliseconds vs. hours), not architecture.

---

## 5. Human-in-the-Loop Gate Model — Source-Approval Primitive

**The Insight:** LangGraph's human-in-the-loop uses three concepts:

1. **Interrupt checkpoints**: execution suspends, state preserved
2. **Pending writes**: the "would have happened" state is visible before approval
3. **Resume values**: human provides approval values injected as RESUME writes

The graph does not poll. The human has unlimited time to review. The interrupt point is declared in the graph definition, not hardcoded.

**Harness Application:**

- **`ApprovalPolicy: required` tools** in Proposal 07's `ToolDescriptor` need this model. The current design implies blocking the executor during approval, which breaks the scheduled wake model (a wake cannot block indefinitely waiting for a human).
- **Recommended pattern for Phase 7:** When an approval-required tool is about to execute, the wake writes a pending ledger entry, creates a GitHub issue requesting Source approval, and terminates the wake normally. On Source's approval (a comment or label on the issue), a new wake fires with the approved action pre-authorized as a RESUME-equivalent signal. The ledger links the two wakes via `parentWakeId`. This is the Murmurations-native equivalent of LangGraph's INTERRUPT/RESUME pattern.
- This pattern also applies to governance events that require consent before proceeding.

---

## Summary: What Proposal 07 Should Add

| Finding                                                         | Where to apply                                                                                      |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| RunLedger as pluggable interface (BaseCheckpointSaver analogue) | Phase 7 spec — abstract `RunLedger` interface with `append/get/list/delete`                         |
| Pending vs. committed ledger entries                            | `RunLedgerEntry.status` field — pending for approval-required, committed after confirmation         |
| `actionItemVersions` in SignalBundle                            | Phase 1 spec — prevent re-processing already-acted-on signals                                       |
| UUID v6 for WakeId                                              | Phase 0 types — time-ordered, enables chronological ledger traversal                                |
| Full snapshots, not deltas                                      | Phase 7 spec — state explicitly                                                                     |
| INTERRUPT/RESUME → approval-gated wake pattern                  | Phase 7 + ADR-0047 — approval-required tools create pending wake + GitHub issue, resume on approval |
| Pregel/superstep model as named principle                       | ARCHITECTURE.md — names why GitHub-as-channel and per-wake isolation are correct                    |
