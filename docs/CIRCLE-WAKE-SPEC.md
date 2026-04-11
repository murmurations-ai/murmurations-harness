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
  readonly backlog: readonly GitHubIssue[];     // the circle's work queue
  readonly governanceQueue: readonly GovernanceItem[];  // pending governance items
  readonly clients: InProcessRunnerClients;     // shared LLM + GitHub
}

interface CircleWakeResult {
  readonly meetingMinutes: string;              // the synthesized output
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
facilitator: "16-editorial-calendar"  # or "07-coordinator"

# Operational meeting
operational_wake:
  cron: "0 19 * * *"          # daily at 19:00 UTC
  backlog_label: "circle: content"
  max_items: 10

# Governance meeting
governance_wake:
  cron: "0 19 * * 5"          # weekly Friday at 19:00 UTC
  # OR trigger-based:
  trigger_threshold: 3         # wake when ≥3 pending governance items
  review_check: true           # also wake if any agreements are due for review

# GitHub work queue
backlog:
  repo: "xeeban/emergent-praxis"
  labels: ["circle: content"]
  prioritization: "by-agent-vote"  # or "by-facilitator" or "fifo"
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
  | { readonly kind: "circle-operational"; readonly circleId: string; readonly expression: string; readonly tz?: string }
  | { readonly kind: "circle-governance"; readonly circleId: string; readonly expression: string; readonly tz?: string };
```

Or simpler: circle wakes are scheduled on the circle config, not on individual agents. The daemon reads circle configs and schedules circle wakes alongside individual agent wakes.

---

## Naming

- **Agent #7 "Wren"** → rename to **"Coordinator"** or **"Operations Monitor"**. "Wren" is the OpenClaw agent name and is EP-specific. The harness should use a functional name.

---

## Implementation phases

### Phase A — Source Directives (smallest, unblocks everything)
- `murmuration directive` CLI command
- Directive files in `.murmuration/directives/`
- Daemon injects pending directives into signal bundle
- No code changes to runners — directives appear as signals

### Phase B — Circle Wake Runner
- `CircleWakeRunner` in `@murmuration/core`
- Circle config schema (members, facilitator, backlog label)
- Daemon schedules circle wakes from circle configs
- Member round + facilitator synthesis
- Meeting minutes artifact

### Phase C — Governance Meeting Protocol
- Governance wake variant of CircleWakeRunner
- Consent round tallying (consent/concern/objection per member)
- State machine advancement based on tally
- Decision record generation

### Phase D — Circle Work Queue
- `murmuration backlog --circle content` command
- GitHub issue reading filtered by circle label
- Prioritization during operational circle wakes
- Assignment via issue comments/labels

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
