# ADR-0028 — Eliminate the `agent.mjs` requirement for standard agents

- **Status:** Accepted (shipped v0.4.5)
- **Date:** 2026-04-19
- **Decision-maker(s):** Source
- **Related:** ADR-0019 (persistent-context agents), ADR-0023 (extension system), ADR-0027 (fallback identity)
- **Issue:** #113

## Context

The earlier harness required every murmuration to ship an `agent.mjs`
at its root. `SubprocessExecutor` spawned that script with
`MURMURATION_WAKE_ID` / `MURMURATION_AGENT_ID` env vars and treated
whatever the script printed as the wake result. That design leaked
harness implementation into Source's domain: a new adopter couldn't
stand up a governance-only murmuration without first authoring a
JavaScript module and importing the SDK. Contradicts the project's
stated principle that Source only edits Markdown + YAML.

Since ADR-0019 (persistent-context agents), LLM-backed agents already
route through `InProcessExecutor` + `createDefaultRunner`. The default
runner reads the identity chain, scans skills, renders signals, calls
the configured LLM, and emits a structured wake result. `agent.mjs`
only remained on the code path for _non-LLM_ agents at boot.

## Decision

### §1 — Route every agent through InProcessExecutor by default

Per-agent executor selection in `packages/cli/src/boot.ts`:

- If the operator has dropped an `agent.mjs` at the murmuration root
  AND the agent has no `llm:` declared, use the subprocess escape
  hatch (`SubprocessExecutor` spawning `<root>/agent.mjs`). This keeps
  the existing path working for operators who relied on it.
- Otherwise, **every** agent routes through `InProcessExecutor` with
  the default runner. LLM-backed agents get their LLM client from
  `buildAgentClients`; non-LLM agents get `clients.llm === undefined`
  and the default runner returns a `"skipped — no LLM client"` wake
  summary without crashing.

### §2 — The default runner is the floor, not the ceiling

`createDefaultRunner` already handles the full standard wake loop —
identity prompt assembly, skills-block generation, signal rendering,
action-item partitioning, LLM call, artifact capture. Custom logic is
opt-in via `agents/<name>/runner.mjs`. Source never has to author a
runner to get a working agent; they author one only when they need
wake behavior the default can't express.

### §3 — Public surface is markdown only

`docs/GETTING-STARTED.md` no longer mentions `agent.mjs` or
`runner.mjs` at all — those are internal implementation details.
The "write the runner" section is replaced with "That's it — no
code required." The `hello-world-agent` example drops its
`agent.mjs` too; the identity chain alone is enough to prove the
wake loop.

## Consequences

- **Positive:** `murmuration init` + editing two markdown files now
  produces a bootable, functional agent — no JavaScript required.
- **Positive:** Combined with ADR-0027's fallback identity, Source
  can scaffold `agents/<name>/` entirely empty and the daemon still
  comes up.
- **Positive:** Governance-only murmurations (facilitator + members
  making decisions without LLM-powered work) don't need an LLM
  provider wired — they'll emit skip summaries until someone adds
  one.
- **Negative:** Existing operator repos that relied on
  `<root>/agent.mjs` without declaring `llm:` on their agents still
  work (escape hatch preserved), but new adopters won't discover
  that path from the docs — the subprocess executor is an internal
  implementation detail, not part of the public contract.
- **Neutral:** `examples/hello-world-agent/` no longer ships an
  `agent.mjs`; the README now demonstrates the pure-markdown path
  (default runner emits a skip summary until an `llm:` block is
  added to `role.md`).

## Test plan

Covered implicitly by the existing `subprocess.test.ts` / `in-process`
runner tests — no new harness behavior was introduced, only a routing
change. Integration smoke test: create an agent directory with
`soul.md` + `role.md` (no `llm:`, no `runner.mjs`, no `agent.mjs`),
start the daemon, confirm it boots and the agent's wake records a
"skipped — no LLM client" summary. Then add an `llm:` block to
`role.md` and confirm the wake calls the LLM.
