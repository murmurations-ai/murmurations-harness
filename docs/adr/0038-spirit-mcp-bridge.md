# ADR-0038 — Spirit MCP Bridge for Subscription-CLI Tool Calls

- **Status:** Accepted (with carry-forward conditions — see Acceptance below; merge-blocker simplifications recorded 2026-05-01 19:58 PDT)
- **Date:** 2026-05-01
- **Decision-maker(s):** Source (Nori), Engineering Circle (consent round on EP #734, 2026-05-01)
- **Driver:** Spirit must support `provider: subscription-cli` end-to-end (operator request, 2026-05-01) including its 9 harness-internal tools (status, agents, groups, events, read_file, list_dir, load_skill, wake, directive).
- **Related:** ADR-0034 (subscription-cli provider family), ADR-0036 (permission mode), ADR-0037 (binary integrity), ADR-0039 (local executable authority), ADR-0040 (wake event stream).

## Acceptance

Engineering circle consent round closed 2026-05-01 with unanimous consent (6/6 specialists positioned: engineering-lead #22, architecture #23, security #25, typescript-runtime #24, devops-release #26, performance-observability #27). Full positions: [EP #734](https://github.com/xeeban/emergent-praxis/issues/734).

Carry-forward conditions split into merge-blockers and follow-ups.

**Merge-blockers (must land in the subscription-cli merge PR):**

- **CF-A** — `client.complete()` request as discriminated union by mode. Replace `tools?: ToolDefinition[]; maxSteps?: number` runtime-branched flags with `{ mode: "api-key" | "subscription-cli" }` discriminant so the wrong call doesn't compile (typescript-runtime #24).
- **CF-C** — Spirit boot self-test that constructs both transports against `buildSpiritTools()` and refuses to attach if either fails. Pair with tightening `registerSpiritTool` over `z.ZodObject<T>` (CF-D) to turn R6 into a compile error.
- **CF-D** — `registerSpiritTool` parameterized over `z.ZodObject<T>` rather than `z.ZodTypeAny` (typescript-runtime #24).

**Follow-ups (filed as harness issues; do not block merge):**

- **CF-B** — Spirit hard-crash → no orphan `mcp-bin.js` integration test. Devops-release #26 proposes a Spirit-side reaper as the implementation: boot-time scan for `mcp-bin.js` processes whose parent is PID 1 (init-reparented) and whose `MURMURATION_ROOT` matches the current rootDir, with `lstart` older than the daemon's own.
- **CF-E** — Subtractive env policy for `mcp-bin.js`. Allowlist `MURMURATION_ROOT`, `PATH`, locale vars only. No provider API keys leak into the spawned MCP subprocess. Cross-confirmed by security #25 + typescript-runtime #24.
- **CF-F** — Ephemeral temp MCP config. Write `.murmuration/spirit-mcp.json` per-attach with `mkstemp`-style randomness; delete on Spirit detach. Source: security #25.
- **CI build-verify** — Build script must produce `dist/spirit/mcp-bin.js` next to `client.js`; CI assertion to prevent silent drift. Source: devops-release #26.
- **Telemetry deltas** — Add `LLMResponse.equivalentApiCostUsd?`, `ParseError.code?`, and `llm.spawnMs` / `llm.timeoutMs` / `llm.cliPath` to the cost/log surfaces. Source: performance-observability #27.

**Empirical validation (closes R1):** Performance-observability #27 measured CLI spawn p50/p95 over 5 runs:

| CLI    | p50      | p95       |
| ------ | -------- | --------- |
| Claude | 59.5 ms  | 684.4 ms  |
| Codex  | 77.2 ms  | 96.6 ms   |
| Gemini | 928.0 ms | 1702.2 ms |

R1's intuitive "50–150 ms" estimate was right at p50 for claude/codex; p95 for claude exceeds it materially. Gemini's startup cost alone (~1 s p50) is operator-noticeable and relevant when Phase B brings gemini MCP support.

**Source's verdict:** Treat ADR-0038 as Accepted; track CF-A/CF-C/CF-D as merge-blockers; file CF-B/CF-E/CF-F + CI/telemetry as separate harness issues.

### Merge-blocker simplifications (2026-05-01)

After the consent round, a typescript-runtime-agent wake produced ready-to-apply patches for CF-A/CF-C/CF-D. CF-D's patch was applied and reverted — it globally narrowed `parameters: unknown` → `z.ZodObject<...>`, which broke `packages/mcp/src/tool-loader.ts:128` where MCP-loaded external tools have `parameters: jsonSchema(...)` returning AI SDK `Schema<unknown>`. A three-agent independent review (architecture, security, simplicity) recommended simpler designs. Adopted:

- **CF-A** — DROPPED the discriminated union. Replaced with a runtime fail-fast in `SubprocessAdapter.complete()`: subscription-CLI rejects per-request `tools` or `maxSteps > 1` with a typed `LLMValidationError`. Reviewers noted that "api-key vs subscription-cli" is the wrong discriminant axis (the durable distinction is tool-loop ownership, already captured by `LLMClientCapabilities.supportsToolUse`) and that the 6-file refactor with mode threading replicated what one runtime guard already does. ~5 lines + 4 tests instead of ~150 LOC.

- **CF-D** — INLINED the type narrow at the consumer (`packages/cli/src/spirit/tools.ts`) instead of exporting a new public `ZodObjectToolDefinition`. `buildSpiritTools()` returns `readonly SpiritTool[]` where `SpiritTool extends ToolDefinition` with narrowed `parameters`. `mcp-server.ts` accepts the narrow type and accesses `.shape` directly; the runtime `instanceof` guard is removed for Spirit's path. MCP-loaded and extension tools keep base `ToolDefinition` with `parameters: unknown`. ~15 LOC.

- **CF-C** — DROPPED. With CF-D's narrow in place, the only remaining bypass paths (`as` casts, extension-registered tools) don't apply to Spirit's hand-authored 9 tools. The existing runtime guard in `runSpiritMcpServer` (now removed for Spirit's path because the type guarantees it) was the defense-in-depth mechanism; CF-C was duplicative.

Same operator-visible failure modes are closed (silent tool drop on subscription-cli; opaque schema-drift crashes for Spirit). ~30 LOC total instead of ~250 LOC. Reviewers' reports archived in commit `0d9c93a`. Implementation: commits `dfd120b` (Phase A) → `0d9c93a` (CF-A + CF-D simplified).

Follow-ups filed:

- harness#286 — Tool description sanitization in `tool-loader.ts` (security: external MCP tool descriptions are passed unsanitized to the model — prompt-injection vector)
- harness#287 — Bind tool-loop ownership on `LLMClient` construction (phantom type / branded property; cost-attribution correctness)
- harness#288 — Consolidate `packages/core/src/extensions/types.ts:9` duplicate `ToolDefinition` with the canonical one in `@murmurations-ai/llm`
- harness#289 — `ToolInputSchema` unifying abstraction (would unify Zod ↔ MCP ↔ Vercel translations; deferred — surfaced as latent design)

## Context

The Spirit of the Murmuration is the operator-facing REPL session that lets a human converse with the murmuration via `murmuration attach`. It calls `client.complete()` with a system prompt, conversation history, and a Vercel-AI-SDK `tools` array containing 9 ToolDefinitions. The Vercel SDK runs the tool loop client-side: model emits `tool_use` block → SDK invokes the matching ToolDefinition's `execute()` → result fed back to model → repeat until final text or `maxSteps`.

When `harness.llm.provider: subscription-cli` (ADR-0034), `client.complete()` is built by `createSubscriptionCliClient`, not `createLLMClient`. The subscription-cli client wraps a subprocess (`claude -p`, `codex exec`, `gemini -p`) and delegates the entire turn — _including the tool loop_ — to the operator's local CLI. The CLI runs its own tool surface (file edits, shell, web fetch, etc.); it has no native way to honor the harness's Vercel `ToolDefinition` objects passed in `LLMRequest.tools`. They are silently dropped.

Result: with subscription-cli active today, Spirit can converse but cannot call any of its 9 tools. Asking "what's our status?" gets a generic answer instead of a `daemonRpc("agents.list")` round-trip. The harness's whole reason for being a harness — coordinating murmuration state — is unreachable from the Spirit prompt.

We need a transport that bridges harness-defined tools into the subscription CLI's own tool loop, without re-implementing the tool logic, without coupling Spirit to a specific CLI vendor, and without burning a second LLM provider for the bridging step.

## Decision (proposed)

We host Spirit's tool surface as a **local MCP server** spawned by Spirit at session-init time. The subscription CLI is configured (via its native `--mcp-config` / `-c mcp_servers.*` / `--allowed-mcp-server-names` flags) to load that MCP server. Tool calls from the model now flow:

```
model → CLI tool loop → MCP client (in CLI) → MCP server (Spirit subprocess)
      → daemonRpc to Murmuration daemon socket → ToolResult JSON → MCP response
      → CLI tool loop continues → final assistant text → Spirit REPL
```

Concrete pieces:

### 1. `packages/cli/src/spirit/mcp-server.ts` — server module

Hosts all 9 tools from `buildSpiritTools()` as MCP-callable tools over stdio.

- Reuses `buildSpiritTools()` verbatim. Same code path, same path-safety rules (rootDir-relative reads, denylist of `.env`/`.git`), same daemon-RPC contract. The MCP server is a transport adapter, not a logic re-implementation.
- Each tool's Zod `parameters` schema is unwrapped to its `.shape` (raw shape) and registered as `inputSchema` on the MCP `registerTool` call. Since all current Spirit tools use `z.object(...)` at the top level, this is mechanical; non-object schemas would throw at startup loudly.
- Each MCP tool invocation opens a fresh daemon-socket RPC (the existing `daemonRpc` helper is single-shot, 5s timeout, destroy-on-settle). No connection pooling — daemon RPC is short-call by design.
- Transport is `StdioServerTransport`. `MURMURATION_ROOT` env var is the only configuration the server reads.

### 2. `packages/cli/src/spirit/mcp-bin.ts` — bin entry

Standalone Node entry point spawned by the subscription CLI. Reads `MURMURATION_ROOT` from env, calls `runSpiritMcpServer()`, exits non-zero on missing env or server crash. **Logs only to stderr** because stdio is the MCP transport.

### 3. MCP config file

At Spirit init time (when `provider: subscription-cli` and `cli: claude`), Spirit writes `<rootDir>/.murmuration/spirit-mcp.json`:

```json
{
  "mcpServers": {
    "murmuration-spirit": {
      "command": "node",
      "args": ["<absolute-path-to-mcp-bin.js>"],
      "env": { "MURMURATION_ROOT": "<rootDir>" }
    }
  }
}
```

The absolute path is computed via `dirname(fileURLToPath(import.meta.url))` so the bin lives next to the compiled `client.js` regardless of how the CLI was installed (global, npx, monorepo dev).

### 4. CLI flag wiring

| CLI    | Mechanism                                                                        | Phase   |
| ------ | -------------------------------------------------------------------------------- | ------- |
| claude | `--mcp-config <path>`                                                            | A (now) |
| codex  | `-c mcp_servers.murmuration-spirit.command=...` (per-key overrides)              | B       |
| gemini | `--allowed-mcp-server-names murmuration-spirit` + persistent settings.json entry | B       |

`ClaudeCliAdapter` accepts an optional `mcpConfigPath` via `ClaudeCliAdapterConfig`; when set, `buildFlags()` emits `--mcp-config <path>`. `SubscriptionCliClientConfig` plumbs `mcpConfigPath` through the factory. Codex and Gemini adapters are unchanged in Phase A — their subscription-cli Spirit sessions converse but cannot invoke tools, with a banner explaining the limitation.

### 5. Spirit init branch

`initSpiritSession()` branches on `harness.llm.provider`:

- `subscription-cli` + `cli: claude` → write MCP config, build subscription-cli client with `mcpConfigPath`, **drop** the Vercel `tools` array from `client.complete()` calls (CLI handles via MCP).
- `subscription-cli` + `cli: codex|gemini` → build subscription-cli client without `mcpConfigPath`, drop `tools`, surface a one-line banner in the REPL: "tools unavailable on this CLI — Phase B".
- API providers (anthropic / gemini / openai / ollama) → existing path unchanged: API key resolution, `createLLMClient`, Vercel-managed tool loop.

### 6. Default model when no API keys

If the operator runs `murmuration init` without API keys but has a subscription CLI on PATH (already detected by `init`'s auto-detect), `harness.yaml` is written with `provider: subscription-cli` and the matching `cli`. Spirit then defaults to that route at attach time — no manual config.

## Consequences

**Easier:**

- Spirit gets full tool access through any subscription CLI that supports MCP — which all three majors now do.
- Single source of truth for tool implementations: `tools.ts` is consumed by both API and MCP paths. No drift.
- Adding a 10th Spirit tool means writing it once; both transports pick it up automatically.
- $0 marginal LLM cost for Spirit when an operator has a Claude Pro/Max subscription, even when Spirit is making tool-heavy "what's the murmuration doing?" queries.
- The MCP server is reusable. A future agent-side MCP route (per-agent `provider: subscription-cli` wakes) can spawn the same `mcp-bin.js` with a different rootDir — no fork.

**Harder:**

- Per-turn process tax: ~50–150ms to spawn `node mcp-bin.js` and complete the MCP handshake. Mitigated because the CLI keeps the MCP server alive across tool calls within a single `claude -p` invocation; the cost is per-attach, not per-tool. We MUST verify this empirically before declaring victory — see Risks.
- Two subprocesses (CLI + MCP server) per Spirit attach. More moving parts, more potential for orphan processes if Spirit crashes hard. Mitigation: parent Spirit must register exit handlers that kill both children (engineering standard #7: "track what you spawn").
- Tool-call observability degrades. With Vercel SDK, we see `result.value.toolCalls` in `LLMResponse` and count them for budget enforcement. With MCP-via-CLI, the tool calls happen inside the CLI's loop and may or may not surface in the CLI's JSON output (claude's `--output-format json` includes `tool_use` blocks per ADR-0034 BU-1, but counts only the final-assistant message; multi-step tool-use details are partial). Truncation detection (`maxSteps`) becomes a property of the CLI, not the harness.
- Permission posture inherited from ADR-0036. The MCP-spawned subprocess is a sibling of the subscription CLI subprocess; both run with the operator's permissions. The CLI's permission flag (`--dangerously-skip-permissions` / `--yolo` / `--dangerously-bypass-approvals-and-sandbox`) governs the CLI's own tool surface, not ours. But the MCP server runs `daemonRpc` which can mutate murmuration state — meaning an operator who sets `permissionMode: trusted` and then connects an untrusted CLI to a hostile MCP server _not_ spawned by Spirit could amplify damage. Counter-measure: the MCP config we write lists exactly one server (`murmuration-spirit`) and uses an absolute path under our `dist/` — but the CLI may load other MCP servers from its own user config. We need to document this clearly in the operator guide and consider hash-pinning the MCP config (ADR-0037 layered approach).

**Reversibility:** Medium. If the bridge proves unworkable, we can fall back to "no tools when subscription-cli active" (the codex/gemini Phase A behavior generalized) without rolling back ADR-0034. But operators who built workflows around tool-equipped subscription-cli Spirit would feel it.

## Alternatives considered

### A. Re-implement tools as native CLI tools per vendor

Build a claude plugin, a gemini extension, a codex tool definition. Reach maximum integration depth per CLI.

Rejected: 3× the work, 3× the maintenance, and each CLI's plugin format is its own moving target. MCP exists exactly to avoid this trifurcation.

### B. Drop tools entirely when subscription-cli is active

Spirit becomes a chat-only REPL on subscription-cli. Operator explicitly opts in to API providers if they want tool-equipped Spirit.

Rejected as the long-term answer (it's the Phase A fallback for codex/gemini). This forces operators to choose between subscription billing and tool access for the murmuration management surface that motivated subscription-cli in the first place. It's the current failure mode we're trying to fix.

### C. Run a second LLM (API-backed) for tool calls; subscription CLI for prose

Two model contexts per turn: a small API model handles tool dispatch + state synthesis, a subscription CLI generates the final response.

Rejected: defeats the cost goal, duplicates conversation context, and introduces sync-failure modes (two models with different views of the murmuration state).

### D. HTTP MCP transport instead of stdio

Run the MCP server as a long-lived HTTP server bound to a Unix socket or localhost port; configure the CLI to connect to it.

Deferred: stdio is what all three CLIs document as their stable MCP path. HTTP MCP is supported by claude but the surface is less stable across versions, and the local-only Unix-socket variant adds permission management we don't need yet. Revisit if subprocess spawn cost becomes a hot path.

### E. Wait for Vercel SDK to add subscription-cli adapters with native tool routing

Vendor-side fix. Vercel handles the adapter, tool calls flow through normally.

Rejected: not on any public roadmap, and we cannot ship behind it.

## Risks and follow-ups

- **R1: Spawn-cost claim is unverified.** The 50–150ms-per-attach number is intuition. We MUST measure it on a real `murmuration attach` against a moderate murmuration (10+ agents, 50+ events). If per-tool latency is closer to 500ms, we re-evaluate stdio vs HTTP MCP.
- **R2: Orphan MCP servers.** If `claude -p` exits abnormally without closing its MCP client connection, the MCP server subprocess we spawned may persist. We need an integration test that crashes claude mid-turn and asserts the MCP server exits within N seconds via stdin EOF detection.
- **R3: `mcp-bin.js` resolution.** `dirname(fileURLToPath(import.meta.url))` works in dev (monorepo) and in `npm i -g @murmurations-ai/cli` (the bin lives in the same `dist/spirit/` next to client.js). It does NOT work if a future bundling step inlines `client.js` and drops `mcp-bin.js`. Document the build invariant in `packages/cli/package.json` build script comments.
- **R4: Auth surface delta.** ADR-0036 covers the CLI's permission flags. The MCP server inherits the parent process's environment, including any secrets. We MUST audit the Spirit boot path to confirm we're not handing the MCP-spawned subprocess more env than it needs (e.g., harness API keys for other providers). The `env: { MURMURATION_ROOT: rootDir }` in the MCP config is _additive_ to the parent env; it doesn't isolate. Filed as follow-up #739 (TBC).
- **R5: Codex / Gemini Phase B.** Codex's `-c mcp_servers.X.command=` per-key overrides need testing — codex's CLI parser may not accept dotted keys at the command line and may require a config file path. Gemini's `--allowed-mcp-server-names` is an _allowlist_ applied to a settings file, not a config injection — we'd need to write to `~/.config/gemini/settings.json` (mutating user-global state) which is an operator-policy decision, not an engineering one. Both are deferred until Phase B with explicit Source consent.
- **R6: Tool drift between API and MCP paths.** If a future tool is API-only (e.g., it returns binary content) and the Zod schema unwrap step throws, the MCP server crashes at startup and the operator sees claude fail with no obvious cause. We should add a Spirit boot self-test that constructs both transports against `buildSpiritTools()` and refuses to attach if MCP construction fails.
