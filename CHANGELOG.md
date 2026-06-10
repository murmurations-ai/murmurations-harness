# Changelog

All notable changes to the Murmuration Harness are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

## [0.9.0] - 2026-06-10

**Operational hygiene, agent-lifecycle reconciliation, and contract-validation hardening.** A cycle of operator-visible diagnostics and correctness fixes for the silent failure modes that bite long-running murmurations: stale GitHub issues that bloat every watching agent's per-wake context, agent directories that wake on the default-agent template after their `role.md` was removed (and the `state.json` tombstones they leave behind), subscription-CLI agents whose declared file writes silently no-op'd in headless mode, and contract obligations that could be satisfied by a path the operator never declared. Behavioral validation remains warning-only — its promotion to hard-fail, and the `verifiedActions` evidence channel it depends on, are deferred to the next release ([#376](https://github.com/murmurations-ai/murmurations-harness/issues/376)).

### Added

- **`murmuration doctor --live` hygiene category** ([#394](https://github.com/murmurations-ai/murmurations-harness/issues/394) scope 1). New `hygiene` doctor category gated behind `--live` (it needs a GitHub round-trip). Scans `collaboration.repo` for open issues stale by age (>14d open + 7d silent) and digest-pattern titles (`[DIGEST]` / `[FINANCE]` / `[STATUS]` / `[REPORT]` / `[KICKOFF]`); emits info-severity findings with remediation pointing to `docs/CONVENTIONS-GITHUB-VS-FILES.md`. Capped at 5 pages (500 issues) to bound rate-limit cost. Graceful no-op for `collaboration: local` and when `GITHUB_TOKEN` is unset.
- **Per-wake signal-bundle metric in `index.jsonl`** ([#394](https://github.com/murmurations-ai/murmurations-harness/issues/394) scope 2). New optional `signalBundle: { issueCount }` field on every `RunArtifactIndexEntry`, computed by the daemon from `context.signals` at wake fire time. Persists per-wake "what context did this agent read" so the dashboard can flag bloating.
- **Dashboard `[b:N]` badge in the agents panel** ([#394](https://github.com/murmurations-ai/murmurations-harness/issues/394) scope 2). Shows the agent's last `github-issue` count. Dim by default; yellow when above the new `signals.spikeThreshold` config knob (default 10).
- **`signals.spikeThreshold` in `harness.yaml`** ([#394](https://github.com/murmurations-ai/murmurations-harness/issues/394) scope 2). New `signals:` block with `spikeThreshold: number` (default 10). Operator-tunable for chattier repos. Wired through `HarnessConfig` + Zod schema + lenient loader.
- **`murmuration list-stale-issues` CLI** ([#394](https://github.com/murmurations-ai/murmurations-harness/issues/394) scope 3). Read-only inventory of open issues bloating the signal bundle. Table + `--json` output, sorted oldest-silence-first. Flags: `--days N`, `--silence-days N`, `--digest-only`, `--json`. Closure is operator judgement — no auto-close.
- **`daemon.signal-bundle.large` event** ([#398](https://github.com/murmurations-ai/murmurations-harness/pull/398)). Daemon emits a structured-log line when an assembled bundle exceeds the configured spike threshold. Mirrors the `daemon.validate.legacy-fallback` observability precedent.
- **`AggregatorCaps.commentsPerIssue` knob** ([#398](https://github.com/murmurations-ai/murmurations-harness/pull/398)). Comment cap on the signal aggregator now defaults to 5 (was hardcoded 20). Cuts per-wake input tokens on chatty threads. Truncation note names the omitted count.
- **Daemon orphan-schedule warning** ([#380](https://github.com/murmurations-ai/murmurations-harness/issues/380)). Boot now detects when an agent's `role.md` is missing entirely and refuses to register the cron entry — silent waking via the default-agent template was the silent-drift class EP#874 surfaced. Multi-agent boot warns + skips (`daemon.warn.orphaned-schedule`); single-agent boot (`--agent <id>`) hard-fails with `BootError(kind: "agent-missing-role")`. Predicate `isOrphanedSchedule(loaded)` exported from `@murmurations-ai/core` (type guard).
- **Trojan Source / Unicode bidi hardening** (review followup to [#380](https://github.com/murmurations-ai/murmurations-harness/issues/380)). `sanitizeForTerminal` now strips C1 controls (incl. 8-bit CSI `\x9b`), Unicode bidi overrides + isolates (U+202A-U+202E, U+2066-U+2069 — CVE-2021-42574), zero-width chars (U+200B-U+200F, U+FEFF), and line separators (U+2028-U+2029). Closes a class of operator-log spoofing via maliciously-named agent directories. Pre-existing surface, but the recent work made the sanitizer flow operator-reachable through several new emission points.
- **Shared `stale-issues.ts` module** in `@murmurations-ai/cli` ([#402](https://github.com/murmurations-ai/murmurations-harness/pull/402)). `classifyStaleIssues`, `partitionByReason`, `fetchOpenIssues` consolidated from the two original copies that #399 and #401 each shipped independently. `dotenv.ts` extracted the second time the dedupe was needed.
- **`AgentStateStore` tombstone reconciliation** ([#405](https://github.com/murmurations-ai/murmurations-harness/issues/405), [#415](https://github.com/murmurations-ai/murmurations-harness/pull/415)). New `"orphaned"` member on `AgentLifecycleState` and `markOrphaned()` on the store. At boot, any `state.json` record not backed by a live `agents/<id>/role.md` — the records #380's orphan-schedule warning leaves behind — is marked orphaned with a `daemon.agent.stale-record` warning (previousState / registeredAt / lastWokenAt / totalWakes). If the operator restores the role.md, `register()` resurrects the slot: circuit-breaker counters and last-life status (`consecutiveFailures`, `idleSkipStreak`, `lastOutcome`, `lastWokenAt`, `lastFiredContextHash`) reset so the new role doesn't inherit a tripped breaker or stale "failed" badge, while historical totals (`totalWakes`, `totalArtifacts`, `idleWakes`, `registeredAt`) are preserved as audit signal. The dashboard activity feed filters wakes belonging to orphaned agents.

### Changed

- **Signal-aggregator comment cap default: 20 → 5** ([#398](https://github.com/murmurations-ai/murmurations-harness/pull/398)). Observable default-behavior change riding the new `AggregatorCaps.commentsPerIssue` knob above — chatty issue threads contribute at most 5 comments per issue to each wake's signal bundle unless the operator raises the cap.
- **Daemon boot refuses orphaned schedules** ([#380](https://github.com/murmurations-ai/murmurations-harness/issues/380)). Behavior change riding the orphan-schedule warning above: multi-agent boot skips cron registration for agent dirs missing `role.md` (previously they woke on the default-agent template); single-agent `--agent <id>` boot now hard-fails with `BootError(kind: "agent-missing-role")`.
- **Subscription-CLI `permissionMode` auto-derives from `branch_commits`** ([#392](https://github.com/murmurations-ai/murmurations-harness/issues/392), [#412](https://github.com/murmurations-ai/murmurations-harness/pull/412)). When a subscription-CLI agent declares non-empty `branch_commits` paths but leaves `llm.permissionMode` unset, the daemon now elevates it to `trusted` so headless `-p` wakes can actually write the files the operator declared intent to commit (claude `--dangerously-skip-permissions` / codex `--dangerously-bypass-approvals-and-sandbox` / gemini `--yolo`). Closes the silent class where declared writes no-op'd for 6+ wakes before agents filed tensions. The operator's explicit setting always wins — at **both** role.md and harness.yaml granularity — and a `daemon.agent.permission-mode.auto-elevated` warning records each elevation. The per-agent run-artifact audit context records the **effective** mode, so run artifacts never misreport an auto-elevated wake as sandboxed.
- **Per-segment glob matcher for contract obligations** ([#363](https://github.com/murmurations-ai/murmurations-harness/issues/363), [#417](https://github.com/murmurations-ai/murmurations-harness/pull/417)). The v0.8.0 obligation validator used a prefix+suffix matcher that over-matched across path segments — `agents/*/role.md` matched `agents/x/y/role.md`, so a contract could be satisfied by a commit to a path the operator never declared. Replaced with a segment-aware matcher: `*` stays within one segment, `**` crosses segments (`**/` consumes zero or more leading segments, trailing `**` matches everything beneath), `?` matches one non-slash character, and `[...]`/`[!...]` are single-character classes that never bridge a segment. `pathMatchesGlob` is now exported from `@murmurations-ai/core`; malformed patterns report no-match rather than throwing during validation.

### Fixed

- **Spirit reporting test fixtures were a CI time-bomb** ([#415](https://github.com/murmurations-ai/murmurations-harness/pull/415)). `spirit-meta-fixture.test.ts` and `reports.test.ts` pinned synthetic wakes/observations to hardcoded April 2026 dates while `fetchMetrics` windows to `[now − 30d, now]` — the data aged out of the window (~May 31) and every PR's CI failed on no code change. Fixtures are now anchored to relative time.
- **Spirit MCP-config sweep raced concurrent attaches** ([#362](https://github.com/murmurations-ai/murmurations-harness/issues/362), [#414](https://github.com/murmurations-ai/murmurations-harness/pull/414)). The orphaned-config sweep ran on every attach, so two attaches starting within the same sub-second window could delete each other's still-live ephemeral MCP config. The sweep now runs once at daemon start — after pidfile acquisition and gated on `!once`, so a `start --now/--once` immediate wake can't delete a live attach's config either — and the per-attach path is write-only.
- **Plugin-error name lost in fatal stderr** ([#360](https://github.com/murmurations-ai/murmurations-harness/issues/360), [#413](https://github.com/murmurations-ai/murmurations-harness/pull/413)). The `bin.ts` fatal catch flattened typed plugin errors to a bare message, dropping the `error.name` discriminator operators grep for. A new `formatFatalError` helper preserves the `[ErrorName]` prefix for typed errors while leaving generic `Error` and non-`Error` throws byte-identical.

### Internals

- Issue `signalBundle?` field is **optional** — entries written before this batch remain readable. `schemaVersion` stays at 1 (additive).
- The hygiene + list-stale-issues network paths share a single capped pagination helper and a per-item type guard (`isRestIssueResponse`) so a malformed REST response can't silently produce NaN ageDays.
- `splitRepo()` validates owner/name against GitHub slug grammar (`^[A-Za-z0-9_][A-Za-z0-9._-]*$`, `..` rejected) so a malicious `collaboration.repo` cannot redirect the Bearer-token-bearing fetch to a non-GitHub host.

### Filed for follow-up

- [#406](https://github.com/murmurations-ai/murmurations-harness/issues/406) — privilege amplification via operator-supplied permissive `default-agent/role.md` template.

## [0.8.0] - 2026-05-19

**Execution contracts — agents declare what completion looks like in `role.md`, the validator scores wakes against the obligation, and the dashboard surfaces it.**

The harness shipped through v0.7.2 with the wake loop measuring whether agents _produced artifacts_, not whether they _satisfied an obligation_. v0.8.0 closes that gap by introducing the `contract:` block in `role.md`, an end-to-end pipeline that assembles a per-wake `ExecutionContract` from operator-authored declarations plus runtime context, injects the obligation into the system prompt as a `trusted` segment, and validates outcomes against the declared `requiredOutputs`. Behavioral validation (the narrative-vs-tool-call cross-check) ships in warning-only mode in v0.8.0 — operator calibration before promotion to hard-fail in v0.8.1.

ADR-0047 ([Execution Contracts](docs/adr/0047-execution-contracts.md)) defines the contract shape; ADR-0048 ([Phase 4 scope lock](docs/adr/0048-phase-4-scope-lock-for-v0.8.0.md)) compresses the 22–28 day target to ~8 days by deferring `validateBehavior` hard-fail to v0.8.1.

### Added

- **`contract:` block in `role.md` frontmatter** (#367). Optional operator-facing declaration with five fields, all arrays defaulting to empty: `done_when`, `committed_artifacts`, `runtime_artifacts`, `verification_required_for`, `approval_required_for`. Parsed via Zod with `.strict()` so typos surface at boot. Roles without a `contract:` block continue to work — the harness synthesizes a minimal default from runtime context.
- **`assembleExecutionContract()`** (#367). New core function that builds a full `ExecutionContract` per wake from the role's `contract:` block + signal bundle + budget + GitHub write scopes. Result lands on `AgentSpawnContext.contract` and threads through to prompt assembly + post-wake validation. Brutally-simple v1 mapping: `done_when` → `completionConditions`, `committed_artifacts` + `runtime_artifacts` → `requiredOutputs` by kind, signal action items → `ActionItemRef[]`, `verification_required_for` → required `VerificationStep[]`, `approval_required_for` → `ApprovalPolicy`.
- **Contract-aware system prompt** (#370). `PromptAssembler` injects a `trusted` `contract` segment containing Objective, Completion conditions, Required outputs, Verification, Permitted side effects, and Source approval — so the agent reads what completion looks like before doing the wake. When no obligations are declared, the segment degrades to a short notice instead of empty sections.
- **Obligation enforcement in `validateWake`** (#371). When the contract declares `requiredOutputs`, each one is checked against successful action receipts: `committed-artifact` / `commit` → matching `commit-file` receipt + path glob, `comment` → `comment-issue` receipt, `issue` → `create-issue` receipt, `runtime-artifact` → auto-satisfied on wake completion, `governance-event` → at least one event emitted, `summary` → non-empty `wakeSummary`. Unmet obligations override the legacy heuristic and mark the wake non-productive — counts toward `idleWakes`. New fields on `WakeValidationResult`: `obligationStatus` (`satisfied` | `unmet` | `not-applicable`) and `unmetRequiredOutputs[]`.
- **Multi-path obligations with OR semantics**. `committed_artifacts: [a, b, c]` in `role.md` now folds into ONE obligation whose `paths` array satisfies if any one glob matches a `commit-file` receipt or blob URL. The previous shape (one obligation per glob, evaluated as AND) marked agents non-productive even when they committed real work to one of the declared paths. Single-path declarations are unchanged.
- **`pathMatchesGlob` brutally-simple matcher** (#371). Prefix + suffix glob matcher supporting `drafts/**/*.md`, `agents/*/role.md`, `*.md`. Full glob semantics (per-segment `*`, character classes, `?`) deferred to v0.8.1.
- **Dashboard surfaces `validationStatus` per wake** (#372). The TUI agents panel now shows obligation results: red `[obl-unmet:N]` badge when `requiredOutputs` go unmet, yellow `[dir-unaddr]` for unaddressed source directives (Boundary 5 carry-forward), dim `[idle-val]` for plain-idle wakes. Productive wakes show no badge. `index.jsonl` gains `validationStatus`, `obligationStatus`, `unmetRequiredOutputsCount`, and `productive` fields.
- **`validateBehavior` in warning-only mode** (#373). Scans `wakeSummary` for action-verb patterns (`posted to #N`, `closed #N`, `labeled #N`) and cross-checks each against either a successful `WakeActionReceipt` of the matching kind + issue number OR a GitHub issue URL for the same issue number. Unmatched claims emit a `BehaviorWarning`. **Warning-only** — does NOT affect `productive`, `idleWakes`, or `successfulWakes`. Dashboard renders the count as a yellow `[beh:N]` badge.
- **GitHub issue URLs as structural evidence** (#369). `validateWake` directive validation now treats a fully-qualified URL like `github.com/<owner>/<repo>/issues/<N>` in `wakeSummary` or any governance event payload as evidence the agent acted on that issue — eliminates the false-positive `narrative-only-claim` that fired on every consent-round response from subscription-CLI agents (whose subprocess-internal comment posts never land in `result.actions`).
- **GitHub blob URLs as `committed-artifact` evidence** (#377). The obligation validator now treats `github.com/<owner>/<repo>/blob/<branch>/<path>` URLs in `wakeSummary` or governance event payloads as evidence for `committed-artifact` / `commit` obligations when no `commit-file` receipt is present. Closes the same gap for subscription-CLI agents that commit via subprocess `gh api` calls.
- **`daemon.validate.legacy-fallback` event** (#375). Emitted whenever a completed wake falls back to the legacy heuristic — either because no contract was supplied or because the contract declared no `requiredOutputs`. Operators can count these events to measure how many wakes still skip the obligation sub-contract.
- **Incomplete-agent detection at boot**. The daemon now refuses to spawn an agent whose directory has `role.md` OR `soul.md` but not both. The incomplete dirs are printed to stderr at boot; the daemon proceeds with the agents that ARE fully configured. Previously the loader silently synthesized a default for the missing file (intended for scaffolding) which let half-configured agents wake and produce phantom activity in the audit trail.
- **`murmuration list` surfaces orphan daemons**. The command now scans the OS process table for `murmuration start --root <X>` processes whose socket isn't registered in `~/.murmuration/sockets/`, and lists them under `(orphan)`. Useful when a prior daemon was started without a socket symlink or its pidfile was overwritten by a later start — the orphan keeps firing scheduled wakes from stale in-memory state and is invisible to the registered-session view.
- **ADR-0047** (Execution Contracts) and **ADR-0048** (Phase 4 scope lock) accepted.

### Changed

- **`AgentSpawnContext.contract`** type upgraded from the Phase 0 stub (`{objective, doneWhen, allowedSideEffects}`) to the full `ExecutionContract` type. Test fixtures and pre-Phase-4 callers can still leave it `undefined`; production daemon wakes always populate it.
- **`validateWake` signature** — context arg now accepts an optional `contract: ExecutionContract`. Legacy callers without a contract continue to use the heuristic path; `obligationStatus` is `undefined` on the result.
- **`RunArtifactWriter.record()` and `DispatchRunArtifactWriter.record()`** accept an optional `WakeValidationResult` so `index.jsonl` entries can carry validation fields downstream to dashboards and eval queries.
- **Spirit `write_file` blocks operator config paths** (#368). The `safePath` write guard now refuses overwrites to `agents/<id>/role.md`, `agents/<id>/soul.md`, `murmuration/soul.md`, and `harness.yaml`. Closes the trusted-segment injection path before contract content becomes prompt-trusted in #370. Read access is unaffected; subdirectory writes (`agents/<id>/prompts/wake.md`) remain allowed.

### Fixed

- **`validateWake` false-positive on subscription-CLI WakeAction comments** (#369, #364 Part A). Subscription-CLI agents post comments via subprocess tool calls that never reach `result.actions`. The validator now treats a `/issues/<N>` URL in `wakeSummary` or any governance event as structural evidence (with word-boundary lookahead so `/issues/845` does not satisfy `#84` or `#8450`). Part B (`verifiedActions` field on `AgentResult`) deferred to v0.8.1.
- **`validateWake` false-positive on subprocess `gh api` commits** (#377, #364 Part C). Same class of bug for `committed-artifact` obligations: agents committing via `gh api` produce no `commit-file` receipt but leave a blob URL in the wake summary. Blob URLs are now accepted as evidence (with trailing sentence-punctuation stripped so `…/foo.md.` extracts `…/foo.md`).
- **Spirit `safePath` followed symlinks and was case-sensitive** (#385). An agent could create `agents/foo/role.md → /etc/something` (or symlink a `drafts/` path that resolved into a sibling agent's directory) and Spirit's `read_file` / `write_file` followed the link, bypassing the trusted-surface guard. The check is now realpath-based — both the murmuration root and the target are resolved before any safety check, with walk-up to the closest existing ancestor for new-file writes. On macOS APFS (case-insensitive by default) the prior regex bypassed `agents/foo/Role.md` despite that being the same inode as `role.md`; comparison is now lowercased.
- **`murmuration list` terminal-injection via attacker-controlled `ps` output** (#385). The orphan-daemon scanner read `--root <value>` from another local process's command line and echoed it unsanitized to the operator's terminal. Any local user could spawn `sleep 1d --root $'\e[2J\e[H[FAKE row]'` and inject ANSI controls into the listing. Captured roots containing control bytes are now rejected; the parser also switched from BSD-only `command=` to POSIX `args=` with a fallback for non-GNU `ps`.
- **`RequiredOutput.kind` discriminated union widened to `string` in three of four declaration sites** (#386). The OR-semantics fix shipped earlier in the cycle propagated `kind: string` through `WakeValidationResult.unmetRequiredOutputs`, `isOutputSatisfied`, and the local validator builder, eliminating the exhaustive-switch safety the literal union was meant to introduce. Extracted `RequiredOutput` and `RequiredOutputKind` as named exports; the `isOutputSatisfied` switch now uses a `never` exhaustiveness check.
- **`path` vs. `paths` exclusive-but-coexisting on obligations** (#386). The previous shape carried both fields with a runtime tie-breaker documented one way and implemented the other. Collapsed to `paths` always; single-path declarations carry `paths.length === 1`. Eliminates the contradiction and removes the dead `length === 1` special-case from the assembler.
- **`isOutputSatisfied` default-`true` for unknown obligation kinds** (#386). Speculative "forward-compat" against the closed Zod kind enum. Replaced with exhaustive `never` so a new kind forces a compile-time deliberate decision rather than silently satisfying.
- **`boot.ts` called `process.exit` for configuration errors** (#387). Engineering Standard #6 says only `bin.ts` may exit the process. Boot now throws a typed `BootError` carrying its own `exitCode`; `bin.ts` catches and maps to sysexits-78. Covers incomplete-agent-single, no-agents-found, governance-plugin-invalid, and secrets-load-failed paths.
- **Dead `actionItems` field on `ExecutionContract`** (#388). Populated by the assembler from `signals.actionItems` but never read by the prompt renderer, validator, or any other consumer. Removed the field plus the `toActionItemRef` helper and the `ActionItemRef` interface. Live action-item reads continue through `context.signals.actionItems` on `validateWake`.
- **`renderContractForPrompt` always emitted `## Permitted side effects`** (#388). For the common read-only contract this was prompt-token noise. Now emitted only when the contract grants anything beyond `read`.
- **Progress-note comments re-introduced after the #378 cleanup pass** (#388, #390). ~17 `Phase 4 PR N`, `(harness#NNN)`, "before v0.8.1 promotes...", and forward-plan markers crept back across `runtime/execution-contract.ts`, `daemon/runs.ts`, `identity/index.ts`, `runtime/prompt-assembler.ts`, two test files, and `dashboard-tui/src/{data,dashboard}.ts`. Scrubbed.
- **Validator-spoof via blob URL with `..` segments** (#390). The path→paths collapse from #386 widened the validator surface — a compromised agent could declare `committed_artifacts: ["../../etc/**"]` and synthesize a blob URL whose extracted path traversed out of the repo, spoofing obligation satisfaction without an actual commit. `extractGithubBlobPaths` now rejects `..` segments and absolute paths; `contractDeclarationSchema` rejects the same at parse time so the operator gets a clean error rather than a silently-broken contract.
- **`boot.ts` stderr writes filtered for terminal injection** (#390). Same class as the `murmuration list` injection fix in #385: a directory dropped under `agents/` with a name containing ANSI escape bytes would have been echoed unsanitized into the operator's terminal by the incomplete-agent warning block. New `sanitizeForTerminal` helper replaces control bytes with `?` before any operator-visible write.
- **S3 vocabulary in the fallback role template** (#390). `IdentityLoader`'s synthesized `role.md` referenced "tensions" and "consent rounds" — S3-specific terminology that contradicted the governance-model-independence claim in `CLAUDE.md`. Every fallback-synthesized agent picked it up regardless of the operator's governance plugin. Rewritten to generic "governance items" / "approval-required" language.
- **`mkContract` test helper re-leaked the `RequiredOutput.kind` literal union** (#390). The validator obligation test helper re-declared the seven literal kinds inline rather than importing `RequiredOutputKind` — the same anti-pattern #386 closed in production code. Imported the named type.

### Known limitations (v0.8.1 follow-ups)

- **`validateBehavior` ships warning-only**. Hallucinated tool-call claims are surfaced on the dashboard but do not mark the wake non-productive. Operators relying on `successfulWakes` as a correctness signal should be aware that behavioral hallucinations are flagged, not enforced. Hard-fail promotion lands in v0.8.1 after the 14-day composite-permission soak per ADR-0048 §Decision 2.
- **OR clauses in `done_when` are not evaluated structurally** — they remain narrative guidance to the agent. The structured OR-satisfaction in v0.8.0 lives in `committed_artifacts` / `runtime_artifacts` (multi-path obligations). A future DSL pass in v0.8.1 may parse `done_when` directly.
- **Glob matcher is prefix+suffix only**. `drafts/**/*.md` matches `drafts/foo/bar.md`; `agents/*/role.md` matches `agents/x/role.md` (and over-matches `agents/x/y/role.md`). Per-segment glob semantics arrive in v0.8.1. Operators needing exact path matching can spell out the full path with no wildcards.
- **`validateWake` FP "narrative-only-claim" Part B** — the long-term clean fix is an opt-in `verifiedActions` field on `AgentResult` populated by subscription-CLI executors. Part A (URL evidence) covers most observed cases; Part B lands in v0.8.1.

### Migration

Operators with existing murmurations do **not** need to add a `contract:` block to their role.md files — agents continue to work unchanged with the legacy heuristic. To opt in:

```yaml
# role.md frontmatter
contract:
  done_when:
    - "At least one research artifact committed under drafts/"
    - "OR at least one substantive issue comment posted"
  committed_artifacts:
    - "drafts/**/*.md"
  runtime_artifacts:
    - ".murmuration/runs/<agent-id>/**/*.md"
  verification_required_for: []
  approval_required_for: []
```

See the **Execution contracts** section of [README.md](README.md#execution-contracts) for the full syntax.

### Internals

- 1264 tests passing across 72 test files (up from 1097 in v0.7.2).
- Cold-start cost gate measured (#365 closed): 138 ms boot phase, 0 GitHub API calls during cold-start — contract assembly is local file I/O.
- The release was walked back after a first tag (#384) following two rounds of multi-agent code review (architecture / security / TypeScript / quality). Round 1 surfaced 16 findings closed in #385 (security), #386 (type tightening), #387 (boot typed errors), and #388 (cleanup sweep). Round 2 verified the round-1 fixes and surfaced five more — including a real regression introduced by #386 — closed in #390 before the final tag.

## [0.7.2] - 2026-05-07

**Signal routing correctness — agents now see their own directives, score only their own accountability, and read Source answers posted as comments.**

Three bugs surfaced by Chinook Wind agents in their own consent responses during the 27→9 consolidation round; all three mapped precisely to named gaps in Proposal 07. Field evidence that the execution contracts work: agents with the right identity docs file the right tensions in the right shape.

### Fixed

- **`scope:agent:<id>` routing inversion** (#353). Agents received directives scoped to _other_ agents and zero of their own. Root cause: the shared `DefaultSignalAggregator` pool had no per-agent filter — all agents saw the same merged issue set. Fix: added a routing filter to `#collectGithub` that runs on the raw pool **before** the `githubIssue` cap. Issues carrying routing labels (`assigned:*` / `scope:*`) for a different agent are stripped; issues with no routing labels (priority:\*, bug, etc.) pass through to all agents. Uses `isAssignedLabel`/`isScopeLabel` from `@murmurations-ai/core` so the filter stays in sync with label vocabulary changes.

- **Effectiveness scoring penalised cross-domain agents** (#354). Facilitator-agent self-reported `effectiveness: high` (correctly) but the harness downgraded it to `low` because three out-of-scope directives in its bundle were counted as unaddressed. Root cause: `validateWake` had no agent identity context and counted all visible directives as accountability. Fix: `agentId` and `groupIds` are now required context fields on `validateWake`; directives not in the agent's routing set are skipped during effectiveness scoring.

- **Signal aggregator omitted issue comments** (#350). Agents saw only the issue body, missing Source answers posted as comments. Fix: `#collectGithub` now calls `listIssueComments` (with `?per_page=20` to avoid over-fetching) for issues with `commentCount > 0`, after filter+cap so only agent-relevant issues incur the API cost. Comments are wrapped in `<untrusted-comment author="@login" date="...">` tags as a prompt injection boundary, capped at 20 per issue. The count header shows shown vs. total when truncated ("Comments (20 — showing first 20 of 50):"). Fetch failures emit a `bundle.warnings` entry and fall back to body-only.

### Changed

- **`CallOptions.perPage`** — new optional field on the `GithubClient.CallOptions` interface; wired through `listIssueComments` URL construction. No effect on existing callers.
- **`validateWake` context** — `agentId` and `groupIds` are now required (previously optional). All callers in the codebase updated; a `mkCtx` test helper removes the boilerplate at call sites.
- **Test fixtures genericised** — all signals tests now use a generic `"alpha"` agent identity instead of the EP-specific `"07-wren"`. EP-specific names have no place in `packages/`.

### Internals

- 1097 tests passing across 71 test files (up from 1084 before v0.7.2; 13 new tests).
- Architecture, QA, and security review incorporated: warning on comment fetch failure, accurate count header, `<untrusted-comment>` prompt injection boundary, deleted-comment edge case test, truncation note test, `per_page` on wire.
- Issues closed: [#350](https://github.com/murmurations-ai/murmurations-harness/issues/350), [#353](https://github.com/murmurations-ai/murmurations-harness/issues/353), [#354](https://github.com/murmurations-ai/murmurations-harness/issues/354).

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
