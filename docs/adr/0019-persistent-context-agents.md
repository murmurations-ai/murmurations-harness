# ADR-0019 — Persistent context agents (long-running conversation windows)

- **Status:** Proposed
- **Date:** 2026-04-13
- **Decision-maker(s):** Source (design), Engineering Circle (consent pending)
- **Supersedes:** _none_
- **Extends:** ADR-0005 (errors-as-values executor), ADR-0016 (role template)
- **Related:** `packages/core/src/execution/index.ts` (AgentExecutor interface)

## Context

Today every agent wake is stateless: the harness assembles the identity chain + signals into a fresh prompt, makes a single LLM completion, collects artifacts, and discards the conversation. The agent "remembers" only through its artifacts (digests, GitHub issues, committed files) which are fed back as signals on the next wake.

This works well for task-oriented agents (publish a checklist, run a QA pass, generate a report). But it's limiting for agents that need **accumulated understanding** — coordinators tracking evolving threads, researchers building mental models across days, or editorial agents maintaining voice consistency across a content pipeline.

Claude Code and OpenClaw demonstrate a different model: a single long-running conversation that persists across interactions, with context compaction when approaching token limits. The agent builds on its prior reasoning instead of starting from scratch each time.

The harness should support both models as a per-agent configuration choice.

## Decision

### §1 — Two executor modes: stateless and persistent

Each agent declares its executor mode in `role.md` frontmatter:

```yaml
executor:
  mode: "stateless"    # default — fresh context each wake (current behavior)
  # OR
  mode: "persistent"   # long-running conversation window across wakes
  max_context_tokens: 200000    # context window budget
  summarize_at: 150000          # trigger compaction at this threshold
```

When `mode` is omitted, the default is `"stateless"` — no change to existing behavior.

### §2 — Persistent context lifecycle

A persistent-context agent operates as follows:

**First wake (cold start):**

1. Identity chain (soul + role) becomes the system prompt — same as stateless
2. Initial signals become the first user message
3. LLM responds with artifacts + reasoning
4. The full conversation (system prompt + user turn + assistant turn) is persisted to `.murmuration/runs/<agent>/conversation.jsonl`

**Subsequent wakes (warm start):**

1. Load the persisted conversation history
2. Append a new user turn containing only **new/changed signals** since last wake (not the full signal bundle — deltas only)
3. LLM responds with artifacts + reasoning, building on prior context
4. Updated conversation is persisted

**Context compaction (approaching limit):**

1. When total token count exceeds `summarize_at`, trigger compaction
2. Compaction summarizes older conversation turns into a compressed form that preserves: key decisions made, file paths referenced, governance items discussed, action items created, current working state
3. The summary replaces the older turns, freeing context space
4. A compaction marker is written to the conversation log for auditability

**Context reset (manual or governance-triggered):**

1. Source or a governance decision can reset an agent's context: `murmuration reset-context --agent <id>`
2. The old conversation is archived to `.murmuration/runs/<agent>/conversation-<timestamp>.jsonl`
3. Next wake starts cold

### §3 — Signal deltas for persistent agents

Stateless agents receive the full signal bundle each wake — they need it because they have no memory. Persistent agents should receive only what changed:

- **New issues** since last wake (created_at > last_wake_at)
- **Updated issues** (comments added, labels changed since last wake)
- **New inbox messages**
- **New governance events**
- **Closed/resolved items** (so the agent can stop tracking them)

The signal aggregator already timestamps signals. The persistent executor filters to deltas using the agent's `lastWokenAt` from the AgentStateStore.

### §4 — Implementation: PersistentContextExecutor

A new executor class implementing `AgentExecutor`:

```typescript
class PersistentContextExecutor implements AgentExecutor {
  // Loads conversation history from disk
  // Appends signal deltas as a new user turn
  // Calls LLM with full conversation
  // Persists updated conversation
  // Returns AgentResult (same interface as stateless)

  async spawn(context: AgentSpawnContext): Promise<AgentSpawnHandle>;
  async waitForCompletion(handle: AgentSpawnHandle): Promise<AgentResult>;
}
```

The executor wraps the existing `LLMClient.complete()` but passes the full message array instead of a single user message. The LLM client interface already supports multi-turn:

```typescript
interface LLMClient {
  complete(options: {
    model: string;
    messages: { role: "user" | "assistant"; content: string }[];
    systemPromptOverride?: string;
    // ...
  }): Promise<Result<LLMResponse, LLMError>>;
}
```

### §5 — Conversation storage format

`.murmuration/runs/<agent>/conversation.jsonl` — one JSON object per line:

```jsonl
{"role":"system","content":"...identity chain...","ts":"2026-04-13T00:00:00Z"}
{"role":"user","content":"...signals...","ts":"2026-04-13T09:00:00Z","wakeId":"w1","tokenCount":3200}
{"role":"assistant","content":"...response...","ts":"2026-04-13T09:00:30Z","wakeId":"w1","tokenCount":4100}
{"role":"user","content":"...new signals...","ts":"2026-04-13T10:00:00Z","wakeId":"w2","tokenCount":1800}
{"role":"assistant","content":"...response...","ts":"2026-04-13T10:00:45Z","wakeId":"w2","tokenCount":5200}
{"role":"compaction","content":"...summary of turns w1-w2...","ts":"2026-04-13T11:00:00Z","replacedWakes":["w1","w2"],"tokenCount":2000}
```

Each line carries `tokenCount` so the executor can track cumulative context size without re-tokenizing. The `compaction` role marks where summarization occurred.

### §6 — Which agents should use persistent context

Guidelines for operators:

| Agent type             | Recommended mode | Why                                                                   |
| ---------------------- | ---------------- | --------------------------------------------------------------------- |
| **Coordinator** (Wren) | Persistent       | Tracks cross-agent dependencies, evolving priorities, meeting threads |
| **Research**           | Persistent       | Builds mental models of the domain, tracks signal evolution           |
| **Editorial**          | Persistent       | Maintains voice consistency, remembers style decisions                |
| **Analytics**          | Persistent       | Tracks metric trends, remembers baselines                             |
| **Publishing**         | Stateless        | Runs a checklist — no memory needed                                   |
| **QA**                 | Stateless        | Evaluates each artifact independently                                 |
| **Design**             | Stateless        | Produces visual output from brief — no carry-over                     |
| **CFO**                | Persistent       | Tracks budget burn, cost trends                                       |

### §7 — Cost implications

Persistent context agents are more expensive per wake because each LLM call includes the full conversation history. The cost model:

- **Stateless:** `input_tokens = identity + signals` (fixed per wake)
- **Persistent:** `input_tokens = identity + conversation_history + signal_deltas` (grows over time, capped by compaction)

The `budget.max_cost_micros` ceiling in `role.md` already constrains per-wake spend. Operators should set higher budgets for persistent agents. The cost dashboard shows per-agent trends so operators can see if persistent context is worth the spend.

### §8 — Relationship to the wake model

Persistent context does NOT change the wake model. Agents still wake on schedule (cron) or on demand (directive). They still produce artifacts. They still participate in group meetings. The only difference is what the LLM sees when it wakes — full conversation history vs fresh context.

This is important: persistent context is an executor concern, not a daemon concern. The daemon schedules wakes, tracks state, routes governance events. The executor decides how to invoke the LLM. Clean separation.

## Consequences

### Positive

- Agents that need accumulated understanding get it without architectural changes to the daemon
- Per-agent opt-in — operators choose which agents benefit from persistence
- Conversation history is auditable (JSONL on disk, same pattern as existing run artifacts)
- Context compaction prevents unbounded growth
- The existing AgentExecutor interface is unchanged — PersistentContextExecutor is a new implementation, not a modification

### Negative

- Higher LLM costs for persistent agents (mitigated by budget ceilings)
- Context compaction is lossy — important details may be summarized away (mitigated by keeping compaction summaries rich)
- Debugging is harder — agent behavior depends on conversation history, not just current signals (mitigated by JSONL audit trail)
- New failure mode: corrupted conversation file (mitigated by cold-start fallback)

### Neutral

- Stateless agents are unaffected — this is purely additive
- The LLM client interface already supports multi-turn — no changes needed

## Alternatives considered

- **Store memory in agent soul/role files.** Rejected: these are identity documents, not working memory. Mixing them conflates who the agent is with what it remembers.
- **Use a vector database for agent memory.** Rejected as premature — the conversation JSONL with compaction is simpler and sufficient for the current scale. Vector retrieval can be layered on later.
- **Always use persistent context for all agents.** Rejected: many agents don't benefit, and the cost increase is unnecessary. Per-agent opt-in is the right default.
- **Use the LLM provider's built-in conversation management.** Rejected: ties us to one provider. The harness manages conversation history so agents can switch providers without losing context.

## Carry-forwards

- **CF-persist-A** — Context compaction algorithm. The initial implementation can use a simple "summarize the oldest N turns" approach. A smarter algorithm that preserves high-signal turns (governance decisions, action items) while aggressively compressing low-signal turns (status reports, routine digests) is a follow-up.
- **CF-persist-B** — Cross-agent context sharing. A coordinator agent might benefit from reading another agent's conversation summary. Out of scope for v1.
- **CF-persist-C** — Context visualization in the dashboard. Show per-agent context utilization (tokens used / max) as a progress bar. Useful for operators monitoring persistent agents.
- **CF-persist-D** — Conversation export for debugging. `murmuration context --agent <id> --format markdown` dumps the current conversation as a readable document.

---

_End of ADR-0019. This ADR is binding for the executor layer. Implementation requires a new `PersistentContextExecutor` class and a `role.md` frontmatter extension._
