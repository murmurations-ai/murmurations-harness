# Consolidated Execution Plan

**Status:** Active — updated 2026-04-17
**Inputs:** Intelligence Circle architecture review (2026-04-12), MURMURATION-HARNESS-SPEC.md, PHASE-2-PLAN.md, CIRCLE-WAKE-SPEC.md, GITHUB-AS-SYSTEM-OF-RECORD.md
**For:** Coding agents implementing the next phases

---

## Feature Status: What's Done

### Core Runtime ✅
- [x] Daemon with scheduler (cron, delay-once, interval, timezone support)
- [x] Multi-agent auto-discovery from `agents/*/role.md`
- [x] DispatchExecutor (routes to per-agent InProcessExecutor or SubprocessExecutor)
- [x] Identity chain model (murmuration soul → agent soul → role → circle contexts)
- [x] Per-wake WakeCostBuilder → WakeCostRecord → index.jsonl
- [x] RunArtifactWriter (digest files + index.jsonl per agent per day)
- [x] AgentStateStore — formal lifecycle state machine (registered/idle/waking/running/completed/failed/timed-out)

### LLM + GitHub ✅
- [x] 4-provider LLM client (Gemini, Anthropic, OpenAI, Ollama) with pricing catalog
- [x] GitHub client with read + mutation surface (getRef, createCommitOnBranch, createIssue, createIssueComment)
- [x] Write-scope enforcement (ADR-0017 default-deny)
- [x] Per-wake LLM cost hook (makeDaemonHook binds to wake's builder)
- [x] Per-wake GitHub cost hook

### Signal Aggregator ✅
- [x] GitHub issues as signals (configurable scopes per agent)
- [x] Private notes + inbox messages
- [x] Extensible signal sources (custom variant with open string sourceId)
- [x] Governance inbox injection (agent → agent routing)

### Governance ✅
- [x] GovernancePlugin interface (model-agnostic, 5 named models)
- [x] GovernanceStateStore with state machine, review dates, durable persistence
- [x] S3 governance plugin (examples/governance-s3/) with consent enforcement
- [x] Governance event dispatch (agent inbox, source warn, external log)
- [x] Timeout enforcement on governance items
- [x] Decision records (buildDecisionRecord)

### Circle Operations ✅
- [x] Circle Wake Runner (member round + facilitator synthesis)
- [x] Governance meeting consent round tallying
- [x] Circle work queue (murmuration backlog — GitHub-backed)
- [x] Source Directives (murmuration directive CLI — currently file-based, migrating to GitHub)

### CLI ✅
- [x] `murmuration start` (--root, --agent, --dry-run, --once, --governance)
- [x] `murmuration init` (interactive scaffolding)
- [x] `murmuration directive` (Source → agent communication)
- [x] `murmuration circle-wake` (operational + governance meetings)
- [x] `murmuration backlog` (circle work queue)
- [x] `murmuration-dashboard` (TUI with 4 panels)

### Dashboard ✅
- [x] TUI with Agents panel (state, cost bars, countdown, consecutive failures)
- [x] Cost & Wakes sparkline
- [x] Governance panel (pending + recent decisions)
- [x] Activity panel (reads from AgentStateStore)
- [x] Reads from AgentStateStore (not log scraping)

### Security & Reliability ✅
- [x] Path traversal prevention in resolveRolePath
- [x] Signal sanitization (titles, labels, excerpts) before LLM injection
- [x] Subprocess env filtering (blocks LD_PRELOAD, DYLD_*, NODE_OPTIONS)
- [x] Recursive log scrubbing (nested sensitive fields)
- [x] Agent circuit breaker (skip wakes after 3 consecutive failures)
- [x] GovernanceStateStore flush tracks transitions (no race)
- [x] AgentStateStore throws on unknown agentId (no ghost tracking)
- [x] DispatchExecutor.kill() normalizes errors per interface contract
- [x] Date validation on governance item deserialization

### Testing ✅
- [x] 255+ tests across 19 test files
- [x] All passing through `pnpm check` (typecheck + lint + format + test)

---

## What's Next: Execution Phases

### Phase 1 — GitHub as System of Record (PRIORITY)

**Goal:** Move all collaborative state to GitHub. Local disk = runtime only.

| Step | What | Files | Status |
|---|---|---|---|
| 1.1 | **Directives → GitHub issues** | `packages/cli/src/directive.ts` | ✅ DONE |
| | CLI creates issue with `source-directive` + scope labels. DirectiveStore removed. | | |
| 1.2 | **Governance → GitHub issues** | `packages/core/src/governance/github-sync.ts` | ✅ DONE |
| | GovernanceGitHubSync creates issues on item creation, posts comments on transitions. | | |
| 1.3 | **Meeting minutes → GitHub** | `packages/cli/src/circle-wake.ts` | ✅ DONE |
| | Circle meetings post minutes as GitHub issues. | | |
| 1.4 | **Agent outputs → committed files** | shared runner's `commitPathPrefix` option | ✅ DONE |
| | Operator decision — each murmuration chooses its own repo tree layout. | | |
| 1.5 | **Label taxonomy** | `docs/LABEL-TAXONOMY.md` | ✅ DONE (generic) |
| | Operator-defined labels. Harness provides conventions, not enforcement. | | |

**Label taxonomy (from GITHUB-AS-SYSTEM-OF-RECORD.md):**
```
source-directive, scope:all, scope:circle:<id>, scope:agent:<id>
governance:tension, governance:proposal, governance:decision
state:open, state:deliberating, state:consent-round, state:resolved, state:withdrawn, state:ratified, state:rejected
circle:<id> (content, intelligence, publishing, etc.)
agent:<id> (01-research, 02-content-production, etc.)
circle-meeting, governance-meeting
type:content-idea, type:research-digest, stage:*
```

### Phase 2 — Agent Self-Reflection + Self-Organizing Cadence

**Governance-model-agnostic.** The active governance plugin provides the flavor, language, and state machine for all governance interactions. The harness provides the plumbing (events, state store, GitHub sync); the plugin provides the semantics (what events are called, what states exist, how decisions are made). Agents don't need to know which governance model is active — they emit generic governance events and the plugin handles the rest.

| Step | What | Status |
|---|---|---|
| 2.1 | **Self-reflection prompt** — at the end of each wake, the runner asks for: `EFFECTIVENESS` (high/medium/low), `OBSERVATION` (one sentence), `GOVERNANCE_EVENT` (none, or `{ kind, description }`). The `kind` is plugin-defined — S3 uses "tension", Chain of Command uses "report", Meritocratic uses "flag", etc. The runner doesn't know which model is active; it just emits the event. | DONE (in test-murmuration shared-runner.mjs, needs s/TENSION/GOVERNANCE_EVENT/ rename + validation) |
| 2.2 | **Governance event → GitHub issues** — when an agent emits a governance event, the GovernancePlugin creates an item in the state store, and GovernanceGitHubSync creates a GitHub issue with labels from the plugin's state graph (`governance:<kind>`, `state:<initial>`, `agent:<id>`, `circle:<id>`). The issue labels and state transitions are defined by the governance model, not hardcoded. | Ready — Phase 1.2 GovernanceGitHubSync handles this |
| 2.3 | **Cadence self-organization** — agents propose schedule changes via governance events, circles process them through whatever governance model is active (consent round for S3, approval chain for C&C, vote for Parliamentary, etc.). The harness provides the mechanism; the model provides the semantics. | TODO (Source decision pending on Monday switch) |

### Phase 3 — Circle Retrospectives + Strategy Plugin

**Also governance-model-agnostic.** Retrospectives are a circle-wake kind, not tied to S3. Strategy plugins are separate from governance plugins.

| Step | What | Status |
|---|---|---|
| 3.1 | **Circle retrospective** — special circle-wake kind with keep/stop/start output format. Retrospective findings that need structural change are filed as governance events (kind determined by the active plugin). | Specced in CIRCLE-WAKE-SPEC.md |
| 3.2 | **StrategyPlugin interface** — separate from GovernancePlugin. Measures progress (OKR/KPI/North Star/None), suggests priorities, detects alignment drift. Pluggable — each murmuration chooses its measurement framework independently of its governance model. | Specced in CIRCLE-WAKE-SPEC.md |
| 3.3 | OKR plugin example | Not started |
| 3.4 | Dashboard strategy panel | Not started |

### Phase 4 — Web Dashboard

| Step | What | Status |
|---|---|---|
| 4.1 | Extract shared dashboard-data package from dashboard-tui | TODO |
| 4.2 | SSE endpoint on daemon for real-time activity feed | TODO |
| 4.3 | pi-web-ui frontend (same 4 panels) | TODO |
| 4.4 | Remote management (phone/laptop) | TODO |

### Phase 5 — Multi-Instance Murmurations

| Step | What | Status |
|---|---|---|
| 5.1 | `murmuration/harness.yaml` — instance-to-agent assignments | Specced |
| 5.2 | Daemon reads only its assigned agents | TODO |
| 5.3 | Cross-instance signal visibility | TODO (GitHub handles this naturally) |
| 5.4 | Cross-instance circle meetings | TODO |

### Phase 6 — Production Hardening

| Step | What | Status |
|---|---|---|
| 6.1 | Streaming + tool use in `@murmuration/llm` | Not started |
| 6.2 | Server deployment story (systemd / Docker / PM2) | Not started |
| 6.3 | Package publishing (npm) | Not started |
| 6.4 | Template repo for `murmuration init` | Not started |
| 6.5 | CONTRIBUTING guide + first external adopter | Not started |

---

## Closed Issues (this session, 2026-04-17)

| # | Title | Fix |
|---|---|---|
| 32 | Agent circuit breaker | a0e40fe — 3-failure threshold |
| 37 | Sanitize signals for LLM injection | ca25cee |
| 41 | Path traversal in resolveRolePath | 5c1d0ed |
| 42 | Env injection via context.environment | ca25cee |
| 44 | Recursive log scrubbing | ca25cee |
| 46 | GovernanceStateStore flush race | a9c60dd |
| 47 | AgentStateStore ghost transitions | a9c60dd |
| 48 | GovernancePlugin contract tests | dc6a2c9 |
| 49 | GovernanceSyncCallbacks test coverage | dc6a2c9 |
| 51 | DispatchExecutor.kill() error handling | 5c1d0ed |
| 52 | GovernanceStateStore date validation | 5c1d0ed |
| 55 | directive.ts regex parsing | a0e40fe — uses IdentityLoader |
| 56/36 | circle-wake Gemini hardcode | 30bfad1 — reads from role.md |
| 57 | backlog.ts hardcoded repo | a9c60dd |

## Remaining Open Issues

See `gh issue list` for the full list. Key remaining:
- #50: Rename 'circle' to governance-neutral term
- #38: Trust taxonomy enforcement
- #39: Label write-scope enforcement
- #40: Extract GovernanceStateStore interface
- #54: AgentStateStore interface for Phase 4
- #45: Multi-instance governance state (Phase 5)
- #58-61: UX improvements

---

## For Coding Agents

When picking up a task from this plan:
1. Read the relevant spec doc (linked in the phase description)
2. Check `pnpm check` passes before and after
3. Keep library code generic — no EP-specific references in `packages/`
4. GitHub is the system of record — if it's collaborative, it goes in GitHub issues/labels/files, not local disk
5. Agent wake lifecycle is a state machine — transition state at every lifecycle point
6. Test your changes — add specs for new functionality
7. Commit with clear messages following the existing pattern
