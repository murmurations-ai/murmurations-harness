# LLM Observability with Langfuse

The Murmuration Harness integrates with [Langfuse](https://langfuse.com/) to give you full visibility into what your agents are doing with every LLM call. When enabled, every `generateText()` call in every agent wake automatically reports a trace to Langfuse — token usage, latency, model info, and cost. When disabled, it's a silent no-op with zero overhead.

**Time to set up:** 5 minutes (cloud) or 15 minutes (self-hosted).

## Do I need this?

### Yes, set it up if:

- You have **10+ agents** or **50+ wakes/day** — too many outputs to inspect manually
- You're **debugging a prompt** and need to see what the LLM actually received vs what it produced
- You're **tracking cost** across agents and want to know which ones are expensive and why
- You're running **group meetings** and want to verify each member got the right context
- You're **comparing providers** (Gemini vs Claude vs OpenAI) and want side-by-side quality/cost/latency data
- You want **regression detection** — catch quality drops after prompt changes before Source notices

### No, skip it if:

- You have **fewer than 5 agents** with daily or weekly wakes — structured logging (`daemon.wake.cost` events) tells you enough
- You're in **early development** and still shaping what agents do — the overhead of a dashboard isn't worth it until behaviors stabilize
- You're running **Ollama locally** for privacy — Langfuse Cloud sends prompts to their servers (use self-hosted instead, or skip entirely)

You can always add it later. The integration is already in the harness — it just needs credentials to light up.

## Setup: Langfuse Cloud (5 minutes)

### 1. Create an account

Go to [cloud.langfuse.com](https://cloud.langfuse.com) and sign up. The free Hobby tier gives you 50,000 observations/month with 30-day retention — enough for most murmurations.

### 2. Create a project

In the Langfuse dashboard, create a new project (e.g., "my-murmuration"). Go to Settings > API Keys and create a new key pair.

### 3. Add keys to your `.env`

```bash
# In your murmuration root (e.g., ../my-murmuration/.env)
LANGFUSE_SECRET_KEY=sk-lf-your-secret-key
LANGFUSE_PUBLIC_KEY=pk-lf-your-public-key
```

For EU-hosted Langfuse, also add:

```bash
LANGFUSE_BASEURL=https://eu.cloud.langfuse.com
```

### 4. Restart the daemon

```bash
murmuration restart
```

That's it. Every LLM call from every agent wake now reports to Langfuse automatically. No code changes needed.

### 5. Verify

After your first agent wake, you should see a trace in the Langfuse dashboard with the model, token counts, latency, and full prompt/response content.

## Setup: Self-hosted (15 minutes)

Self-hosting means your agent prompts, governance data, and soul.md content never leave your infrastructure. This is the right choice for sensitive content or zero external dependencies.

### 1. Run Langfuse via Docker Compose

```bash
git clone https://github.com/langfuse/langfuse.git
cd langfuse
docker compose up -d
```

Langfuse is now running at `http://localhost:3000`. Create an account, create a project, get your API keys from Settings.

### 2. Add credentials to your `.env`

```bash
LANGFUSE_SECRET_KEY=sk-lf-your-secret-key
LANGFUSE_PUBLIC_KEY=pk-lf-your-public-key
LANGFUSE_BASEURL=http://localhost:3000
```

### 3. Restart the daemon

```bash
murmuration restart
```

**Resource requirements:** A small VPS (1 CPU, 2GB RAM) or local Docker container handles a murmuration easily. A year of 10 agents x 365 days x 5 calls/wake = ~18k observations = ~20MB of data.

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

For multi-step tool calling wakes, each step produces a child span — you can see the full tool calling sequence as a trace tree. For circle meetings, each member contribution and facilitator synthesis are separate traces.

## Use cases

### Debugging a broken agent

**Scenario:** Research Agent #1 started producing empty digests after a role.md change.

1. Open Langfuse, filter traces by agent ID `01-research`
2. Compare a trace from before the change (good output) with one after (empty)
3. You see: the system prompt changed, and the new version accidentally removed the digest instruction
4. Fix the role.md, verify the next trace produces output

**Without Langfuse:** You'd be reading log files and guessing what the prompt looked like.

### Cost optimization

**Scenario:** Monthly LLM spend jumped from $15 to $45.

1. Open the Langfuse cost dashboard, filter by date range
2. You see: the Editorial Calendar agent switched from `gemini-2.5-flash` to `claude-opus-4-6` after a model tier change — 10x cost per wake
3. Decision: switch it back to Flash, or accept the cost if output quality justifies it

### Verifying group meetings

**Scenario:** A governance meeting ratified a proposal, but two members seem to have been ignored.

1. Filter traces by the group wake
2. Open each member's span — check their input included the proposal and governance queue
3. Open the facilitator's span — check all member contributions were in the input
4. You find: member #3's contribution was truncated because the context window was near-full
5. Fix: increase `maxOutputTokens` for group wakes

### Comparing providers

**Scenario:** Should we run the Research Agent on Gemini or Claude?

1. Run the agent on Gemini for a week, then Claude for a week
2. In Langfuse, filter by provider
3. Compare: output quality, latency (P50/P95), cost per wake, tool call success rate
4. Make the decision based on data, not vibes

### Regression detection

**Scenario:** After updating the wake prompt, the agent's self-reflection started saying "EFFECTIVENESS: low" every time.

1. Filter traces by agent, sort by date
2. Compare a pre-change trace with a post-change trace side by side
3. The new prompt accidentally included an instruction that made the agent overly self-critical
4. Fix the prompt, verify in the next trace

### Prompt cache hit rate

**Scenario:** You enabled prompt caching but costs didn't drop.

1. Filter traces by a specific agent, look at `cache_read_input_tokens` vs `input_tokens`
2. If cache reads are always 0, the cache is being invalidated every request
3. Common cause: a timestamp or UUID in the system prompt that changes every wake
4. Fix: move volatile content after the cache breakpoint

## Disabling observability

Remove the `LANGFUSE_*` variables from `.env` and restart. Zero overhead, zero network calls.

```bash
# Comment out or delete in .env:
# LANGFUSE_SECRET_KEY=sk-lf-...
# LANGFUSE_PUBLIC_KEY=pk-lf-...
```

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
- **Disable input/output recording** — requires modifying the `experimental_telemetry` config in the adapter

## Pricing

| Tier                 | Cost                     | Observations/month | Retention | Best for                         |
| -------------------- | ------------------------ | ------------------ | --------- | -------------------------------- |
| **Self-hosted**      | Free (you pay for infra) | Unlimited          | Unlimited | Privacy-sensitive, development   |
| **Cloud Hobby**      | Free                     | 50,000             | 30 days   | Small murmurations (< 10 agents) |
| **Cloud Pro**        | $59/month + usage        | Unlimited          | 90 days   | Production with teams            |
| **Cloud Enterprise** | Custom                   | Unlimited          | Custom    | SLA, audit logs, SSO             |

**No vendor lock-in.** The integration uses OpenTelemetry (an open standard). If you ever want to switch to a different observability backend (Helicone, Axiom, Datadog), swap the span processor in `telemetry.ts` — the instrumentation stays the same.

## Troubleshooting

### No traces appear

1. Verify the daemon restarted after adding keys (`murmuration restart`)
2. Check the keys are correct — try `curl -H "Authorization: Bearer $LANGFUSE_SECRET_KEY" $LANGFUSE_BASEURL/api/public/health`
3. For self-hosted: make sure Langfuse is running (`docker compose ps`) and `LANGFUSE_BASEURL` points to the right host/port

### Cost shows $0

Langfuse computes cost from its internal model pricing table. If you're using a model it doesn't recognize (e.g., a custom Ollama model), cost shows $0. The harness's own `WakeCostRecord` (which uses the `models.dev` pricing catalog) is the authoritative cost source.

### Worried about prompt data leaving your network

Use self-hosted Langfuse. All data stays on your infrastructure. The Docker Compose setup takes 15 minutes and runs on minimal hardware.

## Further reading

- [Langfuse documentation](https://langfuse.com/docs)
- [Vercel AI SDK telemetry](https://sdk.vercel.ai/docs/ai-sdk-core/telemetry)
- [ADR-0020 — Vercel AI SDK migration](./adr/0020-vercel-ai-sdk-migration.md) (§6 covers the Langfuse decision)
