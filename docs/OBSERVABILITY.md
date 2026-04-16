# LLM Observability with Langfuse

The Murmuration Harness integrates with [Langfuse](https://langfuse.com/) to give you full visibility into what your agents are doing with every LLM call. When enabled, every `generateText()` call in every agent wake automatically reports a trace to Langfuse — token usage, latency, model info, and cost. When disabled, it's a silent no-op with zero overhead.

## Why enable observability?

Running a murmuration means running many agents making many LLM calls, often on autopilot via cron schedules. Without observability, you're flying blind:

**Cost visibility** — A 28-agent murmuration running daily wakes can accumulate significant LLM spend. Langfuse shows you cost per agent, per wake, per day, so you can spot expensive agents before your bill surprises you. "The research agent costs $0.013 per wake but the editorial agent costs $0.04 — why?"

**Quality debugging** — When an agent produces poor output, you need to see what prompt it received and what the model returned. Langfuse captures the full input/output for every LLM call, so you can trace a bad digest back to the exact prompt that produced it.

**Latency monitoring** — Agent wakes have wall-clock budgets. If a wake is hitting its timeout, Langfuse shows you whether the bottleneck is the LLM response time, tool calling loops, or something else.

**Tool calling visibility** — When agents use MCP tools during wakes, each tool call becomes a span in the trace. You can see the full tool calling sequence: which tools were called, what arguments were passed, what results came back, and how many round-trips the model needed.

**Meeting cost tracking** — Circle meetings invoke 7+ LLM calls (one per member plus facilitator). Langfuse shows you the total cost per meeting and whether certain agents are producing disproportionately long (expensive) contributions.

**Trend analysis** — Over time, Langfuse dashboards show you patterns: are your agents getting more efficient? Are token counts growing (prompt bloat)? Is a particular model version performing better than another?

**Multi-murmuration comparison** — If you run multiple murmurations (e.g., one for content, one for engineering), Langfuse lets you compare their LLM usage side by side.

## Setup

### 1. Create a Langfuse account

Sign up at [cloud.langfuse.com](https://cloud.langfuse.com/) (free tier available) or [self-host](https://langfuse.com/docs/deployment/self-host) if you need data sovereignty.

### 2. Create a project

In the Langfuse dashboard, create a new project for your murmuration (e.g., "emergent-praxis" or "my-murmuration").

### 3. Get your API keys

In your project settings, find:

- **Secret Key** — starts with `sk-lf-...`
- **Public Key** — starts with `pk-lf-...`

### 4. Add keys to your murmuration's `.env`

```bash
# In your murmuration root (e.g., ../my-murmuration/.env)
LANGFUSE_SECRET_KEY=sk-lf-your-secret-key
LANGFUSE_PUBLIC_KEY=pk-lf-your-public-key
```

For EU-hosted Langfuse, also add:

```bash
LANGFUSE_BASEURL=https://eu.cloud.langfuse.com
```

### 5. Start the daemon

```bash
murmuration start --root ../my-murmuration
```

That's it. Every LLM call from every agent wake now reports to Langfuse automatically. No code changes, no configuration beyond the two env vars.

### 6. Verify in the Langfuse dashboard

After your first agent wake, you should see a trace in the Langfuse dashboard with:

- **Trace name** — `ai.generateText`
- **Model** — e.g., `gemini-2.5-flash`
- **Input/output tokens** — the exact counts
- **Latency** — how long the LLM call took
- **Input/output content** — the full prompt and response (if `recordInputs`/`recordOutputs` are enabled, which they are by default)

## What gets traced

Each `generateText()` call produces an OpenTelemetry span with:

| Field            | Example                              |
| ---------------- | ------------------------------------ |
| Model            | `gemini/gemini-2.5-flash`            |
| Input tokens     | 8,083                                |
| Output tokens    | 4,375                                |
| Latency          | 23.5s                                |
| Function ID      | `gemini/gemini-2.5-flash`            |
| Prompt content   | The full system prompt + user prompt |
| Response content | The full LLM response                |

For multi-step tool calling wakes, each step produces a child span — you can see the full tool calling sequence as a trace tree.

For circle meetings, each member contribution and the facilitator synthesis are separate traces, so you can see per-agent cost within a meeting.

## Disabling observability

Remove the `LANGFUSE_SECRET_KEY` and `LANGFUSE_PUBLIC_KEY` from your `.env` (or don't set them). The harness checks for both keys at startup — if either is missing, telemetry is skipped entirely. No network calls, no overhead, no errors.

## Programmatic control

If you're building on the harness as a library:

```typescript
import { initLlmTelemetry, shutdownLlmTelemetry } from "@murmurations-ai/llm";

// Call once at process startup
const initialized = initLlmTelemetry();
// Returns true if keys were found and OTEL was initialized
// Returns false if keys are missing or already initialized (idempotent)

// Call at process shutdown for clean flush
await shutdownLlmTelemetry();
```

## Privacy considerations

By default, Langfuse captures the full prompt and response content. This means your agent identity docs (soul.md, role.md), signal bundles, and LLM outputs are sent to Langfuse's servers (or your self-hosted instance).

If this is a concern:

- **Self-host Langfuse** — your data stays on your infrastructure
- **Use Langfuse's data retention controls** — configure auto-deletion policies in your project settings
- **Disable input/output recording** — this requires modifying the `experimental_telemetry` config in the adapter (currently hardcoded to record both)

## Cost

Langfuse's free tier includes 50,000 observations per month. A single agent wake with one LLM call = 1 observation. A 7-agent circle meeting = ~8 observations (7 members + 1 facilitator, plus agenda generation). A 28-agent murmuration running daily wakes would use ~840 observations/month, well within the free tier.

## Further reading

- [Langfuse documentation](https://langfuse.com/docs)
- [Vercel AI SDK telemetry](https://sdk.vercel.ai/docs/ai-sdk-core/telemetry)
- [ADR-0020 — Vercel AI SDK migration](./adr/0020-vercel-ai-sdk-migration.md) (§6 covers the Langfuse decision)
