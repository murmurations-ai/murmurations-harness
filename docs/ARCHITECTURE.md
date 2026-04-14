# Murmuration Harness Architecture

**Status:** Living document — updated 2026-04-17
**Principle:** The harness exists to help agents do real work, not to facilitate governance theater.

---

## Core Belief

A murmuration's value is measured by what it **ships**, not what it **discusses**. Every agent wake, circle meeting, governance round, and Source directive must produce **artifacts that change the state of the world**:

- A file committed to the repo
- An issue created, labelled, assigned, or closed
- A governance item that changed state
- Content published to a platform
- A metric that moved

If the only output is a text summary that nobody reads, the action was theater — not work. The harness is designed to make real work easy and theater hard.

---

## Architecture Layers

```
┌─────────────────────────────────────────────────────┐
│                   Source (human)                      │
│         Directives, vision, strategy, review          │
├─────────────────────────────────────────────────────┤
│                 GitHub (shared state)                  │
│  Issues (work items, governance, directives, meetings)│
│  Repo tree (committed artifacts, decisions, content)  │
│  Labels (state machine, priorities, assignments)      │
├─────────────────────────────────────────────────────┤
│              Harness Daemon (runtime)                 │
│  Scheduler → Executor → Agent → Artifacts             │
│  AgentStateStore (lifecycle tracking)                 │
│  GovernanceStateStore (governance state machine)      │
│  Signal Aggregator (reads GitHub → feeds agents)      │
├─────────────────────────────────────────────────────┤
│              Governance Plugin (semantics)            │
│  Provides: event kinds, state graphs, language        │
│  Examples: Self-Organizing, Chain of Command,         │
│            Meritocratic, Consensus, Parliamentary     │
├─────────────────────────────────────────────────────┤
│              Strategy Plugin (measurement)            │
│  Provides: objectives, metrics, alignment checks      │
│  Examples: OKR, KPI, North Star, None                 │
├─────────────────────────────────────────────────────┤
│                Dashboard (visibility)                 │
│  TUI → Web → Remote (same data layer)                │
│  Shows: agent state, work output, cost, governance    │
└─────────────────────────────────────────────────────┘
```

---

## GitHub as System of Record

GitHub is the collaboration layer. Everything collaborative lives there — as issues, labels, comments, or committed files. Local `.murmuration/` is for runtime state only.

### What lives in GitHub

| What                     | How                                                                       |
| ------------------------ | ------------------------------------------------------------------------- |
| **Work items**           | Issues with circle/priority/assignment labels                             |
| **Source directives**    | Issues with `source-directive` label                                      |
| **Governance items**     | Issues with `governance:*` + `state:*` labels                             |
| **Meeting outcomes**     | Issues with `circle-meeting` label (decisions, action items, assignments) |
| **Agent artifacts**      | Committed files (digests, drafts, designs, reports)                       |
| **Governance decisions** | Committed files in `governance/decisions/`                                |

### What stays local

| What                | Why                                                  |
| ------------------- | ---------------------------------------------------- |
| Agent runtime state | Which agent is running _right now_ on _this machine_ |
| Cost telemetry      | Too high-frequency for GitHub                        |
| Daemon log          | Operational debug                                    |
| Backlog cache       | Local cache of GitHub issues                         |

### Multi-instance

Multiple harness instances on different machines (with different LLM providers) can participate in the same murmuration by reading from and writing to the same GitHub repo. Local state is per-instance; GitHub state is shared.

---

## Agents Do Real Work

### The "Did Work" Contract

Every agent action type has explicit **output requirements** — what artifacts must be produced for the action to count as "done."

#### Individual Agent Wake

| Output                      | How it's verified                           |
| --------------------------- | ------------------------------------------- |
| **Committed file**          | `createCommitOnBranch` returns a commit OID |
| **Issue created**           | `createIssue` returns an issue number       |
| **Issue labelled/assigned** | `addLabels` / issue comment with assignment |
| **Issue comment**           | `createIssueComment` returns a comment URL  |
| **Governance event filed**  | GovernanceGitHubSync creates a GitHub issue |

The wake summary captures what was produced. The dashboard counts _artifacts_, not _wakes_.

#### Circle Meeting (Operational)

A circle meeting is not done when it produces minutes. It's done when:

| Output requirement         | How                                            |
| -------------------------- | ---------------------------------------------- |
| **Issues prioritized**     | Each discussed issue gets a `priority:*` label |
| **Top items assigned**     | Top 3 issues get assignee labels or comments   |
| **New tasks created**      | Action items become new GitHub issues          |
| **Blocked items flagged**  | Blocked issues get `blocked` label             |
| **Meeting minutes posted** | GitHub issue with structured decisions         |

The circle-wake runner should give the facilitator **write access** to execute these actions — not just produce text describing what should happen.

#### Circle Meeting (Governance)

| Output requirement               | How                                                   |
| -------------------------------- | ----------------------------------------------------- |
| **Each item receives positions** | Issue comments from each member                       |
| **Tally computed**               | Consent/concern/objection counts posted               |
| **State advanced**               | Label swap (`state:consent-round` → `state:ratified`) |
| **Decision record posted**       | Closing comment with review date                      |
| **Item closed or amended**       | Issue closed if ratified, reopened if amended         |

#### Source Directive

| Output requirement               | How                                          |
| -------------------------------- | -------------------------------------------- |
| **Directive issue created**      | GitHub issue with `source-directive` label   |
| **Each targeted agent responds** | Issue comments from agents on their wakes    |
| **Directive resolved**           | Issue closed when all targets have responded |

### Measuring Real Work

The dashboard tracks **work output**, not **activity count**:

| Metric                        | What it measures            |
| ----------------------------- | --------------------------- |
| **Files committed today**     | Agent artifact production   |
| **Issues created/closed**     | Work item throughput        |
| **Issues labelled**           | Prioritization and triage   |
| **Governance items resolved** | Decision-making velocity    |
| **Content published**         | Value delivered to audience |
| **Cost per artifact**         | Efficiency                  |

An agent that runs daily but produces no artifacts is not working — it's idling. The dashboard should make this visible.

### Structured Actions (not prose)

The harness enforces real work by requiring **structured action output** from every action type — not prose that describes what should happen, but machine-readable instructions that the harness executes against GitHub.

#### MeetingAction

Every circle meeting contribution (member round + facilitator synthesis) returns both prose (for the meeting record) and structured actions:

```typescript
interface MeetingAction {
  kind: "label-issue" | "create-issue" | "close-issue" | "comment-issue";
  issueNumber?: number; // for label/close/comment
  label?: string; // for label-issue (e.g. "priority:high", "assigned:01-research")
  removeLabel?: string; // for label-issue (swap, e.g. remove "priority:low")
  title?: string; // for create-issue
  body?: string; // for create-issue or comment-issue
  labels?: string[]; // for create-issue
}

interface MemberContribution {
  content: string; // prose — goes into meeting minutes
  actions: MeetingAction[]; // work — executed against GitHub by the runner
}
```

The facilitator's synthesis produces the **authoritative action list**. The runner executes every action, logs what succeeded, and includes the execution receipt in the meeting minutes.

This means a circle meeting that says "we should prioritize issue #42" must emit `{ kind: "label-issue", issueNumber: 42, label: "priority:high" }`. If it only says it in prose, it didn't happen.

#### Action Items → GitHub Issues

Meetings, directives, and governance rounds frequently produce **action items** — concrete tasks that specific agents, circles, or Source must complete. These are not meeting notes. They are GitHub issues.

Every action item must specify:

- **Who** — an agent ID, circle ID, or "source"
- **What** — a concrete, verifiable deliverable
- **By when** — optional deadline (label or milestone)

The runner creates a GitHub issue for each action item with:

- Title: the deliverable
- Labels: `action-item`, `assigned:<who>`, `circle:<circle>`, optionally `priority:<level>`
- Body: context from the meeting, link back to the meeting minutes issue

Agents see action items on their next wake as GitHub issue signals (labelled `assigned:<agentId>`). They appear in the agent's signal bundle alongside other work items. When the agent completes the work, it closes the issue.

This closes the loop: meeting → action item issue → agent signal → agent work → issue closed.

#### Wake Actions

Individual agent wakes can also return structured actions alongside their digest output. An agent that analyzes the backlog might emit:

```typescript
interface WakeAction {
  kind: "create-issue" | "label-issue" | "comment-issue" | "close-issue" | "commit-file";
  // same fields as MeetingAction, plus:
  filePath?: string; // for commit-file
  fileContent?: string; // for commit-file
}
```

The executor validates actions against the agent's write scopes (ADR-0017) before executing them. An agent can't label issues in a repo it doesn't have write access to.

### "Did Work" Enforcement

The harness tracks whether each action produced real artifacts:

```
Wake completed → count artifacts produced:
  - GitHub API mutations executed (labels, issues, comments, commits)
  - Files committed
  - Governance state transitions

If artifacts == 0:
  → Log as "idle wake" (not "successful wake")
  → Increment idle counter on AgentStateStore
  → Dashboard shows idle wakes distinctly from productive wakes
```

The distinction matters: a "successful" wake that produces no artifacts is **not success** — it's an agent that ran, burned tokens, and changed nothing. The dashboard, the strategy plugin, and Source all need to see this difference.

Over time, the idle-wake ratio per agent tells you which agents are producing value and which are governance theater.

### Post-Wake Validation Hooks

Every agent wake has **defined inputs and expected outputs**. A post-wake validation hook checks whether the agent actually accomplished what it set out to do:

```
Wake starts:
  inputs:  signal bundle (issues, directives, inbox messages)
  intent:  what the agent should produce based on its role + signals

Wake ends:
  outputs: structured actions executed + artifacts produced

Post-wake validation:
  - Did the agent produce the expected artifact type?
  - Were the structured actions actually executed (not just proposed)?
  - Did the output change the state of the world?
  - Was the output relevant to the inputs?
```

The validation hook runs **after** the executor completes and **before** the wake is recorded as "success." It produces a `WakeValidationResult`:

```typescript
interface WakeValidationResult {
  valid: boolean;
  artifactCount: number; // GitHub mutations + commits executed
  expectedOutputKind: string; // e.g. "digest", "draft", "label-update"
  actualOutputKind: string; // what was actually produced
  mismatch?: string; // if valid=false, why
}
```

A wake that runs, produces tokens, but fails validation is recorded as **"idle"** — not "success." The agent burned budget without producing value.

### Feedback Loop: Metrics → Retrospectives → Governance

The validation results feed into a measurable feedback loop:

```
┌──────────────────────────────────────────────────────┐
│                    WORK LOOP                          │
│                                                       │
│  Meeting → Action Items (issues) → Agent Wakes →     │
│  Post-Wake Validation → Metrics                       │
│                                                       │
├──────────────────────────────────────────────────────┤
│                 FEEDBACK LOOP                         │
│                                                       │
│  Metrics → Strategy Plugin → Retrospective →          │
│  Tensions filed → Governance → Structural Change →    │
│  Better meetings / schedules / roles                  │
└──────────────────────────────────────────────────────┘
```

**How it works:**

1. **Metrics accumulate** — per-agent artifact count, idle-wake ratio, cost-per-artifact, action items completed vs created, time-to-close on assigned issues
2. **Strategy plugin surfaces gaps** — "Agent X has 80% idle wakes this week" or "Circle Y created 12 action items but closed 2"
3. **Retrospective consumes metrics** — the circle retrospective wake gets concrete data, not just vibes. "What worked" has numbers. "What didn't" has evidence.
4. **Tensions filed from evidence** — "Research agent produces digests nobody reads" isn't an opinion, it's a metric (0 downstream references). Filed as a governance event.
5. **Governance processes tensions** — the active governance model handles it (consent round for S3, directive for Chain of Command, vote for Parliamentary)
6. **Structural changes result** — agent schedule adjusted, role rewritten, circle membership changed, budget reallocated

This is the self-correction mechanism that prevents governance theater. Without it, agents can underperform indefinitely. With it, every underperformance surfaces as a tension that the system must process.

**Key metrics the strategy plugin tracks:**

| Metric                               | What it reveals                              |
| ------------------------------------ | -------------------------------------------- |
| **Artifact rate** (artifacts/wake)   | Is the agent producing value?                |
| **Idle-wake ratio**                  | How often does the agent run without output? |
| **Action item completion rate**      | Are meetings creating work that gets done?   |
| **Time-to-close on assigned issues** | Is the feedback loop tight or loose?         |
| **Cost per artifact**                | Is the agent efficient?                      |
| **Downstream consumption**           | Does anyone use what this agent produces?    |

These metrics are not vanity — they are the inputs to retrospectives and governance. An agent with a 90% idle-wake ratio will surface as a tension. A circle that creates action items nobody completes will surface as a tension. The system corrects itself through governance, not through Source micromanagement.

### Queryable Work Queue

After a circle meeting executes its actions, the prioritized backlog is **queryable from GitHub**:

```bash
# What's highest priority for the engineering circle?
gh issue list --label "circle:engineering" --label "priority:high" --state open

# What action items are assigned to the research agent?
gh issue list --label "assigned:01-research" --label "action-item" --state open

# What did the content circle decide in its last meeting?
gh issue list --label "circle-meeting" --label "circle:content" --state closed -L 1
```

If you can't answer "what should we work on tomorrow?" with a `gh issue list` command, the meeting didn't do its job.

---

## Governance is Pluggable

The active governance plugin provides:

- **Language** — what events are called (tensions, reports, motions)
- **State machine** — what states exist and valid transitions
- **Decision protocol** — how decisions are made (consent, approval, vote)
- **Review cadence** — when decisions expire and need revisiting

The harness provides:

- **Plumbing** — events, state store, GitHub sync, routing
- **Lifecycle** — creation, transition, persistence, timeout enforcement

Five named models are supported by the interface. Operators choose by providing a plugin at boot.

### Self-Improvement Governance

Agents can propose changes to their own operational configuration through governance. **How much autonomy agents have to self-improve depends on the active governance model** — this is not a universal mechanism, it's a governance decision.

#### What's governed vs. what requires Source

| Change                                          | S3 (Self-Organizing)                     | Chain of Command    | Parliamentary      |
| ----------------------------------------------- | ---------------------------------------- | ------------------- | ------------------ |
| **Prompt refinement** (wake.md)                 | Group consent                            | Authority approval  | Committee vote     |
| **Wake schedule**                               | Group consent                            | Authority approval  | Committee vote     |
| **Tool/capability access**                      | Group consent                            | Authority approval  | Committee vote     |
| **Budget reallocation** (within Source ceiling) | Group consent                            | Authority approval  | Committee vote     |
| **Model tier** (fast→balanced→deep)             | Group consent                            | Authority approval  | Committee vote     |
| **Group membership**                            | Group consent                            | Authority directive | Committee vote     |
| **Upstream/downstream wiring**                  | Group consent                            | Authority directive | Committee vote     |
| **Signal scope changes**                        | Group consent                            | Authority approval  | Committee vote     |
| **New agent creation**                          | Source approves soul; group defines role | Source decides      | Source + committee |
| **Soul changes** (identity, values)             | **Source only**                          | **Source only**     | **Source only**    |
| **Bright line changes**                         | **Source only**                          | **Source only**     | **Source only**    |
| **Governance model changes**                    | **Source only**                          | **Source only**     | **Source only**    |

In S3, groups have significant autonomy to self-organize — they can change operational configuration through consent rounds without Source involvement. In Chain of Command, the same changes require authority approval. In Parliamentary, they require committee votes. The harness provides the mechanism; the governance model determines who decides.

#### Self-improvement mechanisms

The harness supports these self-improvement flows through the governance event system:

1. **Capability requests** — agents see their `capabilities` in the spawn context and file governance events when something is missing
2. **Schedule proposals** — agents see `currentSchedule` and propose changes via governance
3. **Prompt refinement** — agents that consistently underperform propose wake.md changes
4. **Upstream rewiring** — if an agent's output has zero downstream consumption, the group can rewire the pipeline
5. **Budget adjustment** — agents hitting token limits propose increases; the group decides based on cost-per-artifact data
6. **Model tier escalation** — agents on "fast" that need deeper reasoning request "balanced"
7. **Group membership** — agents propose joining or leaving groups based on their effectiveness
8. **New agent proposals** — groups identify capability gaps and propose new agents

All of these flow through the same governance pipeline: agent files event → governance meeting processes it → if approved, configuration is updated. The governance model determines _who approves_ and _how_.

---

## Identity Model

Each agent has a layered identity:

```
murmuration/soul.md       ← shared purpose, bright lines, values
agents/<id>/soul.md        ← agent character, perspective
agents/<id>/role.md        ← operational config (YAML frontmatter + accountabilities)
governance/<groups>/<id>.md ← group context (optional, zero or more)
```

The identity chain flows into the LLM as system prompt. The role.md frontmatter configures the agent's runtime behavior (LLM provider, wake schedule, signal scopes, write scopes, budget, secrets).

### Agent Tooling

Each agent declares the tools, skills, and context sources it needs to do its job. This is part of the identity chain — the agent knows what it can do, and the harness enforces it.

```yaml
# role.md frontmatter
tools:
  cli: # command-line tools available to the agent
    - gh # GitHub CLI
    - gcloud # Google Cloud
  mcp: # MCP servers the agent can use
    - notion # Notion workspace access
    - slack # Slack messaging
    - linear # Linear project management
  skills: # harness-defined capabilities
    - commit # can commit files to the repo
    - label-issue # can add/remove labels
    - create-issue # can create new issues
  context: # additional context sources
    - upstream: ["01-research"] # reads output from these agents
    - docs: ["docs/style-guide.md"] # reference documents
```

**Tooling in the system prompt:** The harness injects the agent's declared tools into its system prompt so the LLM knows what actions are available. An agent without `commit` in its skills won't try to commit files.

**Enforcement:** The executor validates actions against the agent's declared tools before executing them. An agent that tries to use an MCP server it doesn't have access to gets a scope violation, not a silent failure.

**Tool request flow:** When an agent needs a tool it doesn't have, it files a governance event requesting it. The governance model processes the request (consent round for S3, approval for Chain of Command, etc.). If approved, Source updates the agent's role.md. This prevents uncontrolled capability creep while allowing agents to grow their toolset through governance.

**MCP as a tool category:** MCP (Model Context Protocol) servers provide standardized access to external services. Each MCP server is a tool that an agent can be granted access to. The harness manages MCP server lifecycle and routes agent requests through the appropriate server. This means adding a new external service (Notion, Slack, Linear, etc.) is an operator configuration change — not a code change.

---

## Groups / Domains / Circles

The harness currently uses "circle" (S3 terminology) for organizational units. This will be renamed to a governance-neutral term (tracked as harness#50). The concept is generic: a **group of agents that share a domain of work** and can convene for meetings.

Each group has:

- **Members** — agent IDs
- **Facilitator** — the agent that synthesizes meeting output
- **Work queue** — GitHub issues labelled for this group
- **Meeting cadence** — operational + governance schedules

Groups hold two kinds of meetings, each with distinct triggers and outputs:

### Operational Meetings

**Purpose:** Plan and assign work. Process the backlog, prioritize, create action items.

**Trigger:** Scheduled cadence (e.g. daily, weekly) defined in circle config.

**Output:** GitHub state changes — priority labels on issues, action items created and assigned to agents, blocked items flagged. These populate the work queue that agents read on their next individual wake.

**The loop:** Operational meeting → labels + action items → agent wakes → agent executes → next meeting reviews progress.

### Governance Meetings

**Purpose:** Change how the circle operates. Process tensions, proposals, and structural decisions through the active governance model.

**Triggers:** Both scheduled and demand-driven:

- **Scheduled** — governance cadence defined in circle config (e.g. weekly). The meeting automatically picks up all tensions and proposals that accumulated since the last governance meeting.
- **Demand (Source-initiated)** — Source convenes an ad-hoc governance meeting via `murmuration circle-wake --governance` or a directive. Used for urgent structural decisions.
- **Review-triggered** — ratified decisions with expired review dates surface automatically for re-evaluation.

**Output:** State transitions on governance items (label swaps on GitHub issues), decision records, role/policy changes, amended proposals. The governance plugin defines the specific states and transitions.

**Governance queue:** The daemon tracks pending governance items per circle. Scheduled governance meetings consume the full queue. Demand meetings can target specific items.

### Meeting ↔ Individual Wake Separation

Agents participate in two distinct modes (tracked via `WakeMode`):

- **Meeting mode** (`circle-member` / `circle-facilitator`) — contribute perspective, synthesize, don't execute action items
- **Individual mode** (`individual`) — execute action items, produce artifacts, do role-specific work

This separation is important: an agent in a governance meeting should deliberate, not execute. An agent in an individual wake should execute, not deliberate. The harness enforces this via `WakeMode` on the spawn context.

---

## Signal Flow

```
GitHub issues → Signal Aggregator → Agent signals
                                  → Source directives (labelled issues)
                                  → Governance inbox (routed events)

Agent output → Committed files → Available to downstream agents
            → Issue comments → Visible to all
            → Governance events → Plugin → GitHub issue creation
```

Agents read from GitHub and write to GitHub. The harness routes and tracks.

---

## Cost & Budget

Every LLM call and GitHub API call is tracked per-wake via `WakeCostBuilder`. The pricing catalog (`@murmuration/llm/pricing`) resolves tokens to USD micros.

Each agent declares a budget ceiling in `role.md`:

```yaml
budget:
  max_cost_micros: 500000 # 50¢ per wake
  max_github_api_calls: 100
  on_breach: "abort" # or "warn"
```

The dashboard shows cost per agent, per day, per wake. The strategy plugin (when implemented) correlates cost with artifact production to measure efficiency.

---

## Engineering Standards

These standards were learned from real architectural gaps that accumulated during rapid prototyping. Each one traces to a specific class of bugs. Follow them to avoid repeating the same mistakes.

### 1. Fix root causes, not symptoms

When a bug or missing feature surfaces, trace back to the architectural gap. If a fix requires touching 3+ places or adding client-side workarounds for server-side gaps, that's a signal the architecture needs adjustment. Take time to get the design right. There is no rush.

**Anti-pattern:** Client-side `convenedItems` JS object to track meeting state because the server doesn't.
**Fix:** Server-side meeting state in DaemonCommandExecutor, pushed via SSE events.

### 2. Every async operation returns a typed result

Functions that do meaningful work must return structured results — never `void`. The caller decides what to do with the result (log it, emit events, update state). Console.log is for CLI display, not for communicating outcomes between modules.

**Anti-pattern:** `runGroupWakeCommand` returns `Promise<void>` and prints results to stdout.
**Fix:** Return `GroupWakeResult` with tallies, receipts, meeting URL. CLI prints it; daemon processes it.

### 3. Single owner for mutable state

Each piece of mutable state (governance JSONL, agent state JSON, meeting status) has exactly one writer. No two modules independently load, mutate, and persist the same file. If multiple modules need to read state, one owns writes and the others read through it.

**Anti-pattern:** Both daemon and `group-wake.ts` independently instantiate `GovernanceStateStore` and write to the same JSONL.
**Fix:** Daemon owns governance transitions. `group-wake` returns results; daemon applies transitions.

### 4. Events over polling

When state changes, emit an event. Don't make consumers poll to discover it. The `DaemonEventBus` is the mechanism. SSE streams forward events to browser clients. The socket broadcasts to CLI/TUI clients.

**Anti-pattern:** Dashboard polls `/api/status` every 10 seconds to detect meeting completion.
**Fix:** Daemon emits `meeting.completed` event → SSE pushes to dashboard → immediate UI update.

### 5. No inline HTML/JS in TypeScript

Presentation code (HTML, CSS, JavaScript) lives in its own files with proper syntax highlighting and linting. TypeScript modules serve static files; they don't contain them as template literals. String concatenation to build HTML with user data is an XSS risk and impossible to test.

**Anti-pattern:** 430-line `DASHBOARD_HTML` template literal inside `http.ts`.
**Fix:** `dashboard.html` as a static file, loaded once at server start, served by the HTTP module.

### 6. Typed errors, not process.exit()

Library functions throw typed errors. Only the CLI entry point (bin.ts) calls `process.exit()`. A library function that calls `process.exit()` will kill the daemon if invoked from the HTTP handler.

**Anti-pattern:** `runGroupWakeCommand` calls `process.exit(1)` on missing config.
**Fix:** Throw `GroupWakeError` with a code. CLI catches and exits; daemon catches and logs.

### 7. Track what you spawn

Every child process or background task must be tracked by the daemon. Attach exit handlers before detaching. Record the outcome (exit code, duration) in the state store. If the dashboard triggers an action, the dashboard must be able to query whether it succeeded.

**Anti-pattern:** `child.unref()` on wake-now with no exit handler. Dashboard shows "waking" forever.
**Fix:** `child.on("exit", ...)` before `unref()`. Store outcome in `#wakeProcesses` map. Dashboard reads from status response.

### 8. Composition root stays thin

`boot.ts` is the composition root — it wires dependencies together and starts the daemon. It should not contain business logic, status computation, command handling, or governance state reading. Extract those into classes with clear interfaces that can be tested in isolation.

**Anti-pattern:** 1500-line `boot.ts` with inline closures capturing 10+ variables from outer scope.
**Fix:** `DaemonCommandExecutor` class with injected dependencies. boot.ts instantiates and wires.

### 9. Silent error swallowing is a bug

Empty catch blocks (`catch { /* best effort */ }`) hide real failures. If an error can happen, either handle it with a specific recovery, propagate it, or log it with context. "Best effort" is acceptable for non-critical cleanup, but state-loading failures must be visible.

**Anti-pattern:** `await agentStateStore.load().catch(() => { /* best effort */ })` — dashboard shows stale data with no indication.
**Fix:** Log the error. If the load fails, include a `stale: true` flag in the status response so the dashboard can warn.

### 10. Status response is a typed contract

The `/api/status` response shape is a public API consumed by the web dashboard, TUI, and future external tools. Define it as a TypeScript interface. Don't compute it with ad-hoc object literals scattered across closures.

---

## What We Don't Build

- **No custom UI framework** — TUI uses blessed, web uses vanilla HTML/JS
- **No custom database** — GitHub issues + JSONL files + JSON state files
- **No custom auth** — GitHub fine-grained PATs
- **No custom communication** — GitHub issues and comments
- **No agent marketplace** — operators define their own agents in their repo
- **No SaaS** — the harness runs on the operator's machine, reading their repo
