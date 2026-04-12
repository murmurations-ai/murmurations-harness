# CLAUDE.md

Instructions for Claude Code when working in the Murmuration Harness repository.

## What This Repo Is

The Murmuration Harness is a **generic, open-source TypeScript agent coordination runtime**. It runs any number of AI agents in a "murmuration" (coordinated flock). It is:

- **Generic** — works for any murmuration, not just Emergent Praxis. Zero EP-specific code in library packages.
- **GitHub-native** — GitHub is the system of record for all collaborative state. Local disk is runtime only.
- **Governance-pluggable** — supports Self-Organizing (S3), Chain of Command, Meritocratic, Consensus, Parliamentary. The plugin provides language/state machine/decision protocol.
- **Real-work-oriented** — every action must produce artifacts that change the state of the world. Meetings that only produce prose are governance theater.

## Before Every Commit

**Always run the full CI check locally before committing:**

```sh
pnpm run build && pnpm run typecheck && pnpm run lint && pnpm run format:check && pnpm run test
```

If format fails, run `pnpm run format` to auto-fix, then re-check.

**After every push, verify CI passes.** Use `gh run watch` to confirm. Never assume a push is clean without checking.

## Lint and TypeScript Rules

**Read `docs/LINT-DESIGN-GUIDE.md` before writing any TypeScript.** It documents every recurring lint failure and the idiomatic fix. The top 5:

1. **Array index in template literal** — extract to a `const` with `?? ""` fallback
2. **Final `if` on exhausted discriminated union** — drop the `if`, let narrowing carry
3. **Optional chain on non-nullable parent** — use plain `.` not `?.`
4. **`async` mock with no `await`** — drop `async`, return `Promise.resolve()`
5. **Missing `../pkg` project reference in tsconfig** — #1 cause of cascading errors

The harness uses `typescript-eslint` strict mode with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and `strictNullChecks`. Code that compiles locally may still fail CI lint.

## Architecture

Read these in order for context:

1. `docs/ARCHITECTURE.md` — core beliefs, structured actions, "Did Work" contracts
2. `docs/EXECUTION-PLAN.md` — what's done and what's next
3. `docs/LINT-DESIGN-GUIDE.md` — how to write code that passes CI

## Key Conventions

### Terminology

- **"group"** in code (not "circle", "department", "committee")
- The governance plugin provides display terms via `GovernanceTerminology`
- "circle" only appears in the S3 governance plugin

### Generic Harness

- Zero EP-specific references in `packages/`
- EP-specific content belongs only in `examples/` and operator repos
- Governance is pluggable — S3 is the default example, not a requirement

### GitHub as System of Record

- Everything collaborative lives in GitHub (issues, labels, comments, committed files)
- Local `.murmuration/` is for runtime state only
- Meetings produce structured actions executed against GitHub, not just prose

### Agent Wake Lifecycle

- State machine: registered → idle → waking → running → completed/failed/timed-out → idle
- Every wake tracks artifact count and action item coverage
- Idle wakes (no artifacts) are tracked separately from productive wakes
- Circuit breaker skips agents after 3 consecutive failures

### Testing

- 289+ tests across 20 test files
- Every new feature needs tests
- When `AgentResult` or `SignalBundle` gains a field, update ALL test fixtures

### Secrets

- **NEVER print .env values** in tool output
- Use `cut -d= -f1` for key names only
