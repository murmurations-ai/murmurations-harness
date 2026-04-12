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
@murmuration/core       — daemon, executor, scheduler, identity, governance, groups, agents, cost, secrets
@murmuration/llm        — 4-provider LLM client (Gemini, Anthropic, OpenAI, Ollama) + pricing
@murmuration/github     — GitHub REST/GraphQL client with write-scope enforcement (ADR-0017)
@murmuration/signals    — signal aggregator (GitHub issues, private notes, inbox messages)
@murmuration/secrets-dotenv — .env secrets provider
@murmuration/cli        — CLI commands (start, init, directive, group-wake, backlog, dashboard)
@murmuration/dashboard-tui — TUI dashboard (pi-tui)
```

### Core Package Modules

The `@murmuration/core` package has these submodules (each re-exported from `packages/core/src/index.ts`):

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
murmuration start --root <path> [--agent <id>] [--now] [--once] [--dry-run] [--governance <path>]
murmuration group-wake --root <path> --group <id> [--governance] [--directive "msg"]
murmuration directive --root <path> --agent <id> "message"
murmuration backlog --root <path> --group <id> [--repo owner/repo] [--refresh]
murmuration init [dir]
```

`--now` triggers an immediate wake (overrides cron schedule, implies `--once`). No identity file edits needed.

## Secrets

**NEVER print .env values** in tool output. Use `cut -d= -f1` for key names only.
