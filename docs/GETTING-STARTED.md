# Getting Started with the Murmuration Harness

The Murmuration Harness is a generic agent coordination runtime. It runs any number of AI agents on scheduled wakes, each with their own LLM provider, GitHub access scopes, signal sources, and governance model. You bring the agents; the harness handles scheduling, cost tracking, artifact capture, and governance lifecycle.

This guide walks you from zero to a running murmuration in ~10 minutes.

## Prerequisites

- **Node.js 20+**
- **pnpm 9+** (`npm install -g pnpm`)
- An API key for at least one LLM provider (Gemini, Anthropic, OpenAI) — or Ollama running locally for free

## 1. Clone and build

```sh
git clone https://github.com/murmurations-ai/murmurations-harness.git
cd murmurations-harness
pnpm install
pnpm build
```

Verify: `pnpm check` should report all tests passing.

## 2. Create your murmuration

```sh
node packages/cli/dist/bin.js init ../my-murmuration
```

The interactive wizard asks:

1. **Target directory** — where to create the murmuration
2. **Purpose** — one sentence describing what this murmuration does
3. **First agent name** — e.g. `researcher`, `coordinator`, `builder`
4. **LLM provider** — `gemini`, `anthropic`, `openai`, or `ollama`
5. **Circle** — optional organizational unit (leave blank for none)
6. **Governance model** — `self-organizing`, `chain-of-command`, `meritocratic`, `consensus`, `parliamentary`, or `none`

This creates:

```
my-murmuration/
  murmuration/soul.md          ← your murmuration's purpose + values
  agents/<name>/soul.md        ← agent identity
  agents/<name>/role.md        ← agent config (LLM, schedule, scopes, budget)
  governance/circles/<circle>.md  ← if you named a circle
  .env                         ← API key placeholders (chmod 0600)
  .gitignore
```

## 3. Configure

### Add your API key

Edit `my-murmuration/.env`:

```
GEMINI_API_KEY=your-real-key-here
# GITHUB_TOKEN=ghp_your-token-here  ← uncomment if the agent writes to GitHub
```

The `.env` file must be `chmod 0600` — the harness refuses to load it otherwise.

### Edit the role

Open `agents/<name>/role.md` and customize the frontmatter:

```yaml
agent_id: "my-agent"
name: "My Agent"
model_tier: "balanced"

llm:
  provider: "gemini"
  model: "gemini-2.5-flash" # optional; resolved from tier if absent

wake_schedule:
  delayMs: 2000 # fires 2s after boot (for testing)
  # cron: "0 18 * * *"        # daily at 18:00 UTC (for production)
  # tz: "America/Vancouver"   # optional timezone for cron

signals:
  sources:
    - "github-issue"
    - "private-note"

budget:
  max_cost_micros: 100000 # 10¢ per wake
  max_github_api_calls: 10
  on_breach: "warn" # or "abort"
```

### Write the runner (for LLM agents)

If your agent uses an LLM, create `agents/<name>/runner.mjs`:

```js
export default async function runWake(ctx) {
  const { spawn, clients, signal } = ctx;

  // clients.llm is your LLM client (if configured)
  // clients.github is your GitHub client (if token + scopes configured)

  if (!clients.llm) {
    return { wakeSummary: "no LLM client — add API key to .env" };
  }

  const result = await clients.llm.complete(
    {
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "Hello from my agent!" }],
      maxOutputTokens: 500,
    },
    { signal },
  );

  if (!result.ok) {
    throw new Error(`LLM failed: ${result.error.code}`);
  }

  return {
    wakeSummary: `Agent responded: ${result.value.content.slice(0, 200)}`,
  };
}
```

If your agent does NOT use an LLM, create `agent.mjs` at the murmuration root instead (subprocess mode — see the hello-world example).

## 4. Boot

```sh
node packages/cli/dist/bin.js start --root ../my-murmuration
```

The daemon:

1. Discovers all agents in `agents/*/role.md`
2. Loads their identities (soul → role → circle contexts)
3. Constructs per-agent LLM clients + GitHub clients with write-scope enforcement
4. Registers each agent on its declared wake schedule
5. Fires wakes, captures artifacts to `.murmuration/runs/<agent>/`
6. Stays alive until SIGINT

### What you'll see in the logs

```json
{"event":"daemon.boot.config","rootDir":"...","agentDirs":["my-agent"]}
{"event":"daemon.compose.agent","agentId":"my-agent","llm":{"provider":"gemini","instantiated":true}}
{"event":"daemon.agent.registered","agentId":"my-agent","trigger":{"kind":"delay-once","delayMs":2000}}
{"event":"daemon.wake.fire","agentId":"my-agent","signalCount":0}
{"event":"daemon.wake.completed","outcome":"completed","cost":{"costMicros":5000}}
```

### Artifacts

After each wake, the harness writes:

- `.murmuration/runs/<agent>/<YYYY-MM-DD>/digest-<wakeId>.md` — the agent's wake summary with a YAML provenance header
- `.murmuration/runs/<agent>/index.jsonl` — one structured line per wake with full cost + LLM + GitHub metrics

## 5. Add more agents

Just create more directories under `agents/`:

```
my-murmuration/agents/
  researcher/role.md     ← already exists
  coordinator/role.md    ← new agent
  builder/role.md        ← another new agent
```

Each agent gets its own wake schedule, LLM provider, signal scopes, and budget. Restart the daemon and all agents are discovered automatically.

## 6. Add governance (optional)

The harness ships with a pluggable governance interface. Boot with a governance plugin to enable decision tracking, state machines, and review dates:

```sh
# Self-Organizing (Sociocracy 3.0)
node packages/cli/dist/bin.js start --root ../my-murmuration \
  --governance examples/governance-s3/index.mjs
```

When agents emit governance events during wakes (e.g. tensions, proposals), the plugin routes them, tracks items through states, and sets review dates. Five governance models are supported by the interface:

| Model                | Style                             |
| -------------------- | --------------------------------- |
| **Self-Organizing**  | Consent-based, circles (S3)       |
| **Chain of Command** | Hierarchical approvals            |
| **Meritocratic**     | Track-record-based authority      |
| **Consensus**        | Collective agreement              |
| **Parliamentary**    | Motions + voting (Robert's Rules) |

Write your own plugin by implementing the `GovernancePlugin` interface from `@murmuration/core`.

## 7. Useful flags

```sh
# Boot one specific agent (instead of discovering all)
murmuration start --root ../my-murmuration --agent my-agent

# Dry-run mode — GitHub mutations are default-denied
murmuration start --root ../my-murmuration --dry-run

# Exit after the first wake completes (useful for CI/scripting)
murmuration start --root ../my-murmuration --once
```

## 8. Run on a schedule

For production, use `cron` in the role.md frontmatter instead of `delayMs`:

```yaml
wake_schedule:
  cron: "0 18 * * *" # daily at 18:00 UTC
  tz: "America/Vancouver" # optional: interpret cron in local time
```

Then run the daemon as a long-lived process:

```sh
# nohup (survives terminal close)
nohup node packages/cli/dist/bin.js start --root ../my-murmuration \
  >> ../my-murmuration/.murmuration/daemon.log 2>&1 &

# or tmux (can reattach later)
tmux new -d -s harness 'node packages/cli/dist/bin.js start --root ../my-murmuration'
```

The daemon's cron scheduler fires wakes on time. If the machine sleeps, the wake fires immediately when it wakes up.

## Reference

| Package                       | What it does                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| `@murmuration/core`           | Daemon, scheduler, executors, identity loader, cost tracking, governance interface |
| `@murmuration/llm`            | Four-provider LLM client (Gemini, Anthropic, OpenAI, Ollama)                       |
| `@murmuration/github`         | Typed GitHub REST + GraphQL client with write-scope enforcement                    |
| `@murmuration/signals`        | Signal aggregator (GitHub issues, private notes, inbox messages, custom)           |
| `@murmuration/secrets-dotenv` | .env file loader with permission enforcement                                       |

| Example                       | What it demonstrates                                   |
| ----------------------------- | ------------------------------------------------------ |
| `examples/hello-world-agent/` | Minimal subprocess agent (no LLM)                      |
| `examples/research-agent/`    | Full LLM agent with real Gemini calls + GitHub commits |
| `examples/governance-s3/`     | Self-Organizing governance plugin with state machine   |
