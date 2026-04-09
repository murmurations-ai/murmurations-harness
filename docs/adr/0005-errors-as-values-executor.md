# ADR-0005 — Errors-as-values at the AgentExecutor boundary

- **Status:** Accepted
- **Date:** 2026-04-09 (retroactive; design from A1 commit `428d8f2`)
- **Decision-maker(s):** TypeScript / Runtime Agent #24 (while closing carry-forward [harness#3](https://github.com/murmurations-ai/murmurations-harness/issues/3))
- **Consulted:** Architecture Agent #23 (via the Phase 1A design review)

## Context

The `AgentExecutor` interface is the pluggable boundary between the daemon and whatever actually runs one agent session. Agent sessions fail in several distinct ways:

- The agent runs to completion without issue
- The agent errors mid-run (uncaught exception, LLM API error, etc.)
- The wake is killed via `kill(handle)` by the daemon or operator
- The wake exceeds its wall-clock budget and the executor kills it
- The executor itself malfunctions (fork failed, handle tracking lost, out of memory)

The interface must distinguish "the agent failed" from "the executor failed" so callers can reason about whether to retry, escalate, or ignore. It must also be ergonomic enough that daemon code is not cluttered with try/catch for expected outcomes.

There are two standard approaches:

1. **Exceptions for failure** — `waitForCompletion` rejects on any non-success. Caller uses try/catch for every call and inspects the error to figure out what happened.
2. **Errors as values** — `waitForCompletion` resolves with a result object whose `outcome` field is a discriminated union describing success/failure/killed/timed-out. Only catastrophic executor faults reject.

## Decision

**Use errors-as-values for expected agent outcomes. Reject only for catastrophic executor faults.**

Concretely:

```typescript
interface AgentExecutor {
  spawn(ctx): Promise<AgentSpawnHandle>; // rejects: SpawnError, CapabilityUnsupported, IdentityChainInvalid
  waitForCompletion(h): Promise<AgentResult>; // rejects: HandleUnknownError only
  kill(h, reason): Promise<void>; // rejects: HandleUnknownError only
  capabilities(): ExecutorCapabilities; // never rejects
}

type AgentOutcome =
  | { kind: "completed" }
  | { kind: "failed"; error: ExecutorError }
  | { kind: "killed"; reason: string }
  | { kind: "timed-out"; budget: CostBudget };
```

The caller pattern-matches on `result.outcome.kind` and does not need try/catch for expected failure modes. Only programmer errors (calling `waitForCompletion` with a handle the executor does not know about) reject.

## Consequences

**Makes easier:**

- Daemon code is clean:
  ```typescript
  const handle = await executor.spawn(ctx);
  const result = await executor.waitForCompletion(handle);
  logResult(result); // pattern-matches on outcome.kind inside
  ```
- Expected outcomes (agent errors, timeouts, kills) are part of the happy path, not exception flow
- The `AgentResult` always carries cost actuals and any emitted governance events, even on failure — we always pay for the wake, and we always care what it emitted
- Pattern-matching on `result.outcome.kind` is exhaustive-checkable by the compiler (discriminated union with `noUncheckedIndexedAccess` catches missing cases)

**Makes harder:**

- Callers must remember that `waitForCompletion` can return a failed result — it does not mean the wake succeeded. Linting helps, but there is a learning curve for contributors used to "await means success."
- The `ExecutorError` hierarchy is still used for the values inside `outcome.failed.error` and for the catastrophic reject paths — so we have both value-errors and thrown-errors in the same type, which could confuse.

**Reversibility cost:** Medium. Switching to throwing exceptions for agent failures would require updating all the caller sites (daemon, tests, future plugins) to use try/catch. Not impossible but not trivial.

## Alternatives considered

- **Reject on all failure** (option 1 above) — rejected. Forces try/catch on every call; the "expected failure" case becomes exceptional-flow code which is harder to reason about. Also loses the ability to return cost actuals on failure cleanly.
- **Rust-style `Result<T, E>`** — considered but rejected for TypeScript. Requires library support and adds a layer of ceremony that does not feel idiomatic in TS. The current shape (Promise resolves with discriminated union outcome) achieves the same goal with less ceremony.
- **Error codes as strings on a single `AgentResult`** — rejected because it does not get the type-level discriminated union narrowing. `outcome.kind === "timed-out"` unlocks `outcome.budget`; a flat string code does not.

## Related

- A1 implementation: `packages/core/src/execution/index.ts` — the `ExecutorError` base class documents the full rejection contract per method
- Type guards: `isCompleted`, `isFailed`, `isKilled`, `isTimedOut` exported from the same module for ergonomic narrowing
