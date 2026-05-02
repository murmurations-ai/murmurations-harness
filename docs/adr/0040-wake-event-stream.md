# ADR-0040 — Wake Event Stream for Live Agent Observability

- **Status:** Proposed
- **Date:** 2026-05-01
- **Decision-maker(s):** Source (Nori), Engineering Circle
- **Driver:** harness#273 (operator pain point surfaced 2026-05-01 14:43 PDT during EP #734 wake chain — operator could not see what an in-flight agent was doing for 5+ minutes between `daemon.wake.fire` and `daemon.wake.completed`).
- **Related:** ADR-0011 (cost record schema), ADR-0034 (subscription-cli provider family), ADR-0038 (Spirit MCP bridge — same observability gap), ADR-0039 (local executable authority).

## Context

A wake today emits exactly two operator-visible events: `daemon.wake.fire` at start and `daemon.wake.completed` at end. Anything that happens in between — model reasoning, tool calls, tool results, GitHub mutations, file writes — is invisible until the post-hoc `digest-<wakeId>.md` is written. Wall-clock between those bookends ranges from seconds to 10+ minutes per wake.

The result is a UX mode I'll call **wake fatalism**: the operator kicks off a wake (or a 6-agent chain), then has nothing to do but watch `ps`. There's no peephole. Three concrete failure modes follow from this:

1. **Slow iteration on agent prompts.** A bad prompt produces a bad wake. The operator can only diagnose by reading the post-hoc digest, then re-running. With live visibility, "this prompt is making the agent re-read the same issue 4 times" surfaces in seconds.
2. **Undetectable hangs and loops.** A subscription-cli adapter that gets stuck on a tool call, or a model in a tool-loop trap, looks identical to a model that's correctly working. No way to triage without killing.
3. **No prompt-injection in-flight detection.** ADR-0036 / ADR-0039 / ADR-0038 collectively introduce a permission posture surface. But none of those help if a malicious signal bundle hijacks the agent at minute 2 of a 6-minute wake — the operator only sees the artifacts at minute 7.

The infrastructure exists already. CLAUDE.md engineering standard #4 ("Events over polling") commits to `DaemonEventBus + SSE`. All three subscription CLIs support streaming output (`claude --output-format stream-json`, `codex exec --json` is streaming-by-default, `gemini -p --json`). Vercel AI SDK has `streamText`. We just haven't connected them.

## Decision (proposed)

We add a typed **wake event stream** that surfaces every meaningful in-flight step from both LLM transports (API + subscription-cli) through `DaemonEventBus` to multiple consumers (SSE, file-replay, TUI, CLI tail).

### Event types

```typescript
type WakeStreamEvent =
  | {
      kind: "wake.input.signals";
      agentId;
      wakeId;
      signalCount;
      signalSummaries: SignalSummary[];
      ts;
    }
  | { kind: "wake.input.system_prompt"; agentId; wakeId; promptHash; promptLength; ts }
  | { kind: "wake.thinking"; agentId; wakeId; text; ts }
  | { kind: "wake.tool.call"; agentId; wakeId; toolName; args; ts }
  | { kind: "wake.tool.result"; agentId; wakeId; toolName; durationMs; ok; resultSummary?; ts }
  | { kind: "wake.cost.tick"; agentId; wakeId; inputTokens; outputTokens; costMicros; ts }
  | { kind: "wake.error"; agentId; wakeId; phase; message; ts };
```

Three properties of this shape matter:

- **`wake.input.*` fires before `wake.thinking`.** The operator sees what the agent saw before it starts reasoning. Most "is the agent doing what I expected?" questions are actually "did the agent see what I expected?" — and that answer takes seconds, not minutes.
- **`tool.call` and `tool.result` are separate events.** A tool call that takes 30 seconds is invisible if you only emit the result. Separating them makes hang/slowness diagnosis trivial (`tool.call` without a matching `tool.result` after N seconds = stuck).
- **`thinking` events carry text blocks, not character deltas.** Per-character is too noisy by default; reserved for `--log-level=trace`.

### Transports

Both LLM paths produce the same `WakeStreamEvent` shape:

| Path             | Source                                                    | Implementation effort                                                                                                                 |
| ---------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| API (Vercel)     | `streamText` callbacks (`onTextDelta`, `onToolCall`, ...) | small — already SDK-supported                                                                                                         |
| subscription-cli | adapter newline-JSON parser emits as it parses            | small per adapter (claude is the largest — switch from `--output-format json` to `--output-format stream-json` and stream the parser) |

Both paths funnel into one method:

```typescript
daemon.eventBus.emit("wake.stream", evt);
```

### Consumers

- **`.murmuration/wake-streams/<wakeId>.jsonl`** — append-only, written for every wake by default at event-level granularity (skip `thinking` text body, keep tool calls + results + cost + errors). Trace-level (with full thinking text) opt-in via `--log-level=trace`.
- **SSE endpoint** — `GET /events?stream=wake&wakeId=<id>` (or `agentId=<id>`). Reuses existing daemon HTTP surface.
- **`murmuration tail`** — CLI command: `murmuration tail [--agent <id>] [--wake <id>] [--since <duration>]`. Pretty-prints from SSE.
- **Dashboard TUI** — live-wake pane subscribes via SSE, shows per-agent timeline.

### Granularity tiers

Three levels, set per-wake via `--log-level` flag (already exists in `murmuration start`):

| Level            | Includes                                                          | Persisted by default?                               |
| ---------------- | ----------------------------------------------------------------- | --------------------------------------------------- |
| `info` (default) | input.\* + tool.call + tool.result + cost.tick + error            | Yes — `wake-streams/<id>.jsonl`                     |
| `debug`          | + `thinking` text blocks (per assistant message, not per delta)   | Yes (with rotation)                                 |
| `trace`          | + character-level deltas + raw subprocess stdout + raw MCP frames | No (in-memory only; opt-in file via `--trace-file`) |

### Retention

`.murmuration/wake-streams/` rotates by default at 7 days. Configurable via `harness.yaml`:

```yaml
observability:
  wake_streams:
    retention_days: 7
    enabled: true
```

Off-switch via `enabled: false` for operators who consider the per-wake JSONL a privacy risk on shared boxes.

### Privacy / scrubbing

All events route through the existing `scrubLogRecord` recursive scrubber (per ADR-0010 / SecretValue infrastructure). Tool call args and tool result bodies are scrubbed identically to current daemon log. No new privacy surface — the bytes were already in memory; we're just not throwing them away.

## Consequences

**Easier:**

- Operator can diagnose stuck wakes, bad prompts, or rogue tool loops in seconds.
- Engineering circle dogfooding cycles get dramatically shorter (catch bad agent reasoning at minute 1 instead of post-mortem at minute 6).
- Prompt-injection in-flight detection becomes possible — a watchdog can subscribe to SSE and trip on tool-call patterns.
- `digest-<wakeId>.md` becomes a derivable artifact (could even be auto-generated from `wake-streams/<wakeId>.jsonl` by a separate post-process step).
- Foundation for future work: replay debugging, regression tests on agent reasoning, A/B prompt experiments.

**Harder:**

- Log volume goes up. Estimated default-tier: ~10× current daemon log per wake (tens of KB → low MB). Trace-tier: ~100×. Mitigated by retention default and the off-switch.
- Adapter parse complexity for `claude --output-format stream-json` — newline-delimited JSON has edge cases (mid-event newlines in code blocks, malformed events on subprocess crash, premature exit). The current `parseOutput` already handles the buffered version; the streaming version needs incremental state management.
- Subscription-cli adapters now have two parse modes (one-shot for legacy callers, streaming for daemon callers). Either we pick one (streaming everywhere, with the adapter buffering for callers that want a single result) or we maintain both. Recommendation: pick streaming, derive one-shot from the final-state event.
- DaemonEventBus throughput. If we emit per-tool-call for an agent that makes 200 tool calls in a wake, that's 400 events/wake (call + result). Multiplied by N concurrent wakes, the SSE endpoint needs a per-subscriber buffer. Manageable but not free.
- Definition of "thinking text block." Vercel SDK and claude CLI use slightly different content-block semantics. Need an adapter shim that normalizes; this is the load-bearing piece for the API/CLI parity claim.

**Reversibility:** High. The change is purely additive at the protocol level (new events, new endpoint, new file). Existing consumers (digest writers, cost recorders, post-hoc analyzers) keep working. We can ship the daemon-log-only piece (Layer 1 from harness#273) and stop there if the rest doesn't pay back.

## Alternatives considered

### A. Keep status quo; document the wait

Tell operators "wakes take 5 minutes; check back later." Nothing to build.

Rejected: this is the current state. The pain is recurring. Building any of the layers below pays back faster than answering "what's the agent doing?" by hand each time.

### B. File-tail-only (Layer 1 from harness#273) — no event bus

Switch subscription-cli adapters to streaming output, dump all event records into the existing daemon log. Operators tail/grep. No SSE, no TUI integration, no new file format.

Cheap (~1 day). Solves 80% of the operator pain (visibility during wakes). Doesn't enable replay, doesn't unblock TUI live-wake pane, doesn't unify with the API path.

Recommendation: ship this as the first PR (Layer 1). Treat ADR-0040 as the path to Layer 2 + Layer 3, not a competitor.

### C. Per-character streaming as default

Stream every text delta to the daemon log and SSE.

Rejected: log volume too high for default. Nice for debugging hangs (you see the model typing in real time), but operators don't need it 99% of wakes. Reserved for `--log-level=trace`.

### D. Build a separate observability service

Spin up a dedicated process that proxies LLM calls and emits events. Decouple from daemon entirely.

Rejected: violates engineering standard #1 ("fix root causes, not symptoms"). The daemon is the right owner — it already controls the LLM client lifetime. Adding a sidecar would split that ownership and create a new failure mode (sidecar crashes mid-wake).

### E. Use OpenTelemetry / Langfuse instead of custom event types

Emit OTel spans, push to Langfuse (per ADR-0022). Operators consume via Langfuse UI.

Deferred, not rejected: ADR-0022 is Accepted but Langfuse adoption is partial. If/when Langfuse is the dominant observability surface, the WakeStreamEvent types proposed here can map to OTel spans 1:1. Don't block on it now — operators want a `tail` command in the terminal today.

## Risks and follow-ups

- **R1: Stream parse correctness.** `claude --output-format stream-json` may have edge cases that the buffered `--output-format json` parser doesn't hit. Need fuzzing-style tests on the adapter.
- **R2: SSE backpressure.** A slow consumer on a hot wake could OOM the daemon if events queue unboundedly. Need a per-subscriber bounded buffer with drop-oldest semantics.
- **R3: Retention bug class.** A wake that fails to write its `wake-streams/<wakeId>.jsonl` (disk full, permissions) shouldn't fail the wake itself. Treat the stream file as best-effort, log the write failure but don't propagate.
- **R4: Cost record drift.** Today `wake.cost.tick` events are intermediate. Final cost is in `WakeCostRecord` written at end. Need a clear contract: `cost.tick` is approximate (last-known after each tool round), `WakeCostRecord` is authoritative final.
- **R5: Token-level deltas at trace level may exceed pipe buffer in subprocess stdout.** Some subscription CLIs may block on stdout if the daemon is slow to drain. Need to verify the daemon's reader doesn't introduce backpressure on the subprocess.
- **R6: Privacy review.** Even with `scrubLogRecord`, the operator now has a per-wake JSONL containing tool args + results. For an agent that calls `gh issue comment` with sensitive content, that content lands in `wake-streams/`. Need an opt-out and clear documentation. Same surface as today's daemon log but more concentrated.

## Definition of done

(Mirrors harness#273.)

- [ ] WakeStreamEvent types in `packages/core/src/daemon/`
- [ ] Subscription-cli adapter switched to streaming output (claude first, then codex/gemini)
- [ ] API path emits via `streamText` callbacks
- [ ] DaemonEventBus emits `wake.stream` events
- [ ] `.murmuration/wake-streams/<wakeId>.jsonl` written by default at info level
- [ ] SSE endpoint `GET /events?stream=wake&wakeId=<id>`
- [ ] `murmuration tail` CLI command
- [ ] Dashboard TUI live-wake pane
- [ ] Retention policy + config knob
- [ ] Privacy review + opt-out
- [ ] Tests covering parse edge cases and backpressure
