# Circle Wake + Governance Meeting Specification

**Status:** Draft — awaiting Source review
**Author:** Source + Claude Code, 2026-04-10
**Closes:** The structural gap that prevented governance rounds, circle meetings, and Source directives from working without hacks.

---

## Problem

The harness currently supports only **individual agent wakes** — one agent fires on its cron, processes signals, calls an LLM, produces output. Agents interact through a sequential pipeline: each reads the upstream agent's latest artifact.

This model can't express:

1. **Circle meetings** — where all members of a circle convene simultaneously with shared context and produce joint output
2. **Source directives** — where Source injects a question or instruction that agents respond to
3. **Governance rounds** — where proposals and tensions are processed through a formal consent lifecycle
4. **Circle operational work** — where the circle collectively processes its backlog, prioritizes, plans, or runs retrospectives

These are all forms of **group wakes** — multiple agents participating in a shared session, each contributing their perspective, with a structured output that represents the circle's collective judgment.

---

## Two kinds of circle wake

### 1. Operational Circle Wake

**Purpose:** The circle does work together — processing its GitHub issues backlog, prioritizing, planning, assigning tasks, running retrospectives.

**Shape:**

- All circle members wake with the same context (backlog, recent activity, upstream signals)
- Each member contributes their perspective in sequence (round format)
- The facilitator (or a designated agent) synthesizes the contributions
- Output: updated backlog priorities, new tasks, assignments, retrospective insights

**Trigger:** Scheduled cron (e.g., Content Circle meets daily at 19:00 UTC) or on-demand from Source.

**This is the DEFAULT circle wake.** Most of the time, circles do operational work, not governance.

### 2. Governance Circle Wake

**Purpose:** The circle processes governance items — proposals needing consent, tensions needing deliberation, agreements due for review.

**Shape:**

- All circle members wake with the governance queue (pending items from the GovernanceStateStore)
- For each item: the proposal is presented, each member responds (consent / concern / objection), the facilitator tallies and advances the state machine
- Output: governance decisions (ratified / rejected / amended), updated state store, decision records

**Trigger:** Scheduled cadence (e.g., weekly governance meeting) or when the governance queue reaches a threshold (e.g., ≥3 pending items).

**This is a SUBSET of circle wakes.** Governance meetings have a formal protocol (consent round, objection test) that operational meetings don't.

---

## Architecture

### CircleWake — the new primitive

```
Individual Wake (existing):
  Daemon → Scheduler → one agent → LLM → output → artifact

Circle Wake (new):
  Daemon → Scheduler → CircleWakeRunner → [all circle members] → synthesized output

  Where CircleWakeRunner:
    1. Loads the circle's context (backlog, signals, governance queue)
    2. For each member: constructs a per-member prompt, calls LLM, collects response
    3. Synthesizes: facilitator agent sees all responses, produces joint output
    4. Persists: updated backlog, governance decisions, meeting minutes
```

### CircleWakeRunner (new component)

The runner for a circle wake. Lives alongside the existing `AgentRunner` but operates at the circle level:

```ts
interface CircleWakeRunner {
  /** Run a circle wake — operational or governance. */
  run(context: CircleWakeContext): Promise<CircleWakeResult>;
}

interface CircleWakeContext {
  readonly circleId: string;
  readonly members: readonly RegisteredAgent[];
  readonly facilitator: RegisteredAgent;
  readonly wakeKind: "operational" | "governance";
  readonly signals: SignalBundle;
  readonly backlog: readonly GitHubIssue[]; // the circle's work queue
  readonly governanceQueue: readonly GovernanceItem[]; // pending governance items
  readonly clients: InProcessRunnerClients; // shared LLM + GitHub
}

interface CircleWakeResult {
  readonly meetingMinutes: string; // the synthesized output
  readonly decisions: readonly GovernanceDecision[];
  readonly backlogUpdates: readonly BacklogUpdate[];
  readonly outputs: readonly AgentOutputArtifact[];
}
```

### How a circle wake runs

**Phase 1: Context assembly**

1. Daemon reads the circle doc → identifies members + facilitator
2. Loads the circle's GitHub issues backlog (filtered by circle label)
3. Loads the governance queue (pending items from the state store for this circle)
4. Loads each member's latest artifact (so members are aware of each other's recent work)

**Phase 2: Member round**
For each member (in order):

1. Construct the member's prompt: circle context + backlog + their role + "what's your input?"
2. Call LLM with their identity chain as system prompt
3. Collect their response as a structured contribution

**Phase 3: Facilitator synthesis**

1. The facilitator sees ALL member contributions
2. Constructs a synthesized output: decisions, priorities, action items
3. For governance items: tallies consent/concern/objection and advances the state machine
4. Produces meeting minutes

**Phase 4: Persistence**

1. Meeting minutes → `.murmuration/runs/<circleId>/<date>/meeting-<id>.md`
2. Governance decisions → state store transitions
3. Backlog updates → GitHub issue comments or label changes
4. Decision records → governance decisions directory

---

## Source Directives

Source needs a way to inject questions, instructions, or decisions into the murmuration without hacking wake prompts.

### Mechanism

```sh
# Send a directive to a specific agent
murmuration directive --agent 01-research "Validate this topic: context engineering for solo operators"

# Send a directive to a circle
murmuration directive --circle content "Should this circle hold regular meetings?"

# Send a directive to the whole murmuration
murmuration directive --all "Propose your ideal wake cadence"

# Schedule a governance round
murmuration governance --circle content --round consent --issue 42
```

### How it works

1. The CLI writes a **directive file** to `.murmuration/directives/<id>.json`:

   ```json
   {
     "id": "dir-2026-04-10-001",
     "from": "source",
     "scope": "circle:content",
     "kind": "question",
     "body": "Should this circle hold regular meetings?",
     "createdAt": "2026-04-10T19:30:00Z",
     "status": "pending"
   }
   ```

2. On the next wake (individual or circle), the daemon injects pending directives into the agent's signal bundle as `custom` signals with `sourceId: "source-directive"`.

3. The agent's runner sees the directive in its signals and responds to it.

4. After all targeted agents/circle members have responded, the directive status changes to `"responded"`.

5. Source reads the responses in the dashboard or via `murmuration directive --list`.

**No prompt hacking. No file swapping. No clearing index files.** Directives are a first-class primitive that flows through the existing signal → wake → output pipeline.

---

## Circle Configuration

Circles need more than a governance doc — they need operational configuration:

```yaml
# governance/circles/content.yaml (or content.md frontmatter)
circle_id: "content"
name: "Content Circle"
members:
  - "02-content-production"
  - "08-editorial"
  - "09-fact-checking"
  - "10-quality"
  - "16-editorial-calendar"
  - "21-chronicler"
facilitator: "16-editorial-calendar" # or "07-coordinator"

# Operational meeting
operational_wake:
  cron: "0 19 * * *" # daily at 19:00 UTC
  backlog_label: "circle: content"
  max_items: 10

# Governance meeting
governance_wake:
  cron: "0 19 * * 5" # weekly Friday at 19:00 UTC
  # OR trigger-based:
  trigger_threshold: 3 # wake when ≥3 pending governance items
  review_check: true # also wake if any agreements are due for review

# GitHub work queue
backlog:
  repo: "xeeban/emergent-praxis"
  labels: ["circle: content"]
  prioritization: "by-agent-vote" # or "by-facilitator" or "fifo"
```

---

## Circle Work Queue (GitHub-backed)

Each circle has a **prioritized work queue** backed by GitHub issues:

1. Issues labelled with the circle's label (e.g., `circle: content`) are the circle's backlog
2. During an **operational circle wake**, the circle:
   - Reviews new issues added since the last meeting
   - Prioritizes them (each member votes or the facilitator decides)
   - Assigns top items to specific agents
   - Updates issue labels/comments to reflect the assignment
3. Individual agents then work their assigned items on their own cron schedule
4. The circle's next meeting reviews progress on assigned items

This gives circles a natural workflow:

```
Issues arrive → Circle operational wake → Prioritize + assign → Agents work → Circle reviews → Repeat
```

---

## WakeTrigger extension

The existing `WakeTrigger` needs a new variant:

```ts
export type WakeTrigger =
  | { readonly kind: "delay-once"; readonly delayMs: number }
  | { readonly kind: "interval"; readonly intervalMs: number }
  | { readonly kind: "cron"; readonly expression: string; readonly tz?: string }
  | { readonly kind: "event"; readonly eventType: string }
  // NEW:
  | {
      readonly kind: "circle-operational";
      readonly circleId: string;
      readonly expression: string;
      readonly tz?: string;
    }
  | {
      readonly kind: "circle-governance";
      readonly circleId: string;
      readonly expression: string;
      readonly tz?: string;
    };
```

Or simpler: circle wakes are scheduled on the circle config, not on individual agents. The daemon reads circle configs and schedules circle wakes alongside individual agent wakes.

---

## Naming

- **Agent #7 "Wren"** → rename to **"Coordinator"** or **"Operations Monitor"**. "Wren" is the OpenClaw agent name and is EP-specific. The harness should use a functional name.

---

## Agent Self-Reflection + Tension Filing

Every agent should periodically reflect on its own effectiveness and, when something isn't working, emit a governance event to its circle's governance queue — without Source needing to prompt it. The active governance plugin provides the language and event kinds: S3 calls them "tensions," Chain of Command calls them "reports," Parliamentary calls them "motions." The agent doesn't need to know which model is active.

### How it works

At the end of each wake, the runner asks the agent a self-reflection question as part of its output contract:

```
## Self-Reflection

EFFECTIVENESS: [high / medium / low]
OBSERVATION: [one sentence — what went well or what's not working]
TENSION: [none / filed]
```

If the agent reports a governance event, it emits it through the standard governance event mechanism:

```
::governance::<kind>:: {"topic": "...", "description": "...", "proposedAction": "..."}
```

The `<kind>` is provided by the active governance plugin's state graphs. Examples:

- S3: `tension`, `proposal-opened`
- Chain of Command: `report`, `escalation`
- Parliamentary: `motion`, `amendment`

This flows through the existing governance dispatch:

1. The governance plugin receives the event in `onEventsEmitted`
2. Creates a `GovernanceItem` in the state store (using the plugin's state graph for that kind)
3. GovernanceGitHubSync creates a GitHub issue with the appropriate labels
4. Routes it to Source + the agent's circle
5. The item sits in the governance queue until the next **governance circle wake** processes it

### What agents can self-reflect on

- **Signal quality** — "I received 0 useful signals this wake; my signal scopes may need adjustment"
- **Upstream dependency** — "My upstream agent hasn't produced output in 3 days; I'm running on stale data"
- **Budget utilization** — "I used 95% of my budget ceiling; either the ceiling is too low or I'm doing too much"
- **Output utility** — "My last 3 digests look similar; I may not be adding value at my current cadence"
- **Role fit** — "I'm being asked to do work outside my declared accountabilities"
- **Pipeline bottleneck** — "I complete in 5 seconds but wait 23 hours for upstream; the cadence is mismatched"

### Why this matters

In any governance model, agents sensing problems and escalating them is the driver of organizational change. If agents can't self-reflect and file governance events, Source has to notice everything manually. An agent sensing "my cadence is wrong" and filing a governance event to its circle's queue is how a self-organizing murmuration works — the system evolves from within.

The governance plugin decides what happens next: S3 runs a consent round, Chain of Command escalates to the authority, Parliamentary opens a motion for debate. The harness provides the sensing + filing; the plugin provides the resolution.

---

## Circle Retrospectives + Pluggable Strategy Framework

Circles need to reflect collectively — not just individual agents. After delivering milestones or completing sprint-like cycles, the circle should pause and ask: "What worked? What didn't? What do we change?"

### Circle Retrospectives

A retrospective is a special **operational circle wake** triggered after a milestone or on a regular cadence (e.g., end of each sprint/week). The facilitator prompts each member:

```
What went well this cycle?
What didn't go well?
What should we change?
What tension should we file?
```

Each member contributes from their role's perspective. The facilitator synthesizes into:

- **Keep doing** — practices that worked
- **Stop doing** — things that wasted effort or caused problems
- **Start doing** — new practices to try next cycle
- **Tensions filed** — any structural issues elevated to governance

Retrospective output is persisted as a circle artifact and fed into the next cycle's planning wake.

### Pluggable Strategy & Measurement Framework

Different murmurations measure success differently. The harness shouldn't bake in one framework — it should provide a **pluggable strategy interface** analogous to the pluggable governance interface:

```ts
interface StrategyPlugin {
  readonly name: string; // "okr", "kpi", "north-star", "none"
  readonly version: string;

  /** Declare the measurement structure (objectives, metrics, etc.) */
  measurementSchema(): readonly MeasurementDefinition[];

  /** Called at circle retrospective — evaluate progress against goals */
  evaluateProgress(
    circleId: string,
    measurements: readonly Measurement[],
  ): Promise<StrategyEvaluation>;

  /** Called at planning wake — suggest priorities based on strategy */
  suggestPriorities(
    circleId: string,
    backlog: readonly BacklogItem[],
    measurements: readonly Measurement[],
  ): Promise<readonly PrioritySuggestion[]>;
}
```

**Example strategy plugins:**

| Plugin         | How it guides                                                                                                                                                        | Measurement shape                                  |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **OKR**        | Objectives + Key Results per circle per quarter. Retrospectives score KR progress (0.0-1.0). Planning prioritizes backlog items that advance the lowest-scoring KRs. | `{ objective, keyResult, target, current, score }` |
| **North Star** | One murmuration-wide metric + circle-level input metrics. Retrospectives check whether inputs are driving the north star.                                            | `{ northStar, inputMetric, value, trend }`         |
| **KPI**        | Key Performance Indicators per agent/circle. Retrospectives flag KPIs below threshold.                                                                               | `{ kpi, threshold, actual, status }`               |
| **None**       | No measurement framework — circles self-organize without quantitative goals.                                                                                         | (empty)                                            |

### How strategy flows through the system

```
Source sets strategy (OKRs, North Star, etc.)
  ↓
Strategy plugin provides measurement schema
  ↓
Each circle's operational wake evaluates: "Are we on track?"
  ↓
Circle retrospective reflects: "Why or why not? What do we change?"
  ↓
Planning wake uses suggestPriorities: "Given where we are, what should we work on next?"
  ↓
Individual agents work their assigned items
  ↓
Next retrospective measures progress
  ↓ back to top
```

### Alignment across circles

The strategy plugin operates at two levels:

1. **Murmuration-wide** — Source declares top-level objectives. Every circle can see them.
2. **Per-circle** — each circle has its own objectives/KRs that roll up to the murmuration level.

During circle operational wakes, the facilitator checks: "Is our work aligned with the murmuration's objectives?" If drift is detected, it surfaces as a tension → governance queue.

This keeps all agents focused within their circles, and all circles aligned with the murmuration's purpose — without Source needing to micromanage. Source sets the direction; the strategy plugin measures progress; the circles self-correct through retrospectives and governance.

### Strategy in the dashboard

The TUI/web dashboard gains a fifth panel (or integrates into the existing overview):

```
Strategy: OKR Q2 2026
  O1: Launch first course           KR1: 0.3  KR2: 0.7  KR3: 0.1
  O2: Grow audience to 1000         KR1: 0.5  KR2: 0.2
  Content Circle: on track (0.5 avg)
  Intelligence Circle: behind (0.2 avg) — tension filed
```

---

## Implementation phases

### Phase A — Source Directives (smallest, unblocks everything)

- `murmuration directive` CLI command
- Directive files in `.murmuration/directives/`
- Daemon injects pending directives into signal bundle
- No code changes to runners — directives appear as signals

### Phase B — Agent Self-Reflection + Tension Filing

- Add self-reflection prompt to the shared runner's output contract
- Agents emit governance events when they sense a tension
- S3 plugin creates governance items from agent-filed tensions
- Tensions queue for the next governance circle wake
- Agents can also file proposals directly (not just tensions)

### Phase C — Circle Wake Runner

- `CircleWakeRunner` in `@murmuration/core`
- Circle config schema (members, facilitator, backlog label)
- Daemon schedules circle wakes from circle configs
- Member round + facilitator synthesis
- Meeting minutes artifact

### Phase D — Governance Meeting Protocol

- Governance wake variant of CircleWakeRunner
- Consent round tallying (consent/concern/objection per member)
- State machine advancement based on tally
- Decision record generation

### Phase E — Circle Work Queue

- `murmuration backlog --circle content` command
- GitHub issue reading filtered by circle label
- Prioritization during operational circle wakes
- Assignment via issue comments/labels

### Phase F — Circle Retrospectives

- Retrospective as a special operational circle wake kind
- Triggered after milestones or on cadence (weekly/biweekly)
- Keep/stop/start/tension output format
- Retrospective artifacts persisted + fed into next planning wake

### Phase G — Strategy Plugin Interface

- `StrategyPlugin` interface in `@murmuration/core`
- OKR plugin as the first implementation (in `examples/strategy-okr/`)
- `NoOpStrategyPlugin` as default (no measurement framework)
- Integration with circle operational wakes (evaluateProgress)
  and planning wakes (suggestPriorities)
- Dashboard strategy panel showing progress per objective
- Alignment check: circle drift detection → tension filing

---

## What this enables

After all four phases:

```sh
# Source asks a question — it just works
murmuration directive --all "Propose your ideal wake cadence"

# Content circle holds its daily operational meeting
# (automatically — cron fires, all members contribute, facilitator synthesizes)

# Weekly governance meeting processes pending proposals
# (consent round, objection test, decision records — all automated)

# Source sees it all in the dashboard
murmuration dashboard --root ../my-murmuration
```

No hacks. No prompt swapping. No index file clearing. Governance rounds, circle meetings, and Source directives are first-class primitives in the harness.
