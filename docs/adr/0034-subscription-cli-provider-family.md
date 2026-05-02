# ADR-0034 — Subscription-CLI Provider Family

- **Status:** Accepted (retroactive — implementation landed in commit `2bcae1d`)
- **Date:** 2026-05-01
- **Decision-maker(s):** Architecture Agent (#23), TypeScript/Runtime Agent (#24), Source (Nori)
- **Consulted:** Security Agent (#25), DevOps/Release Agent (#26), Performance/Observability Agent (#27)

## Context

With PR #265 wiring tools into convene, the first tooled engineering convene cost $0.0813 — 6.5× the no-tools baseline. At 21 agents × multiple wakes/day × Sonnet 4.6 + tools, projected monthly cost is $300–500 against a bootstrap war chest of $500.

Source already pays for Claude Pro/Max, a Google subscription, and ChatGPT — those calls would be functionally **$0 marginal cost** at the operator if the harness routed through the operator's locally-installed AI CLI. All three vendors ship a non-interactive print-mode CLI:

| CLI              | Non-interactive command | Auto-approve flag                | Structured output      | Subscription auth    |
| ---------------- | ----------------------- | -------------------------------- | ---------------------- | -------------------- |
| Claude Code      | `claude -p "..."`       | `--dangerously-skip-permissions` | `--output-format json` | Pro/Max OAuth        |
| Gemini CLI       | `gemini -p "..."`       | `--yolo`                         | `--output-format json` | Google subscription  |
| OpenAI Codex CLI | `codex exec "..."`      | `--full-auto`                    | `--json`               | ChatGPT subscription |

The hard part is shared: subprocess lifecycle, flag mapping, output parsing, auth detection, cost attribution, typed error mapping. Designing for one CLI then refactoring twice would burn the architecture twice. The directive (EP#684, expanded scope same-day) asked for a **family-shaped** design.

This ADR documents the architecture chosen, the constraints ratified in the engineering operational meeting on 2026-05-01, and the open empirical questions deferred to spike validation.

## Decision

We add a **subscription-CLI provider family** to `packages/llm` with:

1. **One shared subprocess base client** owning lifecycle: spawn, stdin pump, stdout/stderr capture, SIGTERM→SIGKILL grace, AbortSignal propagation, zombie prevention, wall-clock timeout, error mapping to `LLMClientError`.
2. **Three per-CLI adapters** (claude, gemini, codex) implementing a locked `SubprocessLLMAdapter` interface that handles only the CLI-specific concerns: flag building, output parsing, auth checking.
3. **A factory function** `createSubscriptionCliClient({ cli, model, timeoutMs })` that bypasses the existing `ProviderRegistry` path (subprocess output is not a Vercel `LanguageModel`) but returns the same `LLMClient` shape — the daemon does not need to know which factory built it.
4. **Two-field operator config** in role.md/harness.yaml frontmatter:
   ```yaml
   llm:
     provider: subscription-cli
     cli: claude | gemini | codex
     model: claude-sonnet-4-6 # optional
     timeoutMs: 90000 # optional
   ```

### Locked interface (the load-bearing contract)

The directive named the load-bearing adapter contract `CliAdapter`:

```typescript
interface CliAdapter {
  readonly cliName: "claude" | "gemini" | "codex";
  buildFlags(req: LLMRequest): string[];
  parseOutput(raw: string): Result<LLMResponse, ParseError>;
  authCheck(): Promise<Result<AuthStatus, AuthError>>;
}
```

The implementation name is `SubprocessLLMAdapter` because the provider family lives under
`packages/llm/src/providers/subprocess/` and the command/provider identifiers need to be
separate for spawn + cost attribution. This is the same contract with two explicit metadata
fields (`command`, `providerId`) instead of the single directive-level `cliName`.

```typescript
export interface SubprocessLLMAdapter {
  readonly command: string; // "claude" | "gemini" | "codex"
  readonly providerId: string; // for cost attribution + logs

  buildFlags(req: LLMRequest): readonly string[];
  parseOutput(raw: string): Result<LLMResponse, ParseError>;
  authCheck(): Promise<Result<AuthStatus, AuthError>>;
}

export type AuthStatus =
  | { kind: "authenticated"; identity?: string }
  | { kind: "unauthenticated"; message: string }
  | { kind: "unavailable"; message: string };
```

This interface is **locked before adapter work began**. Subsequent adapters (gemini, codex) implement-only — no interface negotiation.

### Ratified constraints (D1–D10 from the 2026-05-01 engineering meeting)

| #       | Constraint                                                                                                   | Rationale                                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| **D1**  | `buildFlags()` MUST NOT contain prompt content. Prompt is delivered via stdin only, argv is array form only. | `ps aux`, audit logs, and shell history would otherwise leak prompts.                                       |
| **D2**  | Three-state auth model: `authenticated` \| `unauthenticated` \| `unavailable`.                               | Distinguishes "CLI missing" (soft skip with actionable message) from "logged out" (hard wake-time failure). |
| **D3**  | Token counts MUST NEVER silently zero. Missing counts → `ParseError { code: 'TOKEN_COUNT_MISSING' }`.        | Silent zeros disable budget enforcement. Same incident class as #635.                                       |
| **D4**  | Wall-clock subprocess timeout, default 90s, configurable via `llm.timeoutMs`.                                | Subprocesses can hang indefinitely; the daemon must reclaim the wake slot.                                  |
| **D5**  | SIGTERM first, then SIGKILL after 5s grace. Wait for child exit.                                             | Avoid zombies; respect cleanup hooks where possible.                                                        |
| **D6**  | `SecretsProvider.get()` MUST be used for any credential value read. No `process.env` fallback.               | ADR-0010 compliance; `scrubLogRecord` coverage.                                                             |
| **D7**  | No silent fallback from API to CLI or vice-versa. CLI failure → typed error, propagate.                      | Operators must see real failures; silent fallback masks subscription/quota issues.                          |
| **D8**  | Operators without an AI CLI installed MUST NOT be blocked from running the harness. CI included.             | Soft `unavailable` skip with message; agents using `provider: subscription-cli` fail closed.                |
| **D9**  | `costUsd: 0` records with `provider: <cli>-cli` and real `tokens.{prompt,completion}` populated.             | Subscription wakes are $0 marginal but real tokens; observability must reflect that.                        |
| **D10** | `LLMClient` interface unchanged. Subprocess provider is interchangeable from the daemon's perspective.       | Composition root stays thin; daemon doesn't branch on provider type.                                        |

### Package layout

Directive draft layout:

```
packages/llm/src/providers/subprocess/
  index.ts
  base-client.ts
  adapters/claude.ts
  adapters/gemini.ts  (stub)
  adapters/codex.ts   (stub)
  auth.ts
  cost.ts
  errors.ts
```

Implemented layout:

```
packages/llm/src/providers/subprocess/
  index.ts               — createSubscriptionCliClient(), public exports
  base-client.ts         — SubprocessAdapter (shared lifecycle)
  types.ts               — SubprocessLLMAdapter, AuthStatus, error union
  adapters/
    claude.ts            — ClaudeCliAdapter (production)
    gemini.ts            — GeminiCliAdapter (production)
    codex.ts             — CodexCliAdapter (production)
  subprocess.test.ts
```

The implementation folded `auth.ts`, `cost.ts`, and `errors.ts` into `base-client.ts` and
`types.ts`; no separate topology boundary emerged there. The gemini/codex files started as
stubs and were filled in by the follow-up adapter buildout.

## Alternatives considered

### Option A — One shared subprocess provider with per-CLI adapters (CHOSEN)

The shared base client owns subprocess discipline; three thin adapters handle flag/output/auth specifics.

**Pros:** One subprocess lifecycle implementation. One error-mapping pass. One timeout policy. Adding a fourth CLI is copy-the-template. Reviewers focus on the lifecycle once.

**Cons:** Risk of leaky abstraction if the three CLIs diverge sharply on tool-call protocol or JSON shape (BU-1 captures this risk).

### Option B — Three independent providers (rejected)

`packages/llm/providers/claude-cli`, `packages/llm/providers/gemini-cli`, `packages/llm/providers/codex-cli`, each with its own subprocess wrapper.

**Pros:** Each provider can specialize fully. No shared-abstraction risk.

**Cons:** Three subprocess lifecycle implementations to maintain. Three timeout policies. Three error-mapping surfaces. Bugs in lifecycle logic must be fixed three times. The hard part is the lifecycle, not the flag mapping — duplicating the hard part is wrong.

### Option C — MCP-server bridge wrapping any CLI (rejected for v0.1)

Run an MCP server that exposes any of the three CLIs as MCP tools. The harness consumes them as MCP, not as a subprocess provider.

**Pros:** Single integration surface (MCP). Could expose richer tool ecosystems. Future-friendly.

**Cons:** Adds an MCP-server hop with its own lifecycle, auth, and process concerns. Latency adds up. Solves a problem (ecosystem exposure) we don't have. Operator install complexity rises (need MCP server _and_ CLI).

We may revisit MCP-bridging in a future ADR if the spike reveals subprocess parsing is unbearable; for v0.1, direct subprocess is the path.

## Consequences

### Easier

- Operators with Claude Pro/Max can run EP locally at $0 marginal LLM cost.
- Adding gemini-cli or codex-cli is implement-only against the locked adapter interface; no architecture work.
- Cost attribution is honest: `costUsd: 0` plus real token counts let operators see "what this would have cost on API."
- The harness now supports a fifth provider _family_ (subscription-CLI) alongside the four Vercel-AI-SDK providers, expanding operator portability.

### Harder

- Subprocess failure modes are richer than HTTP — spawn errors, stdin/stdout deadlocks, zombie processes, signal handling. The base client absorbs this complexity, but reviewers must understand it.
- Subscription rate limits are lower than API limits. 21 agents through one subscription requires throttling design — deferred to a follow-up ADR pending real measurement.
- CI environments without subscription auth must fail closed with a clear message (`AuthStatus.kind: 'unavailable'`) — this requires operator role.md to declare the dependency explicitly.

### Reversibility

Low cost. Each CLI adapter is ~50–250 LoC and self-contained. The base client is ~330 LoC. Removing the family means deleting `packages/llm/src/providers/subprocess/` and reverting the boot.ts factory branch. No persistent state, no schema migration.

## Open items (deferred to spike + follow-up ADRs)

### BU-1: Tool-use blocks in CLI JSON output — RESOLVED

**Question:** Do the three CLIs emit tool-use blocks compatibly?

**Resolution:** They do not, but each format is parseable to the common `toolCalls` shape:

- **Claude**: `tool_use` blocks inside `assistant.content[]` events with `name` + `input`
- **Codex**: `item.completed` events with `item.type: "function_call"`, `name`, and `arguments` (string-encoded JSON)
- **Gemini**: only aggregate counts (`stats.tools.totalCalls`, `stats.tools.byName`); per-call `args` are not emitted in `--output-format json`. We surface a placeholder entry per tool name so daemon accounting reflects activity, with empty `args`.

The shared-base abstraction holds: `parseOutput` returns `LLMResponse.toolCalls` uniformly. Gemini's lossy detail is a known limitation, not a contract violation.

### BU-2: Auth failure mode per CLI — RESOLVED

**Question:** What does each CLI do when not authenticated?

**Resolution:** All three return non-zero exit with stderr describing the auth state. The base client's `looksLikeAuthFailure` heuristic on stderr is sufficient; per-CLI specialization isn't needed at v0.1. `authCheck()` is a boot-time presence check (`<cli> --version`) for all three — a real probe would burn an LLM call. Subscription state surfaces at wake time via the stderr scan and produces `LLMUnauthorizedError`.

### Capability matrix

| Feature                    | claude-cli                          | gemini-cli                              | codex-cli                                       |
| -------------------------- | ----------------------------------- | --------------------------------------- | ----------------------------------------------- |
| Non-interactive print mode | ✅ `claude -p`                      | ✅ `gemini` (stdin)                     | ✅ `codex exec`                                 |
| JSON structured output     | ✅ `--output-format json` (JSONL)   | ✅ `--output-format json` (single JSON) | ✅ `--json` (JSONL)                             |
| Auto-approve flag          | ✅ `--dangerously-skip-permissions` | ✅ `--yolo`                             | ✅ `--dangerously-bypass-approvals-and-sandbox` |
| Model pinning              | ✅ `--model <id>`                   | ✅ `--model <id>`                       | ✅ `--model <id>`                               |
| Tool call detail in output | ✅ name + args                      | ⚠️ aggregate counts only                | ✅ name + args                                  |
| Token counts in output     | ✅ `usage`                          | ✅ `stats.models[*].tokens`             | ✅ `turn.completed.usage`                       |
| Cache token reporting      | ✅ `cache_read_input_tokens` etc.   | ✅ `tokens.cached`                      | ✅ `cached_input_tokens`                        |
| Multi-model routing        | n/a                                 | ✅ flash-lite + flash (summed)          | n/a                                             |
| Auth failure detection     | stderr scan at wake                 | stderr scan at wake                     | stderr scan at wake                             |

## Related

- **Source directive:** [xeeban/emergent-praxis#684](https://github.com/xeeban/emergent-praxis/issues/684)
- **Action item:** [xeeban/emergent-praxis#718](https://github.com/xeeban/emergent-praxis/issues/718)
- **Cost trigger:** [murmurations-ai/murmurations-harness#265](https://github.com/murmurations-ai/murmurations-harness/issues/265) — first tooled convene at $0.0813 (6.5× baseline)
- **Complementary mitigation:** [murmurations-ai/murmurations-harness#266](https://github.com/murmurations-ai/murmurations-harness/issues/266) — facilitator-only tool scoping
- **Implementation:** commit `2bcae1d` — `feat(llm): subscription-CLI provider family (claude/gemini/codex) — ADR-0034`
- **Daemon wiring:** commit `1a1817d` — forward `cli` + `timeoutMs` from llm frontmatter to RegisteredAgent
- **Foundational ADRs:** ADR-0014 (LLM client), ADR-0017 (write-scope), ADR-0020 (Vercel AI SDK), ADR-0025 (pluggable providers)
