# Murmuration Harness

**A suit of power armor for human-led AI coordination.**

The Murmuration Harness is an open-source TypeScript runtime that lets a single human — the **Source** — coordinate a murmuration of AI agents to do real work. It is not an autonomous agent framework. It is a tool that amplifies human agency.

> **v0.3.5** — Extensions (OpenClaw-compatible), web search, `harness.yaml` config, local collaboration, `cd && murmuration`. 8 packages on npm, 486 tests, 5 governance models. [CHANGELOG](./CHANGELOG.md)

## Philosophy: Source as a human role

The harness is built on the concept of **Source** — the person who holds the creative vision and bears accountability for the initiative. This concept comes from [Peter Koenig's Source Principle](https://www.source-principle.com/) and [Tom Nixon's work on Source](https://www.tomnixon.co.uk/) in collaborative organizations.

**Source is a uniquely human role.** It is the person who:

- Initiated the creative impulse and holds the vision
- Makes the calls that no agent, governance model, or process can make
- Sets the bright lines that agents must never cross
- Bears the risk and accountability that AI cannot hold

Think of it as a suit of power armor: the human provides the direction, the judgment, and the values. The harness provides the strength, the reach, and the tirelessness. Neither is useful without the other.

## What this is

The harness runs any number of AI agents as a coordinated "murmuration" — scheduling wakes, coordinating work via GitHub Issues, running governance rounds, and providing operator visibility through CLI, TUI, and web dashboards. GitHub is the system of record for all collaborative state.

### Design principles

1. **Source is human** — the harness amplifies human agency, it does not replace it
2. **Pluggable governance** — choose your decision-making model (S3, Chain of Command, Meritocratic, Consensus, Parliamentary) or write your own
3. **GitHub-first** — GitHub Issues are the async coordination layer; the harness reads and writes them
4. **Borrow infrastructure, build differentiators** — Vercel AI SDK for LLM calls, MCP for tools, Langfuse for observability; build only governance, coordination, and GitHub sync
5. **Agents wake and figure out what to do** — they read signals and decide, not task-specific prompts
6. **Real work, not theater** — every action produces artifacts; meetings execute structured actions against GitHub
7. **Identity is inherited** — murmuration soul → agent soul → role; governance and operations are separate concerns

## Quick start

```bash
# Prerequisites: Node 20+, pnpm 9+
npm install -g @murmurations-ai/cli

murmuration init my-murmuration
cd my-murmuration

# Add API keys to .env:
#   GEMINI_API_KEY=...    (or ANTHROPIC_API_KEY, OPENAI_API_KEY)
#   GITHUB_TOKEN=...      (optional — use --collaboration local for offline)

murmuration start
```

That's it. The harness auto-detects the `murmuration/` directory and loads all configuration from `murmuration/harness.yaml`. No flags needed for governance, collaboration, or log level — they're all in the config file.

For offline development (no GitHub):

```bash
murmuration start --collaboration local
```

Or install from source:

```bash
git clone https://github.com/murmurations-ai/murmurations-harness.git
cd murmurations-harness
pnpm install && pnpm build

alias murmuration="node $(pwd)/packages/cli/dist/bin.js"
murmuration init ../my-murmuration
cd ../my-murmuration
murmuration start
```

See [docs/GETTING-STARTED.md](./docs/GETTING-STARTED.md) for the full walkthrough.

## LLM providers

The harness uses the [Vercel AI SDK](https://sdk.vercel.ai/) (ADR-0020) for all LLM calls. Four providers are supported out of the box:

| Provider          | Package                       | Model examples                   |
| ----------------- | ----------------------------- | -------------------------------- |
| **Google Gemini** | `@ai-sdk/google`              | gemini-2.5-flash, gemini-2.5-pro |
| **Anthropic**     | `@ai-sdk/anthropic`           | claude-sonnet-4-20250514         |
| **OpenAI**        | `@ai-sdk/openai`              | gpt-4o, gpt-4o-mini              |
| **Ollama**        | `@ai-sdk/openai` (compatible) | llama3, mistral                  |

Configure per agent in `role.md`:

```yaml
llm:
  provider: "gemini"
  model: "gemini-2.5-flash"
```

### Tool calling (MCP)

Agents can use tools during wakes via the [Model Context Protocol](https://modelcontextprotocol.io/). Declare MCP servers in `role.md`:

```yaml
tools:
  mcp:
    - name: filesystem
      command: npx
      args: ["-y", "@modelcontextprotocol/server-filesystem", "./workspace"]
    - name: github
      command: npx
      args: ["-y", "@modelcontextprotocol/server-github"]
      env:
        GITHUB_TOKEN: "$GITHUB_TOKEN"
```

At wake time, the runner connects to declared MCP servers, discovers tools, and passes them to the LLM. The LLM can call tools in a multi-step loop (up to 5 rounds). Connections are cleaned up after each wake.

### Agent skills (AgentSkills.io)

The harness supports [AgentSkills.io](https://agentskills.io) — portable instruction sets for AI agents using **Three-Tier Progressive Disclosure**:

1. **Tier 1 (startup):** Scanner reads `skills/` directory, extracts `name` + `description` from each `SKILL.md` frontmatter, injects a compact `<available_skills>` XML block into the system prompt
2. **Tier 2 (triggered):** Agent reads the full `SKILL.md` via MCP `read` tool when the task matches a skill's description
3. **Tier 3 (deep dive):** Agent reads supplementary reference files as needed

Place `SKILL.md` files in your murmuration's `skills/` directory:

```
my-murmuration/
├── skills/
│   ├── s3-governance/SKILL.md
│   ├── research-digest/SKILL.md
│   └── content-review/SKILL.md
```

100% interoperable with OpenClaw and Claude Code skill format — any `SKILL.md` works without modification.

### Extensions (OpenClaw-compatible)

The harness supports an OpenClaw-compatible extension system. Place extensions in `extensions/` with an `openclaw.plugin.json` manifest:

```
my-murmuration/
├── extensions/
│   ├── web-search/
│   │   ├── openclaw.plugin.json
│   │   └── index.mjs
│   └── my-custom-tool/
│       ├── openclaw.plugin.json
│       └── index.mjs
```

A built-in **web search** extension ships with the harness — `web_search` (DuckDuckGo keyless or Tavily with `TAVILY_API_KEY`) and `web_fetch` (read any URL). No configuration needed for basic web search.

### Observability (Langfuse)

Set `LANGFUSE_SECRET_KEY` and `LANGFUSE_PUBLIC_KEY` in your environment. The harness automatically reports LLM spans to [Langfuse](https://langfuse.com/) via OpenTelemetry — token usage, latency, model info, and cost per wake. If the keys are absent, observability is a silent no-op. See [docs/OBSERVABILITY.md](./docs/OBSERVABILITY.md) for the full setup guide.

### Configuration (`harness.yaml`)

Settings that rarely change live in `murmuration/harness.yaml`:

```yaml
governance:
  plugin: "./governance-s3/index.mjs"

collaboration:
  provider: "github" # or "local" for offline
  repo: "my-org/my-murmuration" # governance repo (private)

products:
  - name: my-product
    repo: "my-org/my-product" # product repo (separate)

logging:
  level: "info"
```

CLI flags override the config file when set. The murmuration is self-contained — all configuration, identity, and runtime state live in one directory.

## Repository layout

```
murmurations-harness/
├── packages/
│   ├── core/              # Daemon, scheduler, executors, governance, runner, signals
│   ├── cli/               # `murmuration` CLI (start, stop, attach, init, etc.)
│   ├── github/            # Typed GitHub client with write-scope enforcement
│   ├── llm/               # Vercel AI SDK adapter (Gemini, Anthropic, OpenAI, Ollama)
│   ├── mcp/               # MCP tool loader (connects to MCP servers at wake time)
│   ├── signals/           # Signal aggregator (GitHub issues, filesystem)
│   ├── secrets-dotenv/    # .env secrets provider
│   └── dashboard-tui/     # Terminal UI dashboard
├── examples/
│   ├── governance-s3/           # Self-Organizing (Sociocracy 3.0)
│   ├── governance-command/      # Chain of Command
│   ├── governance-meritocratic/ # Meritocratic
│   ├── governance-consensus/    # Full Consensus
│   ├── governance-parliamentary/# Parliamentary
│   ├── hello-world-agent/       # Minimal agent for testing
│   └── research-agent/          # Full ADR-0016 research agent example
├── docs/
│   ├── ARCHITECTURE.md          # Architecture + 10 Engineering Standards
│   ├── GETTING-STARTED.md       # Setup guide
│   └── adr/                     # 20 Architecture Decision Records
└── .github/workflows/ci.yml    # CI: build, typecheck, lint, format, test (Node 20 + 22)
```

## CLI commands

```bash
# Daemon lifecycle
murmuration init [dir]                      # Interactive scaffolding
murmuration start [--root|--name] [flags]   # Start the daemon
murmuration stop [--root|--name]            # Stop the daemon
murmuration restart [--root|--name]         # Stop + start
murmuration status [--root|--name]          # Show agent status

# Session management
murmuration attach <name>                   # Interactive REPL
murmuration list                            # Show registered murmurations
murmuration register <name> --root <path>   # Register by name
murmuration config [edit|path]              # Show/edit config.toml

# Queries (require running daemon)
murmuration agents [--json] [--filter running|idle|failed]
murmuration groups [--json]
murmuration events [--json]
murmuration cost   [--json]

# Actions
murmuration directive [flags] "message"     # Send a Source directive
murmuration group-wake [flags]              # Convene a group meeting

# Help
murmuration help protocol                   # Show daemon protocol + parity matrix
```

Flags: `--agent <id>`, `--dry-run`, `--once`, `--now`, `--governance <path>`, `--log-level debug|info|warn|error`

## Web dashboard

Set `MURMURATION_HTTP_PORT=3210` and visit `http://localhost:3210/dashboard`. Shows agents, groups, governance items, meetings, cost tracking, and daemon logs.

## Governance models

| Model                    | Decision method                | Terminology                   |
| ------------------------ | ------------------------------ | ----------------------------- |
| **Self-Organizing (S3)** | Consent (no objections = pass) | circle, tension, proposal     |
| **Chain of Command**     | Authority approval             | department, directive, report |
| **Meritocratic**         | Expert-weighted review         | guild, flag, standard         |
| **Consensus**            | Unanimous agreement            | assembly, concern, proposal   |
| **Parliamentary**        | Majority vote                  | committee, motion, amendment  |

Select at boot: `murmuration start --governance examples/governance-s3/index.mjs`

## Development

```bash
pnpm install              # install dependencies
pnpm build                # build all 8 packages
pnpm typecheck            # tsc --noEmit across all packages
pnpm lint                 # eslint (strict-type-checked)
pnpm format:check         # prettier check
pnpm test                 # vitest (486 tests, 40 files)
pnpm check                # all of the above (CI locally)
```

## Architecture

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the full architecture, including:

- Architecture layers (Source → GitHub → Harness → Governance → Strategy → Dashboard)
- Borrow vs Build (Vercel AI SDK, MCP, AgentSkills.io, Langfuse vs governance, coordination, GitHub sync)
- GitHub as System of Record
- Structured actions (MeetingAction, WakeAction)
- Post-wake validation and "Did Work" enforcement
- 10 Engineering Standards

## License

MIT — see [LICENSE](./LICENSE).

## Provenance

Built in public by the [Emergent Praxis](https://github.com/xeeban/emergent-praxis) murmuration. Source: Nori Nishigaya ([@xeeban](https://github.com/xeeban)).
