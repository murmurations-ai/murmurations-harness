# Changelog

All notable changes to the Murmuration Harness are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/).

## [0.4.3] - 2026-04-17

### Added

- **Built-in `@murmurations-ai/files` plugin** — shipped bundled with the CLI distribution. Four tools:
  - `write_file(path, content)` — create or overwrite, creates parent dirs, saves `.bak` on overwrite
  - `read_file(path)` — read UTF-8 text
  - `edit_file(path, find, replace)` — exact-single-occurrence replacement with `.bak`
  - `list_dir(path)` — directory enumeration with `[dir]`/`[file]` markers
  - Path safety: refuses escapes outside the murmuration root; refuses any basename matching `.env*`
- **Bundled-extension loading at boot** — the CLI scans `<cli-dist>/builtin-extensions/` alongside `<root>/extensions/`. Operator extensions shadow built-ins by id on collision.
- **Local-governance auto-include** — when `collaboration.provider: local`, the `files` plugin is automatically granted to every agent that has declared any plugins (without requiring an explicit declaration). Rationale: agents can't participate in governance (record proposals, decisions, tensions) without file access. Empty `plugins:` still uses the backward-compat "see everything" path.
- **`examples/extensions/files/`** — standalone reference copy of the plugin for operators using GitHub-mode or non-default collaboration providers.

### Changed

- `daemon.extensions.builtin.loaded` event logs bundled-extension discovery separately from operator extensions for clearer provenance.

### Verified

- The researcher in `test02` (local-gov) successfully wrote `notes/write-test.md` via `write_file`. Closes the long-standing "synthesizing findings and creating persistent artifacts remains a challenge" tension the researcher had been filing on every wake.

## [0.4.2] - 2026-04-17

### Added

- **Per-agent plugin declarations + runtime gating** (role.md `plugins:` field, ADR-0023 extension). Agents can declare which OpenClaw-compatible plugins they rely on:

  ```yaml
  plugins:
    - provider: "@murmurations-ai/web-search"
  ```

  Matching rule: provider string matches extension id directly OR via last path segment, so `@murmurations-ai/web-search` resolves to extension id `web-search`.

- **Backward-compat fallthrough:** empty or omitted `plugins:` continues to give the agent every loaded plugin's tools (today's behavior). Declared plugins filter to the declared subset.

- Group meetings keep the full tool set — a meeting isn't a single-agent wake.

- 3 new identity-loader tests for the plugin schema.

## [0.4.1] - 2026-04-17

### Added

- **Pluggable LLM provider registry** (ADR-0025, Phases 1-3) — `ProviderRegistry` class in `@murmurations-ai/llm` accepts arbitrary `ProviderDefinition` objects. Any Vercel-AI-SDK-compatible provider can be registered — Mistral, Groq, Bedrock, Vertex AI, xAI, Perplexity, DeepSeek, Cerebras, etc. — without forking the harness.
- **Extension hook for provider registration** — extensions gain `api.registerProvider(def)` (ADR-0023 integration). The daemon validates each contributed definition via `validateProviderDefinition` and logs `daemon.providers.registered` / `daemon.providers.invalid` / `daemon.providers.roster`.
- **`murmuration providers list`** CLI command — shows registered provider id, display name, env-key convention, and tier defaults (text + `--json`).
- **Worked Mistral example** at `examples/extensions/mistral/` — copy-paste reference for adding any provider as an extension.
- **ADR-0025** accepted (Phases 1-3 shipped; Phase 4 converts the four built-ins to standalone `@murmurations-ai/provider-*` packages).

### Changed

- **`@murmurations-ai/llm` now carries zero hardcoded vendor knowledge.** The four built-in provider declarations (Gemini, Anthropic, OpenAI, Ollama) moved to `packages/cli/src/builtin-providers/`. The llm package exposes only `ProviderRegistry`, `ProviderDefinition`, `validateProviderDefinition`, and `createLLMClient`.
- **`createLLMClient` requires explicit `{ registry, provider, model, token }`.** Tier-based model fallback is a caller concern (use `registry.resolveModelForTier(provider, tier)`).
- **Boot ordering** — daemon boot constructs the provider registry once, threads it into `buildSecretDeclaration` + `buildAgentClients` + extension loading. No singletons, no module-scope side effects.
- **`ProviderId = string`** — was a closed 4-union; now any registered id is valid. `KnownProviderId` and `KNOWN_PROVIDERS` removed.

### Removed

- **Legacy shims:** `packages/llm/src/tiers.ts` (`MODEL_TIER_TABLE`, `resolveModelForTier`, `lookupTierTable`), `packages/llm/src/adapters/provider-registry.ts` (`createVercelModel`, `providerEnvKeyName`).
- **Singletons:** `defaultRegistry()`, `seedDefaultRegistry()`, the process-wide `DEFAULT_REGISTRY`.
- **`@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/openai`** deps from `@murmurations-ai/llm/package.json` — those now live in the CLI package (where the built-ins live). Net: llm's install footprint shrinks.

### Security

- `validateProviderDefinition` enforces shape at the extension boundary — malformed contributions surface as `InvalidProviderDefinitionError` with the offending extension id, not silent corruption.

## [0.4.0] - 2026-04-17

### Added

- **Spirit of the Murmuration** (ADR-0024, Phase 1) — conversational LLM layer in the REPL. Input that doesn't start with `:` or match a known bare verb routes to a Claude / Gemini / OpenAI / Ollama session with 10 auto-allow tools (`status`, `agents`, `groups`, `events`, `read_file`, `list_dir`, `load_skill`, `wake`, `directive`, `convene`). Per-session conversation history; cost + token annotation per turn.
- **4 shipped Spirit skills** — `daemon-lifecycle`, `agent-anatomy`, `governance-models`, `when-to-use-governance`. Loaded on demand via `load_skill(name)`; `SKILLS.md` index is always in the system prompt.
- **Harness-level LLM default** — `harness.yaml` gains an `llm:` section (`provider` + optional `model`). Agents inherit unless they override in their `role.md` frontmatter. The Spirit also inherits the harness default.
- **Path-safety for Spirit filesystem tools** — `read_file` / `list_dir` refuse paths escaping the murmuration root or matching `*.env*`.
- **`providerEnvKeyName`** helper in `@murmurations-ai/llm` — single source of truth for provider → env-var-name mapping (replaces duplicated maps across CLI files).
- **ADR-0024** — Spirit of the Murmuration architecture (phased plan: MVP → memory + writes → dreaming).
- **ADR-0025** — Pluggable LLM provider registry (draft; on `spec/0025-pluggable-llm-providers` branch).

### Changed

- **`RegisteredAgent` holds `IdentityChain` directly** (issue #53) — dropped the flatten→inflate roundtrip that fabricated `"<phase-1a-placeholder>"` source paths. Unblocks Phase 4 dashboard + Phase 5 multi-instance.
- **Governance plugin isolation** (issue #43) — `GovernanceStateReader` interface separates reads from writes. Plugins receive a runtime reader proxy (via `makeGovernanceStateReader`), so `.mjs` plugins cannot cast back to the full store and call `create` / `transition`. Plugin-requested item creation goes through `GovernanceRoutingDecision.create`; the daemon applies it with `createdBy` derived from the triggering batch.
- **CLI commands adopt `CollaborationProvider`** (issue #90) — `directive`, `backlog`, `group-wake` now route through the collaboration factory (local or GitHub) instead of constructing `GithubClient` inline. Local mode works across all CLI commands; `group-wake.ts` consolidates three previously-duplicated client constructions.
- **`GitHubClientLike` structural type tightened** — `state: "open" | "closed" | "all"`, `labels: readonly string[]`, `body: string | null`. Drops a cross-package `as unknown as` cast.
- **`murmuration init`** asks for the harness-level default LLM provider first; per-agent questions default to it (still overridable per agent). Writes the `llm:` section into the generated `harness.yaml`.
- **500 tests** (up from 487): 13 new Spirit tests covering path safety, skill loading, and socket RPC wrappers.

### Fixed

- Stale docstring on `RegisteredAgent` that referenced a non-existent "Phase 1A inline" construction path.
- Frontmatter duplication in `buildSpawnContext` — aggregator calls now use `agent.identity.frontmatter` directly instead of rebuilding from scalar fields.

### Security

- **Runtime plugin isolation** — `GovernanceStateReader` proxy closes a bypass where a JavaScript plugin could runtime-cast the narrowed reader back to the full mutable store. Unit test asserts the proxy's runtime shape.
- **Spirit filesystem tools blocked** from reading `.env*` files or escaping the murmuration root.

### Deferred to Phase 2 (ADR-0024)

- Spirit memory storage (three-type index: operator / murmuration / reference)
- Confirm-before-acting tools (daemon lifecycle, file writes with diff preview)
- Operator-authored overlay skills at `<root>/spirit/skills/`
- `spirit.md` identity file + `murmuration spirit` CLI subcommands

## [0.3.5] - 2026-04-17

### Added

- **Extension system** (ADR-0023) — OpenClaw-compatible plugin loading from `extensions/` directory with `openclaw.plugin.json` manifests. Extensions register tools via `MurmurationPluginApi`.
- **Built-in web search extension** — `web_search` (Tavily if `TAVILY_API_KEY` set, DuckDuckGo keyless fallback) + `web_fetch` (read any URL, HTML-to-text). No API key needed for basic search.
- **`harness.yaml` config file** — governance plugin, collaboration provider, log level persist in `murmuration/harness.yaml`. CLI flags override config.
- **Auto-detect murmuration from cwd** — `cd my-murmuration && murmuration start` just works. Bare `murmuration` with no args auto-starts or shows registered sessions.
- **REPL directive management** — `:directive list`, `:directive close <id>`, `:directive delete <id>`, `:directive edit <id>` (opens in \$EDITOR for local provider)
- **REPL wake result display** — `:wake <agent>` shows completion/failure inline by polling the wake log
- **REPL disconnect survival** — daemon dying shows "(disconnected)>" prompt instead of exiting
- **Tab completion** — groups, directive subcommands, agent IDs in REPL
- **Agent ID validation** — typo agent names get clear error with available list
- **Langfuse trace enrichment** (ADR-0022 Phase 1) — agentId, wakeId, groupIds, wakeMode in telemetry metadata
- **ADR-0022** proposed and accepted — Langfuse-powered agent self-reflection
- **ADR-0023** proposed and consented (5/6 decisions) — extension system
- **23 new tests** — extensions (10), harness config (10), signal collaboration (3)
- **`@murmurations-ai/governance-s3`** published as npm package

### Changed

- Local collaboration items flow through signal aggregator (root cause fix, not runner hack)
- Directives use `CollaborationProvider` — local mode works without GitHub
- Default runner fallback when no `runner.mjs` exists
- Default wake prompt when no `prompts/wake.md` exists
- Governance plugin resolves as npm package or relative to murmuration root
- `process.exit()` replaced with `throw` in directive.ts (daemon stays alive on errors)
- Require `murmuration/` directory — clear error if not found
- CI gate test uses `--once` + timeout

### Fixed

- DuckDuckGo search parser regex (href before class in HTML attributes)
- Signal rendering for local items (SOURCE DIRECTIVE tag with full body)
- REPL `:switch` stays in REPL on connection failure
- Wake log polling uses offset to skip stale entries
- CI build failure: missing `yaml` dependency in CLI package

## [0.3.4] - 2026-04-16

### Added

- **Bare `murmuration` command** — typing `murmuration` with no arguments auto-starts if `murmuration/` directory found in cwd, otherwise shows registered murmurations with live status + help
- **Langfuse trace enrichment** (ADR-0022 Phase 1) — `CallOptions.telemetryContext` tags every LLM trace with agentId, wakeId, groupIds, and wakeMode for per-agent Langfuse queries

## [0.3.3] - 2026-04-16

### Added

- **CollaborationProvider interface** (ADR-0021) — pluggable abstraction for coordination, artifacts, and signals. `GitHubCollaborationProvider` wraps existing client; `LocalCollaborationProvider` uses filesystem for offline/testing. 22 contract tests.
- **`harness.yaml` config file** — governance plugin, collaboration provider, and log level persist in `murmuration/harness.yaml`. CLI flags override config. No more repeating `--governance` every start.
- **Auto-detect murmuration from cwd** — `cd my-murmuration && murmuration start` just works. No `--root` needed if current directory has a `murmuration/` folder.
- **Require `murmuration/` directory** — clear error if no murmuration found, instead of silently falling back to hello-world example.
- **ADR-0022 proposed and accepted** — Langfuse-powered agent self-reflection (governance-agnostic).
- **Engineering Circle** — 7 agents (#22-#28) created, 4 meetings convened, both ADRs consented.

### Changed

- Governance sync accepts `CollaborationProvider` (preferred) or legacy `GovernanceSyncGitHub` (backwards compat)
- Runner prefers `collaborationProvider.commitArtifact()` over legacy two-step GitHub commit
- S3 three-phase meeting architecture — facilitator generates agenda, Source directive overrides
- `--collaboration local` flag for filesystem-based governance (no GitHub token needed)
- `--agenda` alias for `--directive` in group-wake
- CI gate test uses `--once` + timeout instead of sleep+kill

### Fixed

- CI build failure: missing `yaml` dependency in CLI package
- CI gate test hanging: daemon wasn't terminating in CI environment

## [0.3.2] - 2026-04-16

### Added

- **S3 three-phase meeting architecture** — meetings now follow agenda-formation → member-round → facilitator-synthesis. Facilitator generates a focused 3-5 item agenda from governance queue, backlog, and signals. Members address agenda items specifically, not generic "what's working."
- **Source directive override** — `--directive` (or `--agenda`) flag makes the directive the sole agenda item. Agents address ONLY the directive, suppressing all standard meeting behavior. Source has reliable override authority.
- **Facilitator agenda generation** (Phase 0) — when no directive is present, the facilitator LLM call generates the meeting agenda before the member round begins.
- **AgendaItem type** — meetings track agenda items with title, description, and source (directive/governance/operational).
- **Meeting minutes include agenda** — both console output and GitHub issue minutes show the meeting agenda.

### Changed

- Member prompts are agenda-driven ("Address each agenda item from your domain perspective") instead of generic ("Share your perspective on priorities")
- System prompt for members explicitly constrains: "Your job is to address the meeting agenda — not to discuss anything outside of it"
- Backlog context passed separately for agenda generation, not merged with directive body

## [0.3.1] - 2026-04-15

### Added

- **AgentSkills.io integration** — Three-Tier Progressive Disclosure for agent skills. SkillScanner recursively scans `skills/` directory for `SKILL.md` files, parses YAML frontmatter (name, description), and injects `<available_skills>` XML block into agent system prompts. Agents use MCP `read` tool to load full skill instructions on demand. 100% interoperable with OpenClaw and Claude Code SKILL.md format.
- 14 new skill scanner tests (scanning, parsing, XML formatting, edge cases)
- 441 total tests across 37 files

### Dependencies

- Added: `gray-matter` (in core, for SKILL.md frontmatter parsing)

## [0.3.0] - 2026-04-15

### Added

- **Vercel AI SDK migration** (ADR-0020) — replaced 4 hand-rolled HTTP adapters (Gemini, Anthropic, OpenAI, Ollama) with a single `VercelAdapter` wrapping `generateText()`. Net -1,200 LOC of plumbing code.
- **Tool calling** — `ToolDefinition` and `ToolCallResult` types, multi-step tool loops via `stepCountIs()`, per-step cost tracking via `onStepFinish`
- **MCP integration** — new `@murmurations-ai/mcp` package with `McpToolLoader`. Agents declare MCP servers in `role.md` frontmatter (`tools.mcp`); runner connects at wake time, discovers tools, passes to LLM
- **Langfuse observability** — `initLlmTelemetry()` / `shutdownLlmTelemetry()` backed by `@langfuse/otel` + OpenTelemetry. Vercel AI SDK emits OTEL spans; Langfuse receives them when keys are set (silent no-op otherwise)
- **Identity schema** — `tools.mcp` (array of `{name, command, args, env, cwd}`) and `tools.cli` (string array) with defaults for backwards compatibility
- **Runner MCP path** — loads MCP tools before LLM call, passes `tools` + `maxSteps: 5`, closes connections in `finally` block
- **427 tests** across 36 files (up from 392 / 34), including comprehensive error mapping, telemetry, tool loader, and runner integration tests

### Changed

- `LLMRequest` gains optional `tools` and `maxSteps` fields
- `LLMResponse` gains optional `toolCalls` and `steps` fields
- `DefaultRunnerClients` gains optional `mcpToolLoader` client
- `AgentSpawnContext` gains `mcpServerConfigs` field
- `RegisteredAgent` gains `tools` field
- ADR-0020 status updated to Accepted (all four phases shipped)

### Dependencies

- Added: `ai`, `@ai-sdk/google`, `@ai-sdk/anthropic`, `@ai-sdk/openai`, `zod` (in llm)
- Added: `@modelcontextprotocol/sdk` (in mcp)
- Added: `@langfuse/otel`, `@opentelemetry/sdk-node` (in llm)

## [0.2.0] - 2026-04-14

### Added

- **Protocol registry** (`protocol.ts`) — single source of truth for all 17 RPC methods with parity matrix, mutating flags, and surface status
- **Schema versioning** — `schemaVersion` field in status responses for client/daemon version mismatch detection
- **Batch CLI verbs** — `murmuration agents`, `groups`, `events`, `cost` with `--json` and `--filter` flags
- **Daemon RPC client** (`daemon-client.ts`) — Unix socket client for batch verbs with proper timeout cleanup
- **Config system** — `~/.murmuration/config.toml` with leader key, prompt format, keybindings, aliases
- **REPL `:` prefix** — all commands support `:command` syntax (bare verbs as backward-compatible fallback)
- **Leader-key state machine** — `Ctrl-a` + keystroke for fast operator actions (configurable)
- **New REPL commands** — `:agents`, `:groups`, `:events`, `:cost`, `:edit`, `:open`
- **Tab completion** — commands, agent IDs, group IDs, filter values
- **Generated help** — `murmuration help protocol` shows the parity matrix; REPL `:help` shows shipped methods
- **`murmuration config`** — show, edit, or find config path

### Changed

- npm scope renamed from `@murmuration` to `@murmurations-ai`

### Security

- HTTP server binds to `127.0.0.1` only (was all interfaces)
- CORS restricted to `localhost:port` (was wildcard `*`)
- POST body limited to 64KB (was unbounded)
- Socket buffer limited to 1MB per client (was unbounded)
- `:open` uses `execFile` instead of `exec` (prevents command injection)
- `:edit` validates agentId against known list (prevents path traversal)
- Config parse errors logged instead of silently swallowed

[0.2.0]: https://github.com/murmurations-ai/murmurations-harness/compare/v0.1.0...v0.2.0

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
