# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repo Is

The Murmuration Harness is a generic, open-source TypeScript agent coordination runtime. It runs any number of AI agents in a "murmuration" with pluggable governance models (S3, Chain of Command, Meritocratic, Consensus, Parliamentary). GitHub is the system of record for all collaborative state. Local disk is runtime only.

**Non-negotiable:** Zero Emergent Praxis-specific references in `packages/`. EP-specific content belongs only in `examples/` and operator repos.

## Build / Test / Lint Commands

```sh
pnpm run build          # build all packages (tsc --build, respects project references)
pnpm run typecheck      # tsc --noEmit across all packages
pnpm run lint           # eslint with strict-type-checked rules
pnpm run lint:fix       # auto-fix lint issues
pnpm run format         # prettier auto-fix
pnpm run format:check   # prettier check (CI gate)
pnpm run test           # vitest run (all packages)
pnpm run check          # typecheck + lint + format:check + test (full CI locally)
```

**Run a single test file:**

```sh
npx vitest run packages/core/src/groups/groups.test.ts
```

**Run tests matching a name pattern:**

```sh
npx vitest run -t "parseMeetingActions"
```

**Before every commit, run:**

```sh
pnpm run build && pnpm run typecheck && pnpm run lint && pnpm run format:check && pnpm run test
```

**After every push, watch CI:** `gh run watch <id> --repo murmurations-ai/murmurations-harness`

## TypeScript Strictness

The tsconfig enables `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and full `strict`. This is stricter than most projects. **Read `docs/LINT-DESIGN-GUIDE.md` before writing any TypeScript.** The top recurring failures:

1. **Array index in template literal** — extract to a `const` with `?? ""` fallback (not `!`)
2. **Final `if` on exhausted discriminated union** — drop the guard, let narrowing carry
3. **Optional chain `?.` on non-nullable parent** — use plain `.`
4. **`async` mock with no `await`** — drop `async`, return `Promise.resolve()`
5. **Missing `../pkg` project reference in tsconfig.json** — causes 50+ cascading errors
6. **`exactOptionalPropertyTypes`** — can't pass `undefined` to optional fields; use conditional spread
7. **`readonly` arrays** — `readonly T[]` is not assignable to `T[]`; match the declared type

## Monorepo Architecture

pnpm workspace with 7 packages. Build order matters (project references).

```
@murmurations-ai/core       — daemon, executor, scheduler, identity, governance, groups, agents, cost, secrets
@murmurations-ai/llm        — LLM client: 4 API providers (Gemini, Anthropic, OpenAI, Ollama) via Vercel AI SDK + 3 subscription-CLI providers (claude-cli, codex-cli, gemini-cli) via subprocess (ADR-0034) + pricing catalog with shadow API cost
@murmurations-ai/github     — GitHub REST/GraphQL client with write-scope enforcement (ADR-0017)
@murmurations-ai/signals    — signal aggregator (GitHub issues, private notes, inbox messages)
@murmurations-ai/secrets-dotenv — .env secrets provider
@murmurations-ai/cli        — CLI commands (start, init, directive, group-wake, backlog, dashboard)
@murmurations-ai/dashboard-tui — TUI dashboard (pi-tui)
```

### Core Package Modules

The `@murmurations-ai/core` package has these submodules (each re-exported from `packages/core/src/index.ts`):

- **execution/** — `AgentExecutor` interface, `InProcessExecutor`, `SubprocessExecutor`, `DispatchExecutor`, branded types (`AgentId`, `GroupId`, `WakeId`), `WakeAction`/`WakeActionReceipt`, `validateWake()`, `parseWakeActions()`
- **daemon/** — `Daemon` class wiring scheduler + executor + governance + signals. Post-wake action execution hook, "Did Work" tracking, circuit breaker (3 failures), governance cron scheduling
- **scheduler/** — `TimerScheduler` with cron, interval, delay-once triggers
- **identity/** — `IdentityLoader` reads murmuration soul + agent soul + role.md + group contexts. Parses role.md YAML frontmatter via Zod
- **governance/** — `GovernancePlugin` interface (model-agnostic), `GovernanceStateStore` (state machine + persistence), `GovernanceGitHubSync`, `GovernanceTerminology`
- **groups/** — `runGroupWake()` (group meeting runner), `MeetingAction`/`ActionReceipt`, `parseMeetingActions()` with truncation recovery, `GovernanceMeetingPrompts` interface
- **agents/** — `AgentStateStore` (lifecycle state machine, artifact tracking, idle-wake counting)
- **signals/** — signal aggregator types, `SignalBundle.actionItems` partitioning
- **cost/** — `WakeCostBuilder`, `WakeCostRecord`, pricing resolution
- **secrets/** — `SecretValue` (branded, never serializes), `scrubLogRecord()` (recursive)

### Key Data Flow

```
Identity files → IdentityLoader → IdentityChain → AgentSpawnContext
GitHub issues  → SignalAggregator → SignalBundle (signals + actionItems)
Cron/interval  → Scheduler → Daemon.#handleWake → Executor.spawn → AgentResult
AgentResult    → validateWake → recordWakeOutcome (artifacts, idle tracking)
AgentResult    → onWakeActions callback → GitHub mutations (labels, issues, comments)
AgentResult    → GovernancePlugin.onEventsEmitted → governance state transitions
```

### Meeting → Work Pipeline

````
Group meeting → facilitator returns ```actions JSON block
  → parseMeetingActions() extracts structured actions
  → executeActions() runs them against GitHub (labels, issues, comments, closures)
  → action items created as GitHub issues with assigned:<agentId> labels
  → agents see action items in SignalBundle.actionItems on next wake
  → agents act on them → close issues when done
````

## Terminology

- **"group"** in all code — not "circle", "department", or "committee"
- The governance plugin provides display terms via `GovernanceTerminology` (e.g. S3 plugin sets `group: "circle"`)
- `WakeMode`: `"individual"` | `"group-member"` | `"group-facilitator"`

## Governance Model Independence

The harness core must not contain S3-specific terms (consent, objection, tension, ratify). These belong in the governance plugin:

- `GovernanceMeetingPrompts` — plugin provides member/facilitator prompt templates and position parsing
- `GovernanceTerminology` — plugin provides display terms
- `GovernanceStateGraph` — plugin defines states and transitions (open strings, not enums)
- Default prompts are generic ("state your position and reasoning")

## CLI Commands

```sh
# Daemon lifecycle
murmuration start --root <path> [--agent <id>] [--now] [--once] [--dry-run] [--governance <path>] [--log-level debug]
murmuration stop [--root|--name]
murmuration restart [--root|--name]
murmuration status [--root|--name]

# Session management
murmuration attach <name>             # Interactive REPL with :commands and leader keys
murmuration list                      # Show all registered murmurations
murmuration register <name> --root <path>
murmuration config [edit|path]

# Queries (require running daemon)
murmuration agents [--root|--name] [--json] [--filter running|idle|failed]
murmuration groups [--root|--name] [--json]
murmuration events [--root|--name] [--json]
murmuration cost   [--root|--name] [--json]

# Actions
murmuration directive --root <path> --agent <id> "message"
murmuration convene --root <path> --group <id> [--governance] [--directive "msg"]
murmuration backlog --root <path> --group <id> [--repo owner/repo] [--refresh]
murmuration init [dir]

# Help
murmuration help protocol             # Show daemon protocol + parity matrix
```

`--now` triggers an immediate wake (overrides cron schedule, implies `--once`). All commands accept `--name <name>` as an alias for `--root <path>` when the murmuration is registered.

## Secrets

**NEVER print .env values** in tool output. Use `cut -d= -f1` for key names only.

## Engineering Standards

Read `docs/ARCHITECTURE.md § Engineering Standards` before writing code. Key rules:

1. **Fix root causes, not symptoms** — no client-side workarounds for server-side gaps
2. **Every async operation returns a typed result** — never `void` for meaningful work
3. **Single owner for mutable state** — one writer per JSONL/JSON state file
4. **Events over polling** — use `DaemonEventBus` + SSE, not `setInterval`
5. **No inline HTML/JS in TypeScript** — dashboard is a static file, not a template literal
6. **Typed errors, not process.exit()** — only `bin.ts` may exit the process
7. **Track what you spawn** — attach exit handlers before detaching child processes
8. **Composition root stays thin** — `boot.ts` wires; `DaemonCommandExecutor` handles
9. **Silent error swallowing is a bug** — log with context or propagate
10. **Status response is a typed contract** — define interfaces, not ad-hoc objects

Read `docs/LINT-DESIGN-GUIDE.md` for TypeScript-specific patterns (noUncheckedIndexedAccess, exactOptionalPropertyTypes, etc.).
