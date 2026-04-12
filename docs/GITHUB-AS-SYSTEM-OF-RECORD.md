# GitHub as System of Record — Architecture Spec

**Status:** Draft — awaiting Source review
**Author:** Source + Claude Code, 2026-04-11
**Principle:** GitHub is the system of record for everything collaborative. Local disk is for runtime state and telemetry only.

---

## The Pattern

A murmuration collaborates through GitHub. Every piece of information that any agent, any harness instance, or any human needs to see lives in GitHub — as issues, comments, labels, or committed files. Local `.murmuration/` directories are ephemeral runtime caches that can be rebuilt from GitHub state.

This enables:
- **Multi-instance murmurations** — multiple harness processes on different machines running different subsets of agents, all coordinating through the same GitHub repo
- **Human-agent parity** — Source sees the same issues, labels, and comments that agents see
- **Resilience** — a harness crash loses only local runtime state; all collaborative state survives in GitHub
- **Auditability** — every directive, governance decision, and meeting outcome has a GitHub URL
- **Cross-provider collaboration** — Harness A uses Gemini, Harness B uses Claude, they coordinate through GitHub issues

## What moves to GitHub

### 1. Source Directives → GitHub Issues

**Before:** `.murmuration/directives/<id>.json` — local files only visible to the local daemon
**After:** GitHub issues with labels

```
Title: [DIRECTIVE] Should circles hold regular meetings?
Labels: source-directive, scope:all
Body:
  **From:** Source
  **Scope:** All agents
  **Kind:** question

  Should your circle hold regular meetings? What would you discuss,
  how often, who facilitates?
```

**Scoped directives** use additional labels:
- `scope:all` — every agent responds
- `scope:circle:content` — only Content Circle members
- `scope:agent:01-research` — only Research Agent

**Agent responses** are issue comments. The issue stays open until all targeted agents have responded, then auto-closes.

**CLI:** `murmuration directive --all "question"` creates the GitHub issue.

### 2. Governance Items → GitHub Issues

**Before:** `.murmuration/governance/items.jsonl` — local JSONL file
**After:** GitHub issues with label-based state tracking

```
Title: [TENSION] Signal aggregator returns empty bundles when GITHUB_TOKEN is missing
Labels: governance:tension, state:open, circle:intelligence, filed-by:01-research
Body:
  **Filed by:** Research Agent (#1)
  **Circle:** Intelligence
  **Driver:** [observable situation + effect on purpose]
```

**State machine via labels:**
- `state:open` → `state:deliberating` → `state:consent-round` → `state:resolved`
- The GovernanceStateStore reads issue labels to determine current state
- Transitions happen by swapping labels (remove old, add new) + posting a comment explaining the transition
- This is visible to everyone — humans, agents, other harness instances

**Consent rounds** are issue comments:
```
### 02-content-production — consent
✅ Consent — aligns with our priorities.

### 08-editorial — concern
⚠️ Concern — monitoring needed but not blocking.

### 10-quality — consent
✅ Consent — no objections.
```

**Decision records** are posted as a final comment + the issue is closed:
```
## Decision Record
**State:** resolved
**Decided:** 2026-04-11
**Review date:** 2026-07-10 (90 days)
**Summary:** [what was decided]
```

### 3. Meeting Minutes → GitHub Issues or Committed Files

**Before:** `.murmuration/runs/circle-<id>/<date>/meeting-*.md` — local files
**After:** Either:
- **GitHub issue** with label `circle-meeting` + circle label — good for operational meetings with action items
- **Committed file** at `governance/meetings/<circle>/<date>.md` — good for decisions that need to persist in the repo

### 4. Agent Outputs → Committed Files (already happening)

Research Agent commits to `notes/weekly/`, Content Production commits to `drafts/articles/`. This pattern extends to any agent that produces durable artifacts.

## Repo Tree as Shared Workspace

The GitHub repo tree is the murmuration's shared workspace. Issues coordinate work; the repo stores the artifacts. Every agent commits its work product to the appropriate directory, and issues reference files by path.

**The specific folder structure is an operator decision.** Each murmuration chooses the layout that best serves its agents, circles, and Source. The harness provides the `commitPathPrefix` mechanism; the operator (or the murmuration itself via governance) decides the tree. Examples:

- **By function:** `notes/`, `drafts/`, `designs/`, `analytics/`
- **By circle:** `circles/content/`, `circles/intelligence/`
- **By agent:** `agents/01-research/output/`, `agents/02-content/output/`
- **PARA method:** `projects/`, `areas/`, `resources/`, `archives/`
- **Custom:** whatever the murmuration decides

A good first governance directive for any new murmuration: "What folder structure will best serve all agents, their roles, and Source?"

**Example layout (not prescriptive):**
```
my-murmuration/
  murmuration/soul.md                      ← identity
  agents/*/role.md                          ← agent config
  governance/
    circles/*.md                            ← circle docs
    decisions/<id>.md                       ← ratified governance decisions
    meetings/<circle>/<date>.md             ← circle meeting minutes
  notes/
    daily/<date>.md                         ← daily chronicles (Chronicler)
    weekly/<date>-research-digest.md        ← Research digests
  drafts/
    articles/<date>-<slug>.md              ← Content Production drafts
    courses/                                ← course materials
  content/                                  ← published content
  designs/
    briefs/<date>-<slug>.md                ← Design Agent briefs
    assets/                                 ← visual assets
  analytics/
    reports/<date>.md                       ← Analytics reports
    cost-summaries/<week>.md               ← CFO weekly cost reports
```

Git history is the activity record — who committed what, when, for which wake. The shared runner's `commitPathPrefix` option determines where each agent writes. Issues reference committed files by path so everything is linked.

---

## What stays local

| Mechanism | Location | Why local |
|---|---|---|
| **Agent state** | `.murmuration/agents/state.json` | Runtime state — which agent is running *right now* on *this machine*. Two harness instances have different state files. |
| **Cost records** | `.murmuration/runs/<agent>/index.jsonl` | Telemetry — too high-frequency for GitHub. Aggregated cost summaries could be committed periodically. |
| **Daemon log** | `.murmuration/daemon.log` | Operational debug — per-instance |
| **Backlog cache** | `.murmuration/backlogs/<circle>.json` | Local cache of GitHub issues — rebuilt from GitHub on `--refresh` |

## Multi-Instance Architecture

```yaml
# murmuration/harness.yaml (committed to the shared repo)
instances:
  - id: "home-office"
    agents: ["01-research", "02-content-production", "07-coordinator", "16-editorial-calendar"]
    provider: "gemini"

  - id: "cloud-server"
    agents: ["03-publishing", "04-community", "06-analytics", "21-chronicler"]
    provider: "anthropic"

  - id: "local-dev"
    agents: ["11-design", "12-infographic"]
    provider: "ollama"
```

Each instance:
1. Reads its agent assignments from the shared config
2. Runs only its assigned agents on its own cron
3. Reads signals from GitHub (all instances see the same issues)
4. Writes governance events as GitHub issues (all instances see them)
5. Commits agent outputs to the shared repo
6. Maintains local-only runtime state in `.murmuration/`

Circle meetings can span instances — the `murmuration circle-wake` command calls LLM for each member regardless of which instance normally runs that agent.

## Label Taxonomy

```
# Directives
source-directive          — Source-originated directive
scope:all                 — targets all agents
scope:circle:<id>         — targets a circle
scope:agent:<id>          — targets a specific agent

# Governance
governance:tension        — a tension filed by an agent or Source
governance:proposal       — a formal proposal awaiting consent
governance:decision       — a ratified decision

# State (governance state machine via labels)
state:open
state:deliberating
state:consent-round
state:resolved
state:withdrawn
state:ratified
state:rejected

# Circles
circle:content
circle:intelligence
circle:publishing
circle:community
circle:sales-marketing
circle:design-visual
circle:finance-legal
circle:quality

# Agents (for agent-targeted items)
agent:01-research
agent:02-content-production
...

# Meeting types
circle-meeting            — operational meeting minutes
governance-meeting        — governance meeting minutes

# Content pipeline (existing)
type:content-idea
type:research-digest
stage:research
stage:editorial-planning
...
```

## Implementation Phases

### Phase 1 — Directives to GitHub (smallest change)
- `murmuration directive` creates a GitHub issue instead of a local file
- Remove DirectiveStore + filesystem directives
- Agents see directives through existing signal aggregator (listIssues with label filter)
- Remove daemon directive injection code

### Phase 2 — Governance to GitHub
- GovernanceStateStore reads/writes via GitHub issues instead of local JSONL
- State transitions = label swaps + comments
- Consent rounds = structured issue comments
- Decision records = closing comments
- `murmuration circle-wake --governance` posts results as issue comments

### Phase 3 — Meeting minutes to GitHub
- `murmuration circle-wake` creates a GitHub issue for the meeting or commits minutes to the repo
- Action items from meetings become separate issues

### Phase 4 — Multi-instance config
- `murmuration/harness.yaml` defines instance-to-agent assignments
- Daemon reads only its assigned agents
- Signal aggregator sees all agents' GitHub activity regardless of instance

## What This Enables

After all four phases, a murmuration is truly distributed:

```sh
# Machine A: run the research + content pipeline
murmuration start --root ./my-murmuration --instance home-office

# Machine B: run analytics + publishing
murmuration start --root ./my-murmuration --instance cloud-server

# Either machine: convene a circle meeting (calls LLM for all members)
murmuration circle-wake --circle content --directive "What's our priority?"

# Any browser: see everything in GitHub Issues
# https://github.com/org/repo/issues?q=label:source-directive
# https://github.com/org/repo/issues?q=label:governance:tension
```

The murmuration spans machines, providers, and timezones — coordinating through the same GitHub repo that humans already use.
