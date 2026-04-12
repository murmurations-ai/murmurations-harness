# Murmuration Harness Architecture

**Status:** Living document — updated as the architecture evolves
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

| What | How |
|---|---|
| **Work items** | Issues with circle/priority/assignment labels |
| **Source directives** | Issues with `source-directive` label |
| **Governance items** | Issues with `governance:*` + `state:*` labels |
| **Meeting outcomes** | Issues with `circle-meeting` label (decisions, action items, assignments) |
| **Agent artifacts** | Committed files (digests, drafts, designs, reports) |
| **Governance decisions** | Committed files in `governance/decisions/` |

### What stays local

| What | Why |
|---|---|
| Agent runtime state | Which agent is running *right now* on *this machine* |
| Cost telemetry | Too high-frequency for GitHub |
| Daemon log | Operational debug |
| Backlog cache | Local cache of GitHub issues |

### Multi-instance

Multiple harness instances on different machines (with different LLM providers) can participate in the same murmuration by reading from and writing to the same GitHub repo. Local state is per-instance; GitHub state is shared.

---

## Agents Do Real Work

### The "Did Work" Contract

Every agent action type has explicit **output requirements** — what artifacts must be produced for the action to count as "done."

#### Individual Agent Wake

| Output | How it's verified |
|---|---|
| **Committed file** | `createCommitOnBranch` returns a commit OID |
| **Issue created** | `createIssue` returns an issue number |
| **Issue labelled/assigned** | `addLabels` / issue comment with assignment |
| **Issue comment** | `createIssueComment` returns a comment URL |
| **Governance event filed** | GovernanceGitHubSync creates a GitHub issue |

The wake summary captures what was produced. The dashboard counts *artifacts*, not *wakes*.

#### Circle Meeting (Operational)

A circle meeting is not done when it produces minutes. It's done when:

| Output requirement | How |
|---|---|
| **Issues prioritized** | Each discussed issue gets a `priority:*` label |
| **Top items assigned** | Top 3 issues get assignee labels or comments |
| **New tasks created** | Action items become new GitHub issues |
| **Blocked items flagged** | Blocked issues get `blocked` label |
| **Meeting minutes posted** | GitHub issue with structured decisions |

The circle-wake runner should give the facilitator **write access** to execute these actions — not just produce text describing what should happen.

#### Circle Meeting (Governance)

| Output requirement | How |
|---|---|
| **Each item receives positions** | Issue comments from each member |
| **Tally computed** | Consent/concern/objection counts posted |
| **State advanced** | Label swap (`state:consent-round` → `state:ratified`) |
| **Decision record posted** | Closing comment with review date |
| **Item closed or amended** | Issue closed if ratified, reopened if amended |

#### Source Directive

| Output requirement | How |
|---|---|
| **Directive issue created** | GitHub issue with `source-directive` label |
| **Each targeted agent responds** | Issue comments from agents on their wakes |
| **Directive resolved** | Issue closed when all targets have responded |

### Measuring Real Work

The dashboard tracks **work output**, not **activity count**:

| Metric | What it measures |
|---|---|
| **Files committed today** | Agent artifact production |
| **Issues created/closed** | Work item throughput |
| **Issues labelled** | Prioritization and triage |
| **Governance items resolved** | Decision-making velocity |
| **Content published** | Value delivered to audience |
| **Cost per artifact** | Efficiency |

An agent that runs daily but produces no artifacts is not working — it's idling. The dashboard should make this visible.

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

---

## Groups / Domains / Circles

The harness currently uses "circle" (S3 terminology) for organizational units. This will be renamed to a governance-neutral term (tracked as harness#50). The concept is generic: a **group of agents that share a domain of work** and can convene for meetings.

Each group has:
- **Members** — agent IDs
- **Facilitator** — the agent that synthesizes meeting output
- **Work queue** — GitHub issues labelled for this group
- **Meeting cadence** — operational + governance schedules

Groups can hold two kinds of meetings:
- **Operational** — process backlog, prioritize, plan, assign, retrospect
- **Governance** — process governance items through the active governance model

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
  max_cost_micros: 500000    # 50¢ per wake
  max_github_api_calls: 100
  on_breach: "abort"         # or "warn"
```

The dashboard shows cost per agent, per day, per wake. The strategy plugin (when implemented) correlates cost with artifact production to measure efficiency.

---

## What We Don't Build

- **No custom UI framework** — TUI uses pi-tui, web uses pi-web-ui
- **No custom database** — GitHub issues + JSONL files + JSON state files
- **No custom auth** — GitHub fine-grained PATs
- **No custom communication** — GitHub issues and comments
- **No agent marketplace** — operators define their own agents in their repo
- **No SaaS** — the harness runs on the operator's machine, reading their repo
