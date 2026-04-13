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

### Security & Reliability ✅

- [x] Path traversal prevention in resolveRolePath
- [x] Signal sanitization (titles, labels, excerpts) before LLM injection
- [x] Subprocess env filtering (blocks LD*PRELOAD, DYLD*\*, NODE_OPTIONS)
- [x] Recursive log scrubbing (nested sensitive fields)
- [x] Agent circuit breaker (skip wakes after 3 consecutive failures)
- [x] GovernanceStateStore flush tracks transitions (no race)
- [x] AgentStateStore throws on unknown agentId (no ghost tracking)
- [x] DispatchExecutor.kill() normalizes errors per interface contract
- [x] Date validation on governance item deserialization

### Testing ✅

- [x] 293 tests across 20 test files
- [x] All passing through `pnpm check` (typecheck + lint + format + test)
- [x] CI green on Node 20.x and 22.x

---

## What's Next: Execution Phases

### Phase 1 — GitHub as System of Record (PRIORITY)

**Goal:** Move all collaborative state to GitHub. Local disk = runtime only.

| Step | What                                                                                 | Files                                         | Status            |
| ---- | ------------------------------------------------------------------------------------ | --------------------------------------------- | ----------------- |
| 1.1  | **Directives → GitHub issues**                                                       | `packages/cli/src/directive.ts`               | ✅ DONE           |
|      | CLI creates issue with `source-directive` + scope labels. DirectiveStore removed.    |                                               |                   |
| 1.2  | **Governance → GitHub issues**                                                       | `packages/core/src/governance/github-sync.ts` | ✅ DONE           |
|      | GovernanceGitHubSync creates issues on item creation, posts comments on transitions. |                                               |                   |
| 1.3  | **Meeting minutes → GitHub**                                                         | `packages/cli/src/circle-wake.ts`             | ✅ DONE           |
|      | Circle meetings post minutes as GitHub issues.                                       |                                               |                   |
| 1.4  | **Agent outputs → committed files**                                                  | shared runner's `commitPathPrefix` option     | ✅ DONE           |
|      | Operator decision — each murmuration chooses its own repo tree layout.               |                                               |                   |
| 1.5  | **Label taxonomy**                                                                   | `docs/LABEL-TAXONOMY.md`                      | ✅ DONE (generic) |
|      | Operator-defined labels. Harness provides conventions, not enforcement.              |                                               |                   |

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

### Phase 2 — Structured Actions: Agents Do Real Work (PRIORITY)

**The most critical gap in the harness.** Currently, meetings and wakes produce prose. They need to produce structured actions that the harness executes against GitHub. Without this, everything is governance theater.

**Principle:** If the only output is text, it didn't happen. Every action must produce queryable state changes in GitHub.

| Step | What                                                                                                                                                                      | Files                                       | Status         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | -------------- |
| 2.1  | **MeetingAction type + parser**                                                                                                                                           | `packages/core/src/groups/index.ts`         | ✅ DONE        |
|      | Define `MeetingAction` interface (label-issue, create-issue, close-issue, comment-issue)                                                                                  |                                             |                |
|      | LLM prompt instructs facilitator to return JSON action block alongside prose                                                                                              |                                             |                |
|      | Parse actions from facilitator output (structured JSON block)                                                                                                             |                                             |                |
| 2.2  | **Action execution in group-wake**                                                                                                                                        | `packages/cli/src/group-wake.ts`            | ✅ DONE        |
|      | Runner receives GitHub client with write access                                                                                                                           |                                             |                |
|      | After facilitator synthesis, execute each MeetingAction against GitHub                                                                                                    |                                             |                |
|      | Log execution receipts (success/failure per action)                                                                                                                       |                                             |                |
|      | Include receipts in meeting minutes issue                                                                                                                                 |                                             |                |
| 2.3  | **Action items → GitHub issues**                                                                                                                                          | built into 2.2                              | ✅ DONE        |
|      | Meetings create GitHub issues for each action item                                                                                                                        |                                             |                |
|      | Labels: `action-item`, `assigned:<agent-id>` or `assigned:<circle-id>` or `assigned:source`                                                                               |                                             |                |
|      | Body links back to the meeting minutes issue                                                                                                                              |                                             |                |
|      | Agents see action items as signals on their next wake                                                                                                                     |                                             |                |
| 2.4  | **WakeAction type + executor**                                                                                                                                            | `packages/core/src/execution/index.ts`      | ✅ DONE        |
|      | Define `WakeAction` interface for individual agent wakes                                                                                                                  |                                             |                |
|      | Agent runners return `{ wakeSummary, actions? }`                                                                                                                          |                                             |                |
|      | InProcessExecutor validates actions against write scopes (ADR-0017)                                                                                                       |                                             |                |
|      | Execute valid actions, reject scope violations                                                                                                                            |                                             |                |
| 2.5  | **"Did Work" tracking**                                                                                                                                                   | `packages/core/src/agents/index.ts`, daemon | ✅ DONE        |
|      | Count artifacts produced per wake (mutations, commits, state transitions)                                                                                                 |                                             |                |
|      | AgentStateStore tracks `artifactCount` + `idleWakes` per agent                                                                                                            |                                             |                |
|      | Dashboard distinguishes productive wakes from idle wakes                                                                                                                  |                                             |                |
|      | Strategy plugin (Phase 4) uses artifact rate as efficiency metric                                                                                                         |                                             |                |
| 2.6  | **Governance round actions**                                                                                                                                              | groups/index.ts, group-wake.ts              | ✅ DONE        |
|      | Governance meetings execute state transitions (label swaps on GitHub issues)                                                                                              |                                             |                |
|      | Consent round → ratified = issue closed + decision record committed                                                                                                       |                                             |                |
|      | Positions posted as structured comments, not just prose                                                                                                                   |                                             |                |
| 2.7  | **Queryable work queue**                                                                                                                                                  | Labels + conventions                        | ✅ DONE        |
|      | After meetings, `gh issue list --label priority:high --label circle:X` returns work                                                                                       |                                             |                |
|      | `gh issue list --label action-item --label assigned:01-research` returns agent tasks                                                                                      |                                             |                |
|      | Document the query patterns in LABEL-TAXONOMY.md                                                                                                                          |                                             |                |
| 2.8  | **Post-wake validation hooks**                                                                                                                                            | execution/index.ts, daemon                  | ✅ DONE        |
|      | Validation hook runs after executor completes, before recording "success"                                                                                                 |                                             |                |
|      | Checks: did the agent produce artifacts? Were actions executed?                                                                                                           |                                             |                |
|      | `WakeValidationResult` with artifactCount, expectedOutputKind, valid flag                                                                                                 |                                             |                |
|      | Idle wakes (valid=false) increment `idleWakes` counter, not `successfulWakes`                                                                                             |                                             |                |
| 2.9  | **Metrics → retrospective loop**                                                                                                                                          | Design done, impl Phase 4                   | ✅ DESIGN DONE |
|      | Strategy plugin surfaces per-agent metrics (artifact rate, idle-wake ratio, cost/artifact)                                                                                |                                             |                |
|      | Retrospective wake consumes metrics as concrete data (not vibes)                                                                                                          |                                             |                |
|      | Evidence-based tensions filed → governance processes them → structural changes result                                                                                     |                                             |                |
|      | Closes the self-correction loop: underperformance → tension → governance → improvement                                                                                    |                                             |                |
| 2.10 | **Scheduled governance meetings**                                                                                                                                         | daemon/index.ts, boot.ts                    | ✅ DONE        |
|      | Circle config declares governance cadence (e.g. `governance_cron: "0 18 * * 5"` for weekly Friday)                                                                        |                                             |                |
|      | Daemon checks governance queue per circle — if items pending + cadence fires, convenes governance meeting                                                                 |                                             |                |
|      | Source can demand ad-hoc governance via `murmuration circle-wake --governance` or directive                                                                               |                                             |                |
|      | Governance meeting auto-consumes all pending tensions/proposals since last meeting                                                                                        |                                             |                |
|      | Review-triggered: daemon checks `reviewAt` on ratified decisions per circle; expired reviews are added to the governance queue and trigger a meeting if none is scheduled |                                             |                |
|      | Three governance triggers: (1) scheduled cadence, (2) Source demand, (3) agreement review dates                                                                           |                                             |                |
|      | Governance plugin defines the state machine; harness provides the scheduling + queue drain                                                                                |                                             |                |

**Label conventions for structured actions:**

```
priority:critical, priority:high, priority:medium, priority:low
assigned:<agent-id>           (e.g. assigned:01-research)
assigned:<circle-id>          (e.g. assigned:engineering)
assigned:source
action-item
blocked
```

### Phase 3 — Agent Self-Reflection + Self-Organizing Cadence

**Governance-model-agnostic.** The active governance plugin provides the flavor, language, and state machine for all governance interactions. The harness provides the plumbing (events, state store, GitHub sync); the plugin provides the semantics (what events are called, what states exist, how decisions are made). Agents don't need to know which governance model is active — they emit generic governance events and the plugin handles the rest.

| Step | What                                                                                                                                                                                                       | Status  |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 3.1  | **Self-reflection prompt** — EFFECTIVENESS/OBSERVATION/GOVERNANCE_EVENT. Renamed from TENSION. `parseSelfReflection()` in harness core. Generic `agent-governance-event` kind (plugin maps to model term). | ✅ DONE |
| 3.2  | **Governance event → GitHub issues** — GovernanceGitHubSync creates issues on item creation, posts comments on transitions. Wired end-to-end.                                                              | ✅ DONE |
| 3.3  | **Cadence self-organization** — agents propose schedule changes via governance events.                                                                                                                     | TODO    |

### Phase 4 — Circle Retrospectives + Strategy Plugin

**Also governance-model-agnostic.** Retrospectives are a circle-wake kind, not tied to S3. Strategy plugins are separate from governance plugins.

| Step | What                                                                                                                                                                                                                                                            | Status                         |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 4.1  | **Circle retrospective** — special circle-wake kind with keep/stop/start output format. Retrospective findings that need structural change are filed as governance events (kind determined by the active plugin).                                               | Specced in CIRCLE-WAKE-SPEC.md |
| 4.2  | **StrategyPlugin interface** — separate from GovernancePlugin. Measures progress (OKR/KPI/North Star/None), suggests priorities, detects alignment drift. Pluggable — each murmuration chooses its measurement framework independently of its governance model. | Specced in CIRCLE-WAKE-SPEC.md |
| 4.3  | OKR plugin example                                                                                                                                                                                                                                              | Not started                    |
| 4.4  | Dashboard strategy panel                                                                                                                                                                                                                                        | Not started                    |

### Phase 5 — Session Manager + Web Dashboard

**The operator's daily interface.** Three interfaces on one data layer: TUI (terminal), REPL (interactive attach), Web (browser/phone). All connect through the daemon socket.

| Step | What                                                                                                                       | Status |
| ---- | -------------------------------------------------------------------------------------------------------------------------- | ------ |
| 5.1  | **Session registry** — `~/.murmuration/sessions.json`, `murmuration register/unregister/list`, `--name` alias for `--root` | TODO   |
| 5.2  | **Daemon socket** — Unix domain socket at `.murmuration/daemon.sock`, JSON-RPC protocol for commands + streaming           | TODO   |
| 5.3  | **Attach REPL** — `murmuration attach <name>`, leader key (Ctrl-M), interactive command dispatch, detach/switch            | TODO   |
| 5.4  | **TUI → socket client** — migrate dashboard-tui from direct AgentStateStore reference to daemon socket client              | TODO   |
| 5.5  | Extract shared dashboard-data package (consumed by TUI, REPL, and web)                                                     | TODO   |
| 5.6  | SSE bridge from daemon socket → web clients                                                                                | TODO   |
| 5.7  | pi-web-ui frontend (same 4 panels as TUI)                                                                                  | TODO   |
| 5.8  | Remote management (phone/laptop)                                                                                           | TODO   |

### Phase 6 — Multi-Instance Murmurations

**Multiple daemons in the same murmuration** (different machines, different LLM providers). The session manager handles multiple murmurations on one operator's machine; multi-instance handles multiple daemons in one murmuration.

| Step | What                                                       | Status                               |
| ---- | ---------------------------------------------------------- | ------------------------------------ |
| 6.1  | `murmuration/harness.yaml` — instance-to-agent assignments | Specced                              |
| 6.2  | Daemon reads only its assigned agents                      | TODO                                 |
| 6.3  | Cross-instance signal visibility                           | TODO (GitHub handles this naturally) |
| 6.4  | Cross-instance group meetings                              | TODO                                 |

### Phase 7 — Production Hardening

| Step | What                                             | Status      |
| ---- | ------------------------------------------------ | ----------- |
| 7.1  | Streaming + tool use in `@murmuration/llm`       | Not started |
| 7.2  | Server deployment story (systemd / Docker / PM2) | Not started |
| 7.3  | Package publishing (npm)                         | Not started |
| 7.4  | Template repo for `murmuration init`             | Not started |
| 7.5  | CONTRIBUTING guide + first external adopter      | Not started |

---

## Closed Issues (this session, 2026-04-17)

| #     | Title                                  | Fix                           |
| ----- | -------------------------------------- | ----------------------------- |
| 32    | Agent circuit breaker                  | a0e40fe — 3-failure threshold |
| 37    | Sanitize signals for LLM injection     | ca25cee                       |
| 41    | Path traversal in resolveRolePath      | 5c1d0ed                       |
| 42    | Env injection via context.environment  | ca25cee                       |
| 44    | Recursive log scrubbing                | ca25cee                       |
| 46    | GovernanceStateStore flush race        | a9c60dd                       |
| 47    | AgentStateStore ghost transitions      | a9c60dd                       |
| 48    | GovernancePlugin contract tests        | dc6a2c9                       |
| 49    | GovernanceSyncCallbacks test coverage  | dc6a2c9                       |
| 51    | DispatchExecutor.kill() error handling | 5c1d0ed                       |
| 52    | GovernanceStateStore date validation   | 5c1d0ed                       |
| 55    | directive.ts regex parsing             | a0e40fe — uses IdentityLoader |
| 56/36 | circle-wake Gemini hardcode            | 30bfad1 — reads from role.md  |
| 57    | backlog.ts hardcoded repo              | a9c60dd                       |

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
