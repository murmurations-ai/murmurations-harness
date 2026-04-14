# Phase 1 Implementation Plan — Murmuration Harness

**Status:** Active
**Authored:** 2026-04-09 (Source + Claude Code, Engineering Circle Phase 0 mode)
**Spec reference:** [`MURMURATION-HARNESS-SPEC.md`](https://github.com/xeeban/emergent-praxis/blob/main/docs/MURMURATION-HARNESS-SPEC.md) §15 Phase 1
**Circle:** Engineering Circle (ratified via Issues #240, #241)

---

## Phase 1 Definition (from spec §15)

> **Phase 1 — Harness core scaffold** (starts after spec ratified)
>
> - Monorepo set up, pnpm workspaces, TS strict ✅ (commit `644ef63`)
> - `@murmurations-ai/core`: scheduler, signal aggregator, executor interface (stub) 🟡 (skeleton only)
> - `@murmurations-ai/github`: typed GitHub client with rate limiting and caching ⏳
> - `@murmurations-ai/secrets-dotenv` ⏳
> - `@murmurations-ai/cli`: `start`, `status`, `stop` ⏳
> - **Gate:** Daemon boots; scheduler fires a hello-world agent wake ⏳

---

## Split: Phase 1A (Gate) vs Phase 1B (Completion)

The Phase 1 deliverable list is large. Splitting into two stages lets us hit the gate quickly and then fill in the remaining packages before declaring Phase 1 shippable to Phase 2.

### Phase 1A — Minimum viable daemon (the gate)

The minimum code needed to prove the wake loop structurally works end-to-end, even without real agents or GitHub integration.

| Step | Deliverable                                                                                                                                                            | Owner                                               | Blocks         |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | -------------- |
| A1   | **Close carry-forward #3** — `AgentExecutor` interface explicit in `@murmurations-ai/core/execution`                                                                   | TypeScript #24 (review + author)                    | All downstream |
| A2   | Minimal `Scheduler` implementation in `@murmurations-ai/core/scheduler` — in-memory timer-based trigger                                                                | Architecture #23 (topology), TypeScript #24 (types) | A4             |
| A3   | `SubprocessExecutor` implementation of `AgentExecutor` — spawns a child process, captures stdout/stderr, returns result                                                | Architecture #23 + Security #25 review              | A4             |
| A4   | `@murmurations-ai/cli` package — `murmuration start` command that boots the daemon and holds                                                                           | DevOps #26                                          | A5             |
| A5   | Minimal daemon loop — instantiates scheduler + executor, registers a hello-world agent, enters run loop                                                                | Engineering Lead #22 integration                    | A6             |
| A6   | `examples/hello-world-agent/` — shell script or tiny Node script that prints "hello from agent" and exits 0                                                            | DevOps #26                                          | A7             |
| A7   | **Gate test:** `pnpm --filter @murmurations-ai/cli run start` → hello-world wake fires within 10 seconds → logs capture the wake → daemon shuts down cleanly on SIGINT | Engineering Lead #22 gates                          | Phase 1B       |

**A1 is load-bearing.** Everything downstream depends on the AgentExecutor interface being real and stable. TypeScript Agent #24 is accountable for closing carry-forward #3 before A2 starts.

### Phase 1B — Phase 1 completion

Everything needed to declare Phase 1 "done" per the spec's Phase 1 deliverable list.

| Step | Deliverable                                                                                                                                        | Owner                                                                |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| B1   | `@murmurations-ai/secrets-dotenv` — default secrets provider, pluggable interface                                                                  | Security #25 (policy) + DevOps #26 (implementation)                  |
| B2   | `@murmurations-ai/github` — typed GitHub client with rate limiting, caching, retry/backoff                                                         | TypeScript #24 (types) + DevOps #26 (implementation)                 |
| B3   | `Scheduler` extension — real cron triggers + event triggers (not just timer)                                                                       | Architecture #23 + TypeScript #24                                    |
| B4   | `SignalAggregator` implementation — reads GitHub + private notes + inbox                                                                           | Architecture #23 + Security #25 (trust tagging per carry-forward #4) |
| B5   | **Cost instrumentation plumbing** (Performance #27 carry-forward #5) — per-wake cost record schema, structured log format, GitHub API call counter | Performance #27 (defines), DevOps #26 (plumbs)                       |
| B6   | Test framework ADR (per #241 carry-forward, TypeScript #24 must be consulted)                                                                      | Engineering Lead #22 facilitates, TypeScript #24 consulted           |
| B7   | Lint/format ADR + setup (eslint, prettier)                                                                                                         | DevOps #26                                                           |
| B8   | First real tests on core + github + cli                                                                                                            | Whoever wrote the package                                            |
| B9   | CI setup (GitHub Actions: typecheck, lint, test, build)                                                                                            | DevOps #26                                                           |
| B10  | Phase 1 retro — Engineering Lead facilitates, circle-wide review of what shipped                                                                   | Engineering Lead #22                                                 |

### Phase 1 exit criteria (both A and B complete)

- [ ] Daemon boots, fires hello-world wake, shuts down cleanly (gate)
- [ ] All five Phase 1 packages exist and build cleanly
- [ ] `pnpm typecheck` and `pnpm build` pass on full monorepo
- [ ] At least one test per package (even if minimal)
- [ ] CI running on every PR, all checks green
- [ ] Cost instrumentation plumbed end-to-end
- [ ] Secrets provider working with `.env` file
- [ ] GitHub client making authenticated calls with rate-limit awareness
- [ ] At least 3 ADRs committed: pnpm workspace choice, TS strict baseline, ESM module system
- [ ] Engineering Lead #22 signs off on the Phase 1 → Phase 2 gate review
- [ ] No blocking objections from any circle member on Phase 1 deliverables

---

## Dependency graph

```
A1 (AgentExecutor interface)
  ↓
A2 (Scheduler) ──┐
  ↓              │
A3 (SubprocessExecutor)
  ↓
A4 (CLI) ────────┐
  ↓              │
A5 (Daemon loop) │
  ↓              │
A6 (hello-world agent example)
  ↓
A7 (GATE TEST)
  ↓
───────────────── Phase 1 Gate met ─────────────────
  ↓
B1 (secrets-dotenv) ──┐
  ↓                    │
B2 (github client) ────┤
  ↓                    │
B3 (cron + event triggers)
  ↓                    │
B4 (signal aggregator) ┤
  ↓                    │
B5 (cost instrumentation)
  ↓                    │
B6 (test framework ADR)
  ↓                    │
B7 (lint/format ADR)
  ↓                    │
B8 (real tests) ───────┘
  ↓
B9 (CI)
  ↓
B10 (Phase 1 retro + exit review)
  ↓
───────────────── Phase 1 Complete ─────────────────
```

---

## Execution approach

Per the ratified builder model (spec §14, Engineering Circle doc §3):
**Source + Claude Code is the builder. The Engineering Circle reviews, designs, and gates.**

Exception: DevOps Agent #26 writes infrastructure code (CI, daemon wiring, release automation) as a direct deliverable. Everything else is built by Source+Claude with specialist review before merge.

### Specialist involvement per step

Each deliverable lists the specialist(s) that must be consulted or must gate it. In Phase 0 operating mode, "consulted" means:

1. Spawn the specialist via Claude Code Task tool using the prompt template in their identity doc
2. Give them the deliverable to review
3. Integrate their feedback before commit
4. If they block, resolve per S3 protocol

**Carry-forward closure workflow:** For deliverables that close an existing Engineering Circle carry-forward (e.g., A1 closes harness repo #3), the specialist is spawned to **author** the deliverable, not just review it. The identity doc owner is accountable for the design.

### Engineering Lead gate reviews

Engineering Lead #22 gates two transitions:

1. **Phase 1A → Phase 1B** — after A7 gate test passes
2. **Phase 1B → Phase 2** — after all Phase 1 exit criteria are met

Both gate reviews happen as a spawned Engineering Lead session reviewing the state of the repo and declaring go/no-go on the GitHub issue tracking the phase.

---

## Execution order (this session)

Starting immediately after committing this plan:

1. **Commit this plan** to `docs/PHASE-1-PLAN.md` ← current step
2. **Spawn TypeScript Agent #24** to author the `AgentExecutor` interface (closes carry-forward harness repo #3)
3. Commit A1 deliverable
4. Implement A2 (scheduler) + A3 (subprocess executor) + A5 (daemon loop) together as `@murmurations-ai/core` additions
5. Create `@murmurations-ai/cli` package with `start` command (A4)
6. Create `examples/hello-world-agent/` (A6)
7. Run the gate test (A7)
8. Spawn Engineering Lead #22 for the Phase 1A gate review
9. Commit + push
10. Stop, report to Source, await direction on Phase 1B

**Explicit stop point:** this session targets Phase 1A only (the gate). Phase 1B is a follow-up session decision.

---

## Risks & tensions flagged ahead of time

### Risk 1 — Pi framework integration is deferred

The spec says the harness is built on `pi-mono`. We are not integrating Pi in Phase 1A — we are using Node subprocess + standard library only. Pi integration lands in Phase 2 (one-agent proof) per the spec's intent. **If Pi integration turns out to be load-bearing for the wake loop, Phase 2 will surface the gap and we re-open Phase 1.** Architecture Agent #23 should note this as a Phase 1A → Phase 2 risk.

### Risk 2 — The hello-world agent is not a real agent

The hello-world agent does not read an identity doc, does not reason over signals, does not call an LLM. It just prints "hello from agent." The wake loop is proven structurally but not semantically. **This is intentional for the gate.** The first real agent wake happens in Phase 2.

### Risk 3 — No test framework yet

Phase 1A has no tests. The test framework ADR is deferred to Phase 1B per the #241 carry-forward (TypeScript #24 must be consulted on selection). This means Phase 1A gate-testing is by hand + logs. **This is an accepted risk for velocity.** Phase 1B must land tests before Phase 2.

### Risk 4 — No CI yet

Same reasoning. CI is DevOps #26's Phase 1B deliverable. Phase 1A gate verification is manual.

### Risk 5 — Logging format is not yet decided

Performance #27 must define the cost accounting schema (carry-forward #5) before B5. For Phase 1A, we use minimal structured logs (JSON lines with timestamp, agent, wake_id, phase). This can be refactored when Performance #27 lands the real schema.

---

## Success signal for this session

Phase 1A is done when:

- `pnpm --filter @murmurations-ai/cli run start` boots the daemon
- Within 10 seconds, the daemon fires a hello-world agent wake
- The wake result is logged in structured JSON lines to stdout
- Pressing Ctrl+C shuts down the daemon cleanly (no orphan subprocesses)
- The gate test output is captured in a commit message as evidence
- Engineering Lead #22 reviews and approves the gate

When all five of those are true, this session ends with a commit, a push, and a report to Source.

---

_This plan is a living document. Updates commit directly to this file. If the plan changes significantly, Engineering Lead #22 notes the change in the next retro._
