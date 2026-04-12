# Consolidated Execution Plan

**Status:** Active — updated 2026-04-12
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

### Testing ✅
- [x] 244+ tests across 19 test files
- [x] All passing through `pnpm check` (typecheck + lint + format + test)

---

## What's Next: Execution Phases

### Phase 1 — GitHub as System of Record (PRIORITY)

**Goal:** Move all collaborative state to GitHub. Local disk = runtime only.

| Step | What | Files | Status |
|---|---|---|---|
| 1.1 | **Directives → GitHub issues** | `packages/cli/src/directive.ts`, `packages/core/src/directives/` | TODO |
| | CLI creates issue with `source-directive` + scope labels | | |
| | Remove DirectiveStore, remove daemon directive injection | | |
| | Signal aggregator already surfaces labelled issues as signals | | |
| 1.2 | **Governance → GitHub issues** | `packages/core/src/governance/index.ts` | TODO |
| | GovernanceStateStore reads/writes via GitHub issues | | |
| | State transitions = label swaps + issue comments | | |
| | Consent rounds = structured comments | | |
| | Decision records = closing comments | | |
| 1.3 | **Meeting minutes → GitHub** | `packages/cli/src/circle-wake.ts` | TODO |
| | Circle meetings create issues or commit files | | |
| | Action items from meetings → separate issues | | |
| 1.4 | **Agent outputs → committed files** | shared runner's `commitPathPrefix` option | PARTIAL |
| | Each agent's role.md or runner config declares where it commits artifacts | | |
| | The shared runner's `commitPathPrefix` already supports this — extend to all artifact-producing agents | | |
| | The specific folder structure is an operator decision, not a harness decision — each murmuration chooses its own repo tree layout (see repo tree section in GITHUB-AS-SYSTEM-OF-RECORD.md) | | |
| 1.5 | **Label taxonomy** | `docs/LABEL-TAXONOMY.md` | TODO |
| | Publish the canonical label set | | |

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

| Step | What | Status |
|---|---|---|
| 2.1 | Self-reflection prompt in shared runner (effectiveness/observation/tension) | DONE (in test-murmuration shared-runner.mjs, needs validation) |
| 2.2 | Tension filing via governance events → GitHub issues | Depends on 1.2 |
| 2.3 | Monday cadence switch — content pipeline agents move to weekly per their own proposal | TODO (Source decision pending) |

### Phase 3 — Circle Retrospectives + Strategy Plugin

| Step | What | Status |
|---|---|---|
| 3.1 | Circle retrospective as a special circle-wake kind (keep/stop/start/tension) | Specced in CIRCLE-WAKE-SPEC.md |
| 3.2 | StrategyPlugin interface (OKR/KPI/North Star/None) | Specced in CIRCLE-WAKE-SPEC.md |
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

## Open Issues (harness repo)

| # | Title | Phase |
|---|---|---|
| 25 | Wire per-wake GitHub cost hook | ✅ Done |
| 26 | DotenvSecretsProvider warn on malformed .env | ✅ Done |
| 27 | Phase 2E gate — dual-run week | Active (daily digests accumulating) |
| 29 | AgentStateStore | ✅ Done |
| 30 | Raise token ceilings + truncation detection | ✅ Ceilings raised; adaptive detection TODO |

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
