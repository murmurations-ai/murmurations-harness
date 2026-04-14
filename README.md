# Murmuration Harness

A generic, open-source TypeScript runtime for coordinating AI agent murmurations with pluggable governance.

> **Status:** Active development. Core runtime, CLI, web dashboard, 5 governance models, and 353 tests. See [docs/EXECUTION-PLAN.md](./docs/EXECUTION-PLAN.md) for detailed status.

## What this is

The Murmuration Harness runs any number of AI agents as a coordinated "murmuration" — scheduling agent wakes, coordinating work via GitHub Issues, running governance rounds, and providing operator visibility through CLI, TUI, and web dashboards. GitHub is the system of record for all collaborative state.

### Design principles

1. **Pluggable governance** — choose your decision-making model (S3, Chain of Command, Meritocratic, Consensus, Parliamentary) or write your own
2. **GitHub-first** — GitHub Issues are the async coordination layer; the harness reads and writes them
3. **LLM-agnostic** — bring your own API keys (Gemini, Anthropic, OpenAI, Ollama)
4. **Agents wake and figure out what to do** — they read signals and decide, not task-specific prompts
5. **Real work, not theater** — every action produces artifacts; meetings execute structured actions against GitHub
6. **Identity is inherited** — murmuration soul → agent soul → role; governance and operations are separate concerns

## Quick start

```bash
# Prerequisites: Node 20+, pnpm 9+

# Clone and build
git clone https://github.com/murmurations-ai/murmurations-harness.git
cd murmurations-harness
pnpm install && pnpm build

# Create a new murmuration
node packages/cli/dist/bin.js init ../my-murmuration

# Edit .env with your API keys, then:
node packages/cli/dist/bin.js start --root ../my-murmuration
```

See [docs/GETTING-STARTED.md](./docs/GETTING-STARTED.md) for the full walkthrough.

## Repository layout

```
murmurations-harness/
├── packages/
│   ├── core/              # @murmuration/core — daemon, scheduler, executors, governance, signals
│   ├── cli/               # @murmuration/cli — `murmuration` CLI (start, stop, attach, init, etc.)
│   ├── github/            # @murmuration/github — typed GitHub client with write-scope enforcement
│   ├── llm/               # @murmuration/llm — multi-provider LLM client (Gemini, Anthropic, OpenAI, Ollama)
│   ├── signals/           # @murmuration/signals — signal aggregator (GitHub issues, filesystem)
│   ├── secrets-dotenv/    # @murmuration/secrets-dotenv — .env secrets provider
│   └── dashboard-tui/     # @murmuration/dashboard-tui — terminal UI dashboard
├── examples/
│   ├── governance-s3/           # Self-Organizing (Sociocracy 3.0) governance plugin
│   ├── governance-command/      # Chain of Command governance plugin
│   ├── governance-meritocratic/ # Meritocratic governance plugin
│   ├── governance-consensus/    # Full Consensus governance plugin
│   ├── governance-parliamentary/# Parliamentary governance plugin
│   └── hello-world-agent/       # Minimal agent for testing
├── docs/
│   ├── ARCHITECTURE.md          # Architecture + 10 Engineering Standards
│   ├── GETTING-STARTED.md       # Setup guide
│   ├── LINT-DESIGN-GUIDE.md     # TypeScript patterns for strict mode
│   ├── CLI-TMUX-DESIGN.md       # tmux-style CLI design spec (ADR-0018)
│   └── adr/                     # 19 Architecture Decision Records
└── .github/workflows/ci.yml    # CI: build, typecheck, lint, format, test (Node 20 + 22)
```

## CLI commands

```bash
murmuration init [dir]                      # Interactive scaffolding for a new murmuration
murmuration start [--root|--name] [flags]   # Start the daemon
murmuration stop [--root|--name]            # Stop the daemon
murmuration restart [--root|--name]         # Stop + start
murmuration status [--root|--name]          # Show agent status
murmuration attach <name>                   # Interactive REPL (directive, wake, convene, switch)
murmuration list                            # Show all registered murmurations with liveness
murmuration register <name> --root <path>   # Register a murmuration by name
murmuration directive [flags] "message"     # Send a Source directive
murmuration group-wake [flags]              # Convene a group meeting
```

Flags: `--agent <id>`, `--dry-run`, `--once`, `--now`, `--governance <path>`, `--log-level debug|info|warn|error`

## Web dashboard

Set `MURMURATION_HTTP_PORT=3210` and visit `http://localhost:3210/dashboard`. The dashboard shows:

- Murmuration overview (agents, groups, wakes, artifacts, idle rate)
- Governance items (pending + resolved, with Convene button for Source)
- Recent meetings (fetched from GitHub — source of truth)
- Groups with member stats and meeting history
- Agents with sort/filter, wake buttons, and detail modals
- Daemon log viewer with level filtering

## Governance models

The harness ships with 5 governance plugins in `examples/`:

| Model                    | Decision method                | Terminology                   |
| ------------------------ | ------------------------------ | ----------------------------- |
| **Self-Organizing (S3)** | Consent (no objections = pass) | circle, tension, proposal     |
| **Chain of Command**     | Authority approval             | department, directive, report |
| **Meritocratic**         | Expert-weighted review         | guild, flag, standard         |
| **Consensus**            | Unanimous agreement            | assembly, concern, proposal   |
| **Parliamentary**        | Majority vote                  | committee, motion, amendment  |

Select at boot: `murmuration start --governance examples/governance-s3/index.mjs`

Or configure in `murmuration/harness.yaml`:

```yaml
governance:
  model: "self-organizing"
  plugin: "@murmuration/governance-s3"
```

## Development

```bash
pnpm install              # install dependencies
pnpm build                # build all packages
pnpm typecheck            # tsc --noEmit across all packages
pnpm lint                 # eslint (strict-type-checked)
pnpm format:check         # prettier check
pnpm test                 # vitest (353 tests, 29 files)
pnpm check                # all of the above (CI locally)
```

## Architecture

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the full architecture, including:

- Architecture layers (Source → GitHub → Harness → Governance → Strategy → Dashboard)
- GitHub as System of Record
- Structured actions (MeetingAction, WakeAction)
- Post-wake validation and "Did Work" enforcement
- 10 Engineering Standards

## License

MIT — see [LICENSE](./LICENSE).

## Provenance

Built in public by the [Emergent Praxis](https://github.com/xeeban/emergent-praxis) murmuration. Source: Nori Nishigaya (@xeeban).
