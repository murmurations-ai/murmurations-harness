# Changelog

All notable changes to the Murmuration Harness are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/).

## [0.5.1] - 2026-04-30

**Boundary 5 hardening — agents actually call tools instead of narrating about them, and stop wasting tokens on operations whose state already exists.**

Today's investigation traced a chronic failure mode where agent wakes returned `tool_calls: 0` and produced sophisticated narrative claims ("I have posted CONSENT on #592") with no actual tool invocations. The root cause was two compounding bugs in the runner. v0.5.1 fixes both, then adds a second class of guard against agents re-running expensive tool setup operations whose state was already on disk from a prior wake.

### Fixed

- **Agents now actually call their tools** (#249). Two compounding bugs were defeating tool calling end-to-end:
  - `selectExtensionToolsFor` filtered the built-in `files` and `memory` tools by the agent's declared plugin list. Agents that declared a phantom or non-extension plugin (`github-extras` in EP) ended up with zero tools threaded into the LLM API request despite the runtime having loaded both extensions. Fix: built-in `files` and `memory` are now auto-included for every agent regardless of declared plugins.
  - The runner's system prompt never listed the loaded tools to the LLM. Even when the API request had tools threaded in, Gemini and Anthropic defaulted to pure narration because nothing in the prompt told them tools existed. Fix: tools are now loaded **before** capabilities are assembled, and the system prompt includes a `### Tools you can call this wake` block listing each tool by name + description, with an explicit instruction to call them rather than narrate about them. Boundary 5 hallucination is named in the prompt as the failure to avoid.
- **`murmuration directive` silently dropped unknown flags and could post empty-body directives** (#247). The body extraction logic (`args.filter(a => !a.startsWith("--")).pop()`) didn't know which flags consumed their next token, so flag values fell through as positional candidates. Fix: explicit `VALUE_FLAGS` and `BOOLEAN_FLAGS` sets, unknown-flag rejection, `--body-file <path>` support for long bodies, title extraction from the first non-empty line.
- **Signal aggregator no longer truncates issue/comment bodies to 500 characters by default** (#248). `EXCERPT_MAX_CHARS` bumped from 500 → 64,000 and `SUMMARY_MAX_CHARS` from 300 → 8,000. The slicing path is now documented as a runaway-payload guard, not a summarization mechanism — the principle is "default to full content; only truncate to prevent pathological payloads."
- **MCP server commands now expand `~`, `${VAR}`, and `$VAR` in command, args, and cwd** (#250). Live failure 2026-04-30: agent role.md files baked in `/home/<linux-user>/...` paths that ENOENT'd on macOS. Bare commands resolved via PATH (the recommended portable form) continue to work unchanged. Unset variables substitute to empty string so typos like `${TYPO}` produce obviously-broken paths that fail loudly at spawn rather than silently substituting something else.
- **Agents no longer re-trigger expensive MCP setup operations when persistent state already exists** (#257, closes #255). Live regression 2026-04-30: a GPT-5.5 cost test showed enabling jdocmunch made wakes 3.7× more expensive per KB of useful output (~\$0.76 → ~\$2.18). The agent was calling `doc_index_repo` in-wake despite the index already being current on disk, dumping ~1.27M tokens of confirmation data into the wake context. Fix: when the runner detects both an expensive setup tool (matching `__doc_index_repo` / `__index_repo` / `__index_folder` / `__embed_repo` / etc.) AND its inventory counterpart (`__doc_list_repos` / `__list_repos`), it appends an "MCP setup discipline" block to the system prompt instructing the agent to inventory first and only index if state is missing or stale. Pattern-based on tool-name suffix; no hardcoded allow-list. Re-verified live: GPT-5.5 + jdocmunch cost dropped to ~\$0.85 (within 12% of the no-jdocmunch baseline).

### Added

- **Boundary 5 detection — directive validation requires structured evidence** (#240). Wakes whose narrative claims to address a directive but produce no matching tool-call evidence are now flagged as `narrative-only-claim` in `daemon.wake.directives.unaddressed` events. Detection runs in `validateWake` and surfaces in operator-visible artifacts. Word-boundary regex prevents `#5` matching `#592`. Phase 1: detection only (warn, not block).

### Changed

- **System prompt explicitly names Boundary 5 hallucination as the failure to avoid** when tools are loaded. Agents are told that narrating an action without calling its tool will be flagged in their wake artifacts.
- **`tools.mcp` declarations in role.md now accept platform-portable command paths** via `~` and env-var expansion (see Fixed → portable MCP paths above).

### Internals

- 691 tests passing across 50 test files (up from 671 in v0.5.0; 20 new tests for `expandPath` plus B5 detection coverage).
- ADRs 0030–0033 renumbered after deduping colliding ADRs from parallel agent wakes (#228).

### Follow-ups filed (not in this release)

- #251 — pricing catalog gap: `gpt-5.x` and recent OpenAI models report \$0 cost
- #252 — Gemini-specific tool-call gap: same prompt + tools, Gemini=0, Anthropic=1, OpenAI=27 tool calls
- #253 — runner hardcodes Gemini model name for facilitator resolution
- #254 — role.md mixes per-agent intent with per-installation deployment config
- #256 — signal aggregator should bundle issue bodies so agents stop re-fetching via `read_issue` (cheap layer-1 fix for GitHub-issue retrieval cost; harness#255's sibling)

## [0.5.0] - 2026-04-21

**"Out of the box" — a non-technical tester can go from `npm install` to a running meeting in under 10 minutes with zero file editing beyond pasting one API key.**

The v0.5.0 work started from a lived failure: on 2026-04-20, a motivated operator hit seven distinct failure points between `murmuration init` and a working circle meeting. v0.5.0 makes each of those failures impossible to reproduce.

### Added

- **`murmuration doctor`** — preflight diagnosis command with six check categories (layout, schema, secrets, governance, live, drift). `--fix` applies safe auto-remediations (rename `circles/` → `groups/`, `chmod 600 .env`, patch missing `.gitignore` entries). `--live` opts into provider API calls that verify credentials actually authenticate. `--json` emits machine-readable output for CI. 12 integration tests.
- **`murmuration init --example hello`** — scaffold the bundled `hello-circle` example (2 agents, 1 group, local collaboration, Gemini default) into a fresh directory. From npm install to first meeting in 6 commands.
- **Interactive secret capture in `init`** — after the LLM provider question, init prompts for the matching `<PROVIDER>_API_KEY` with echo-off, provider-specific shape validation (`AIza…` for Gemini, `sk-ant-…` for Anthropic, `sk-…` for OpenAI, `ghp_…` / `gho_…` / `github_pat_…` for GitHub), and masked-last-4 confirmation. Written directly to `.env` at `0600`; never echoed.
- **Pre-init state detection** — `init` classifies an existing target directory as `empty-or-missing`, `current` (ADR-0026), `legacy-circles` (pre-ADR-0026), or `partial` before anything is overwritten. Operators see what's there with a specific warning per kind.
- **`.env.example` on init** — commit-friendly template shipped alongside the 0600-permissioned `.env`. `.gitignore` updated to cover `.env.*` but preserve `.env.example`.
- **Engineering Standard #11: Reasonable defaults** — codified in `docs/ARCHITECTURE.md`. Any field that isn't a secret or a unique identity claim has a reasonable default; the harness boots against sparse configuration.
- **Engineering Standard #11 cascade in `role.md`**:
  - `agent_id` defaults to the directory slug
  - Numeric `agent_id: 22` coerces to `"22"` (no crash)
  - `name` defaults to the humanized directory slug
  - `model_tier` defaults to `"balanced"`
  - `soul_file` defaults to `"soul.md"`
  - `llm` cascades from `harness.yaml`'s `llm:` block when role.md omits it
- **`humanizeSlug(slug)` + `enrichRoleFrontmatter(raw, agentDir, roleDefaults)`** exported from `@murmurations-ai/core` for programmatic use.
- **`IdentityLoaderConfig.roleDefaults`** — threads the harness-level `llm:` block into the loader so the cascade runs everywhere (boot.ts, group-wake.ts).
- **`murmuration doctor --name <session>` + hero-command post-init message** — init's final output shows the next command to run verbatim, with the session registered so `--name` shortcuts work immediately.
- **`tools.mcp: []` + `plugins: []`** emitted in init-generated `role.md` for parity with the default-agent template.
- **`docs/GETTING-STARTED.md`** rewritten as a tester walkthrough with expected output and a "what to do when…" table for the top 10 failure modes.

### Changed

- **`murmuration convene` replaces `murmuration group-wake`** — unified with the REPL's `:convene` so the operator has one verb for "start a group meeting" regardless of surface. `group-wake` still works as a deprecated alias (prints a deprecation notice) and will be removed in a future release.
- **Generated `role.md` is ~15 lines shorter.** Init emits minimum-viable frontmatter; Engineering Standard #11 fills in the rest at load time.
- **`murmuration/default-agent/` fallback role.md** now uses Engineering Standard #11 shape (no duplicated agent_id/name/model_tier when defaults are correct).
- **README quickstart** leads with the 6-command tester flow instead of the developer-from-source install. Developer install moved to its own section below.
- **Facilitator LLM resolution** (`group-wake.ts`) — new `ResolveLLMResult` discriminated union replaces the catch-all return-null. Each failure mode (`no-llm-block`, `file-not-found`, `frontmatter-invalid`, `other`) prints targeted remediation instead of `could not read LLM config`.
- **`IdentityLoader` error messages** — Zod issues for role.md are annotated with remediation hints when the failure matches a common new-operator pattern (numeric `agent_id`, wrong `model_tier`, wrong `llm.provider`, missing required field).
- **`GitHubCollaborationProvider` error mapping** — GitHub client's hyphen-case codes (`"not-found"`, `"unauthorized"`, `"write-scope-denied"`) now map correctly to `CollaborationErrorCode`. The previous upper-case-only check meant every real GitHub error rendered as `UNKNOWN`. Legacy upper-case codes still accepted for forward compat. Defense in depth: `executeActions` now prints `CODE: message` so even unmapped codes carry the real underlying error.

### Fixed

- **Operators saw `could not read LLM config from facilitator` when the real failure was a schema validation error.** The catch-all in `resolveLLMConfig` swallowed the actual Zod error. Fixed to distinguish and report the true cause.
- **Operators saw `create-issue: UNKNOWN` on every GitHub action failure.** GitHub provider error codes now map correctly.
- **`FrontmatterInvalidError` for numeric `agent_id`** used to be cryptic. Now explicitly suggests `agent_id: "<directory-name>"` as the fix (and in v0.5.0, the loader coerces automatically so operators rarely see the error at all).

### Pre-release reviews (Phase A/B/C)

Four specialized review agents (engineering, architecture, simplicity, security) audited the codebase before the tag. Findings were triaged against ADRs — anything representing design intent was preserved. Dead code, legacy supersession, and real security holes were fixed.

#### Phase A — review cleanup (#208, #213)

- **ADR-0021 supersession removed**: `GovernanceGitHubSync` legacy branch (~190 LoC + 62-line boot.ts shim) replaced by direct `GitHubCollaborationProvider` construction. Runner's `commitPathPrefix` GitHub fallback (60 LoC) similarly removed.
- **Removed cruft**: `SIGNALS_STUB_VERSION` (Phase 1A legacy re-export), `cli/src/command-executor.ts` re-export shim, `collaboration-factory.writeScopesRepos` option (zero callers).
- **Bug fixes**: `isValidWakeAction` rejects NaN / non-integer / non-positive `issueNumber` (same class as PR #174); MCP client reads version from `package.json` instead of hardcoded `"0.4.3"`.
- **MCP wired at boot (ADR-0020 Phase 3)**: `McpToolLoader` is now instantiated when an agent declares `tools.mcp`. Zero overhead for agents that don't.
- **Package metadata**: all 7 packages get `author: "Murmuration Harness Contributors"` and `publishConfig.access: "public"` so the first `npm publish` doesn't 402.
- `docs/adr/UPCOMING.md` tracks 13 items needing ADRs before v1.0.

#### Phase B — security hardening (#211)

- **`scrubLogRecord` now matches value patterns, not just key names.** Gemini (`AIza…`), Anthropic (`sk-ant-…`), OpenAI (`sk-…`), all GitHub token shapes (`ghp_…` / `gho_…` / `github_pat_…` / `ghs_…` / `ghr_…` / `ghu_…`), Slack (`xox[baprs]-…`), and PEM private keys are redacted regardless of the enclosing key. Recurses into arrays. Addresses the PR #154 leak class where a provider echoed the API key into `error.message`.
- **Identifier validation at the Zod boundary**: `IDENTIFIER_RE = /^[a-z0-9][a-z0-9._-]*$/i`, max 64 chars. Applied to `agent_id` and `group_memberships` in `role.md`. Blocks `../../../tmp/x` path traversal into `runs/`, `.murmuration/logs/`, and governance persist dirs.
- **Dashboard auth token**: daemon mints a random 24-byte base64url token at boot, writes to `<root>/.murmuration/dashboard.token` (mode 0600). Every `/api/*` request requires the token via `X-Murmuration-Token` header or `?token=<value>` query param (constant-time comparison). Boot log emits the full URL so the operator can open the dashboard with one click.
- **Host header validation**: rejects requests whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding defense).
- **Dashboard XSS fixes**: `esc()` applied to every untrusted GitHub-sourced interpolation (topics, titles, kinds, dates, IDs, meeting summaries); `safeUrl()` validates href scheme (http/https/mailto only); `linkify()` re-validates every URL it emits; strict `Content-Security-Policy` on `/dashboard`; `X-Content-Type-Options: nosniff`; `Referrer-Policy: no-referrer`.

#### Phase C — governance decoupling (#212)

Core is now governance-model-agnostic. The S3 plugin owns every model-specific decision.

- **`GovernanceTerminology` threaded through `runGroupWake`** — `GroupWakeContext.terminology` replaces eight hardcoded "circle" references in member/facilitator system prompts, meeting headers, and agenda generation. CLI loads the plugin's `terminology` export and injects it.
- **Prefix parser moves from core runner to plugin** — core emits generic `kind: "agent-governance-event"` with the raw topic in payload. S3's `onEventsEmitted` handler parses `TENSION:` / `PROPOSAL:` / `REPORT:` prefixes and creates the model-specific item. Other plugins are free to interpret text however they want.
- **`resolveKeywords` heuristic moves to plugin** — `GovernancePlugin.isResolvingRecommendation(text): boolean` is an optional hook. Daemon calls it; when no plugin is configured, nothing auto-resolves on keyword match. S3 plugin implements it with its own `resolve`/`ratif`/`approve`/`adopt`/`agree`/`pass`/`consent` vocabulary.
- **Single-writer state stores enforced**: `GovernanceStateStore` and `AgentStateStore` accept `readOnly: true`. Mutation methods (`create`, `transition`, `register`, `recordWakeOutcome`) throw on read-only instances. All CLI instantiations (bin.ts status, group-wake.ts governance-queue + retro-metrics, sessions.ts agent-count listing) pass `readOnly: true`. Daemon's instantiations remain writable. Engineering Standard #3 now code-enforced, not just documented.

### Added (additional v0.5.0 work beyond review phases)

- **`runs/` moved out of `.murmuration/`** (#204) — digests are content; they belong in the visible root, not under a hidden ops directory. One-time auto-migration on first boot.
- **Log consolidation** (#206) — `daemon.log` and `wake-<agent>.log` live under `<root>/.murmuration/logs/` (was: scattered at the root of `.murmuration/`). Helper functions `daemonLogPath()` / `wakeLogPath()` exported from core.
- **Digest UX**:
  - Digest filenames include full ISO date+time (`digest-2026-04-21T17-49-54Z-<shortid>.md`) for chronological sort (#199)
  - `:show-digest <agent>` with lazy per-agent filename caching + tab completion + enter-for-latest (#197/#200/#201/#202)
  - `:status <agent>` shows the actual most recent digest + path under each summary (#184/#194)
- **REPL improvements**:
  - Per-murmuration REPL history files (unattached REPL has its own) (#193/#195)
  - `:stop <name>` / `:start <name>` / `:restart <name>` in unattached REPL with tab completion (#187/#190/#191)
  - `:wake --force` resets circuit breaker; surfaces skip reason (#185)
  - `:agents <text>` / `:groups <text>` / `:events <text>` substring filters with tab completion (#181/#183/#186)
  - `:status <agent>` per-agent detail view (#180)
  - Daemon disconnect drops back to unattached REPL instead of crashing (#176)
- **`agent.maxSteps = 256`** (configurable in `harness.yaml`) — tool-use step budget with step-count in digest + budget-exhaustion warning (#196)
- **`init` scaffolds `signals.github_scopes` with `assigned-label` filter** so new agents see their assigned work without operator configuration (#203)

### Fixed

- **`/issues/undefined` 404** (#174) — `GitHubCollaborationProvider` wraps `number` into `IssueNumber` brand correctly. `unknown`-typed interface parameters that hid the bug for months are tracked in `docs/adr/UPCOMING.md`.
- **Empty digests** (#198) — LLM output is aggregated across all tool-use steps; final-step tool-call no longer loses intermediate text.
- **`:directive close/delete` on non-directives** (#177) — assert target has `source-directive` label before acting.
- **Closing an already-closed directive** (#178) — short-circuits with clear message instead of reporting false success.
- **`:directive delete` on GitHub-backed murmurations** (#179) — refuses (GitHub REST can't delete via PAT); directs operator to `gh issue delete` with explicit command.
- **SIGTERM doesn't exit cleanly** (#188) — socket server + HTTP server kept the event loop alive. Fixed by explicit `process.exit(0)` after shutdown log. REPL surfaces wake-timeout reason.
- **`:status <agent>` shows stale data** (#184) — reloads state before rendering.
- **Digest list ordered by filename** (#202) — sort by file mtime instead.
- **Attached `:stop` with mismatched target** (#189) — refuses to prevent stopping the wrong murmuration.

### Engineering

- **650 tests pass** (+105 from v0.4.5), 0 lint errors, format clean.
- **ADR tracker**: `docs/adr/UPCOMING.md` catalogs 13 items needing ADRs (bundled plugin convention, core's governance prefix parsing, dashboard polling, `setInterval` exemptions, direct-FS reads from dashboard, runs/pipeline visibility split, Strategy plugin, Collaboration provider ecosystem, 4 future-feature scaffolds, pre-1.0 "no back-compat" stance, ADR index automation).
- **Follow-up issues filed**: #209 (upstreamAgentIds wiring), #210 (external governance-event routing).
- **Strict-mode TypeScript discipline**: no new `any`, no new `unknown` leaks across interfaces, noUncheckedIndexedAccess + exactOptionalPropertyTypes compliant.

### Deferred to v0.5.1+

- **Cross-repo write scopes in `CollaborationProvider`** — providers are scoped to one repo; multi-repo coordination needs ADR design.
- **Thin composition root** — `boot.ts` is 1800+ lines; architecture reviewer flagged it. Split into named classes in a dedicated refactor PR.
- **`dashboard-tui` off direct FS reads** — TUI reads `.murmuration/state.json` / `items.jsonl` / `logs/daemon.log` directly. Should route through the daemon's typed API.
- **Boundary-type hardening** — several internal seams still use `unknown` where branded types would prevent PR #174-class bugs.
- **Eight more ADRs** per `docs/adr/UPCOMING.md`.

## [0.4.5] - 2026-04-19

### Added

- **ADR-0029 — Agent persistent memory across wakes.** New built-in `@murmurations-ai/memory` extension ratified by the EP Engineering Circle consent round (emergent-praxis#444). Three tools:
  - `remember(topic, content, tags?)` — append a YAML-headed entry to `agents/<id>/memory/<topic>.md`
  - `recall(topic | query)` — exact topic return OR substring search across all topics; responses wrapped in `<memory_content>` boundaries
  - `forget(topic, entry_id?)` — move to `.trash/` with retention metadata
  - Tools are built per-agent at wake time, `agentDir` captured in the closure. No LLM can cross-address another agent's memory.
  - Auto-included for local-governance agents (same pattern as the files plugin in v0.4.3).
  - Memory files are human-readable markdown, git-diff-able, operator-editable.
- **Self-digest tail** — default runner now injects the agent's own last N wake digests as a `## Recent work` block, wrapped in `<memory_content>` tags. Configurable via `DefaultRunnerOptions.selfDigestTail` (default 3, set to 0 to disable).
- **Memory-poisoning mitigation** (ADR-0029 §4) — system prompt includes a passive-data instruction telling the LLM to treat memory content as quotation, not directive. Upstream digests + self-digest + recall responses all emit `<memory_content>` boundaries.

### Changed

- **Dashboard Cost & Wakes sparkline** now buckets from real `finishedAt` timestamps in `index.jsonl` instead of distributing week wakes uniformly across days 0-5 (fixes #59). `CostSummary.wakesPerDay7d` exposes the 7-day histogram.
- **Dashboard missing-root guidance** — when `.murmuration/` is absent at the target path, the TUI renders a dedicated guidance panel with fix paths (`cd`, `--root`, or `murmuration start`) instead of four simultaneous empty panels (fixes #61).

### Fixed

- **`HARNESS_VERSION` drifts out of sync with published version.** Derived from `@murmurations-ai/core`'s `package.json` at module load now, so `pnpm version` is the single source of truth and `murmuration --version` can't lie.

### Documentation

- **ADR-0029 amended and accepted** — memory-poisoning threat model added per EP Engineering Circle consent round. Security Agent's S3 objection resolved with `<memory_content>` boundaries + passive-data prompt instruction + explicit threat-model table.

## [0.4.4] - 2026-04-19

### Added

- **ADR-0027 — Fallback identity for incomplete agent directories.** `IdentityLoader` now accepts `fallbackOnMissing: true` + `onFallback` callback. Missing `soul.md` / `role.md` or invalid frontmatter synthesizes a generic identity (`model_tier: balanced`, modest budget, no write scopes, functional default) instead of crashing boot. `LoadedAgentIdentity.fallback` tells callers when a fallback was used.
- **Operator-tunable default agent templates.** `<root>/murmuration/default-agent/{soul,role}.md` is the operator's per-murmuration default, with `{{agent_id}}` tokens interpolated at load time. Falls through to the built-in shipped in `@murmurations-ai/core` when absent. `murmuration init` materializes the templates into every new murmuration.
- Daemon boot wires `fallbackOnMissing: true` and logs `daemon.agent.fallback` at `warn` so fallbacks surface in production runs.

### Changed

- **ADR-0028 — Eliminate `agent.mjs` requirement for standard agents.** Every agent now routes through `InProcessExecutor` with the default runner by default. Non-LLM agents get a `"skipped — no LLM client"` wake summary rather than requiring a subprocess script. Operators who already have `<root>/agent.mjs` still get the subprocess escape hatch.
- `docs/GETTING-STARTED.md` scrubbed of `agent.mjs` / `runner.mjs` references — internal implementation details, not public surface. The public contract is markdown only.
- `examples/hello-world-agent/` is now pure markdown: `agent.mjs` removed, `circle_memberships` → `group_memberships`, `governance/circles/` → `governance/groups/`.
- `murmuration start` defaults to `process.cwd()` like every other CLI command rather than the bundled hello-world (fixes #60).
- `murmuration init` writes `.gitignore` with `.env` + `.murmuration/` coverage BEFORE writing `.env`, and appends missing entries to an existing `.gitignore` rather than overwriting curated rules (fixes #10).

### Fixed

- **Directive close / delete / edit CLI subcommands** (regression fix from #111, shipped via #114). Restored the management verbs that were silently dropped in PR #104. 8 new regression tests lock the dispatch shape.

### Documentation

- ADR-0018, 0019, 0023, 0024 status bumped from "Proposed" → "Accepted" (all shipped in v0.3.x–v0.4.x).
- ADR-0027 and ADR-0028 written and accepted.

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
