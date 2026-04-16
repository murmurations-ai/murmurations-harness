# Contributing to the Murmuration Harness

## Developer setup

```bash
# Prerequisites
node --version  # >= 20.0.0
pnpm --version  # >= 9.0.0

# Clone and build
git clone https://github.com/murmurations-ai/murmurations-harness.git
cd murmurations-harness
pnpm install
pnpm build
```

## Development commands

```bash
pnpm build          # Build all packages (tsc, respects project references)
pnpm typecheck      # tsc --noEmit across all packages
pnpm lint           # ESLint with strict-type-checked rules
pnpm lint:fix       # Auto-fix lint issues
pnpm format         # Prettier auto-fix
pnpm format:check   # Prettier check (CI gate)
pnpm test           # Vitest (all packages)
pnpm check          # All of the above — run before pushing
```

Run a single test file:

```bash
npx vitest run packages/core/src/daemon/events.test.ts
```

## Architecture

Read these before writing code:

- **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)** — Architecture layers, GitHub as system of record, structured actions, and **10 Engineering Standards** (fix root causes, events over polling, single state owner, etc.)
- **[docs/LINT-DESIGN-GUIDE.md](./docs/LINT-DESIGN-GUIDE.md)** — TypeScript patterns for the strict config (noUncheckedIndexedAccess, exactOptionalPropertyTypes, etc.)
- **[CLAUDE.md](./CLAUDE.md)** — Quick reference for AI agents working in this repo

## Monorepo structure

8 packages in `packages/`:

| Package                           | What it does                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| `@murmurations-ai/core`           | Daemon, scheduler, executors, governance, runner, identity, cost                   |
| `@murmurations-ai/cli`            | `murmuration` CLI (start, stop, attach, init, etc.)                                |
| `@murmurations-ai/github`         | Typed GitHub client with write-scope enforcement                                   |
| `@murmurations-ai/llm`            | Vercel AI SDK adapter + Langfuse observability (Gemini, Anthropic, OpenAI, Ollama) |
| `@murmurations-ai/mcp`            | MCP tool loader (connects to MCP servers, converts tools for LLM)                  |
| `@murmurations-ai/signals`        | Signal aggregator (GitHub issues, filesystem)                                      |
| `@murmurations-ai/secrets-dotenv` | .env secrets provider                                                              |
| `@murmurations-ai/dashboard-tui`  | Terminal UI dashboard                                                              |

## Pull requests

1. Fork the repo and create a branch from `main`
2. Run `pnpm check` before pushing — CI runs the same checks
3. Write tests for new features (36 test files, 427+ tests)
4. Follow the Engineering Standards in `docs/ARCHITECTURE.md`
5. One PR per concern — don't bundle unrelated changes

## Governance

This project is built by the Engineering Circle of the Emergent Praxis murmuration under Sociocracy 3.0 consent governance. Architectural decisions are recorded as ADRs in [`docs/adr/`](./docs/adr/). Consent rounds happen on GitHub Issues.

## License

MIT — see [LICENSE](./LICENSE).
