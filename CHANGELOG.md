# Changelog

All notable changes to the Murmuration Harness are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/).

## [0.1.0] - 2026-04-14

### Added

- **Core runtime** — Daemon, scheduler (cron/interval/delay-once), signal aggregator, cost tracking
- **Agent executors** — SubprocessExecutor, InProcessExecutor, DispatchExecutor
- **Identity system** — murmuration soul → agent soul → role.md with YAML frontmatter
- **Governance** — GovernancePlugin interface, GovernanceStateStore with state machine, GovernanceGitHubSync (label swap + close on terminal)
- **5 governance plugins** — Self-Organizing (S3), Chain of Command, Meritocratic, Consensus, Parliamentary
- **Group meetings** — operational, governance, and retrospective wake kinds with structured MeetingAction output
- **LLM client** — 4-provider support (Gemini, Anthropic, OpenAI, Ollama) with pricing catalog
- **GitHub client** — typed REST/GraphQL client with write-scope enforcement (ADR-0017)
- **Signal aggregator** — GitHub issues, private notes, inbox messages, governance rounds
- **CLI** — `start`, `stop`, `restart`, `status`, `init`, `attach`, `directive`, `group-wake`, `backlog`, `register`, `unregister`, `list`
- **Web dashboard** — overview stats, governance panel (Convene button), meetings from GitHub, agent sort/filter, log viewer, group/agent detail modals
- **DaemonEventBus** — typed SSE events (wake, meeting, governance, log)
- **DaemonCommandExecutor** — extracted command handling with in-flight meeting/wake tracking
- **DaemonLoggerImpl** — structured logging with `--log-level` flag and SSE push
- **Session manager** — registry with heartbeat liveness, attach REPL (directive/wake/convene/switch + tab completion), ring buffer event replay
- **Enhanced init** — GitHub config, multi-agent loop, schedule prompt, session registration
- **10 Engineering Standards** codified in docs/ARCHITECTURE.md
- **19 ADRs** documenting architectural decisions
- **353 tests** across 29 test files
- **CI pipeline** — GitHub Actions on Node 20 + 22 (build, typecheck, lint, format, test, gate test)

[0.1.0]: https://github.com/murmurations-ai/murmurations-harness/releases/tag/v0.1.0
