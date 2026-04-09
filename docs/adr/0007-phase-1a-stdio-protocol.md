# ADR-0007 — Phase 1A subprocess stdio output protocol

- **Status:** Accepted (Phase 1A only; will be superseded by Phase 2 structured output contract)
- **Date:** 2026-04-09 (retroactive; design from A3 commit `188a694`)
- **Decision-maker(s):** TypeScript / Runtime Agent #24, Architecture Agent #23
- **Consulted:** Security Agent #25 (trust-level tagging flagged as follow-up in carry-forward #4)

## Context

The `SubprocessExecutor` spawns an agent as a child process and needs to capture two things from the child's output:

1. **The wake summary** — the agent-authored text describing what it did during the wake (spec §7.1 step 4)
2. **Governance events** — structured events the agent emits (tensions, proposals, notify, autonomous actions, held items) that the daemon forwards to the governance plugin runtime after the wake completes

The child process is an arbitrary executable (in Phase 1A: a Node script; in Phase 2+: possibly a `claude` CLI invocation or a Pi-framework agent runtime). We cannot assume it has access to a shared library or typed SDK. The only guaranteed channel is stdout/stderr.

Options for structuring this:

1. **JSON per line (NDJSON)** — every stdout line is a JSON object with a type field
2. **Prefix markers** — lines starting with specific markers are treated as structured; other lines are free text
3. **Dedicated file descriptor** — child writes structured events to fd=3, human-readable output to fd=1
4. **No structure** — treat everything as free text, extract events later via LLM parsing

## Decision

**For Phase 1A only, use prefix markers on stdout:**

- Lines matching `::wake-summary:: <text>` are concatenated as the wake summary
- Lines matching `::governance::<kind>:: <json>` emit a governance event of the given kind with the JSON payload
- Everything else is captured as plain stdout and included in the wake summary if no explicit summary lines appeared

Implementation: `parseChildOutput` in `packages/core/src/execution/subprocess.ts`.

**This is a Phase 1A convenience, not a production protocol.** Phase 2 (the one-agent proof) must replace this with a real structured output contract, likely using NDJSON on a dedicated fd (option 3).

## Consequences

**Makes easier:**

- Phase 1A example agents can be written in 10 lines of bash or Node — no SDK required
- The protocol is human-readable; you can see exactly what the child wrote in the captured logs
- No dependency on a shared structured-output library across language boundaries

**Makes harder:**

- Prefix markers inside free text get accidentally captured. If an agent logs `::wake-summary:: foo` as part of a larger message, the harness parses it as a summary line. This is a real risk for agents that log LLM output verbatim.
- No validation that governance event payloads match the expected shape. Malformed JSON is silently dropped.
- Trust-level tagging per carry-forward #4 is not yet plumbed. Security Agent #25 must review before Phase 7 ship.
- Cost fields (input tokens, output tokens) cannot be reported through this protocol — Phase 1A hardcodes cost actuals to zero, which is accepted because hello-world does not make LLM calls.

**Reversibility cost:** Low. This is explicitly flagged as Phase 1A-only. Phase 2 will replace it wholesale without worrying about backward compatibility — there is only one Phase 1A example agent (`hello-world-agent`) and it lives in the same repo.

## Alternatives considered

- **NDJSON on stdout** — rejected for Phase 1A because it requires every child process to output valid JSON for every line, which makes the example agents more complex. Will revisit for Phase 2 with a dedicated fd.
- **Dedicated fd=3 for structured events** — correct long-term answer, rejected for Phase 1A because it adds plumbing complexity without Phase 1A benefit. Phase 2 will likely adopt this.
- **gRPC or IPC protocol** — rejected as over-engineered for a subprocess boundary. The whole point of subprocess execution is to avoid shared runtime, and IPC reintroduces coupling.
- **Parse arbitrary text via LLM** — rejected because it introduces another LLM call per wake, doubling cost, and is non-deterministic for a boundary that should be strict.

## Phase 2 replacement plan

Phase 2 (the one-agent proof) must land:

1. A `StructuredOutputWriter` helper in `@murmuration/core` that agents can import to write well-formed events
2. A dedicated file descriptor (fd=3) for structured events; stdout remains free-form logging
3. A JSON schema for each governance event type (landing via carry-forward [#2](https://github.com/murmurations-ai/murmurations-harness/issues/2))
4. Real cost reporting fields (landing via carry-forward [#5](https://github.com/murmurations-ai/murmurations-harness/issues/5))

This ADR will be marked `Status: Superseded by ADR-00NN` at that time.

## Related

- Carry-forward [#2](https://github.com/murmurations-ai/murmurations-harness/issues/2) — GovernancePlugin interface hardening (defines the real event payloads)
- Carry-forward [#4](https://github.com/murmurations-ai/murmurations-harness/issues/4) — Plugin trust boundary + prompt injection (will add trust-level tagging)
- Carry-forward [#5](https://github.com/murmurations-ai/murmurations-harness/issues/5) — Cost instrumentation gates (will replace the zero-cost stub with real reporting)
