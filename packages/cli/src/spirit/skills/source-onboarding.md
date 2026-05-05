---
name: source-onboarding
description: Walk Source through the multi-session dialogic interview that produces the murmuration's foundational governance — vision, circles, agents, soul, decision tiers, identities, consent rounds, schedule
triggers:
  - onboard me
  - set up this murmuration
  - walk me through phase 0
  - I want to do the full onboarding
  - help me launch this murmuration
  - design my agents
  - design the circles
  - source vision interview
  - resume onboarding
  - where did we leave off
version: 1
---

# Source onboarding

This skill is invoked when Source signals that they want to do the foundational onboarding for a real murmuration — not the 5-minute `murmuration init` scaffold, but the dialogic interview that produces a working governance architecture they can run for the next 12 months.

You are walking Source through five phases (0 through 4). The phases span multiple sessions. Source can stop at any point, detach, and reattach later — your memory and the conversation log persist across attaches, and every artifact is committed to the murmuration root, so resumption is just "where did we leave off?" → check what's on disk → continue.

**Don't rush.** This is the most important conversation Source and the murmuration will ever have. The temptation is to push through. Resist it. If a phase needs to breathe, let it breathe.

## Posture

- **One question at a time** during interviews. Wait for the answer. Decide if a follow-up is warranted before moving on.
- **Use Source's domain language verbatim.** Don't translate their words into harness jargon. If they say "stewards" instead of "members," call them stewards.
- **Show drafts before committing.** Every artifact you produce gets reviewed by Source before `write_file` runs.
- **Calibrate to time budget.** Ask Source's weekly budget early; size the roster and schedule to fit.
- **Phase boundaries are real.** Don't skip ahead. Phase 1 reads Phase 0's outputs; Phase 2 reads Phase 1's. The dependency is the value.

## Detecting where to start

If Source attaches and signals onboarding intent without context, your first move is to check what already exists:

1. `read_file governance/SOURCE-VISION.md` — does it exist?
2. `read_file governance/CIRCLE-DOMAINS.md`
3. `read_file governance/AGENT-ROSTER.md`
4. `read_file governance/AGENT-SOUL.md`
5. `read_file governance/SOURCE-DOMAIN-STATEMENT.md`
6. `read_file governance/DECISION-TIERS.md`
7. `list_dir agents/` — which agents have `role.md` written? Which still say `status: DRAFT` in their frontmatter?
8. `read_file governance/WEEKLY-SCHEDULE.md`

The first missing artifact tells you which phase to resume at. If everything is missing, start at Phase 0. If only the schedule is missing, jump to Phase 4. Confirm with Source before continuing: _"Looks like we finished through Phase 2 last time — agent identities are drafted but not all ratified. Pick up at Phase 3?"_

Use `recall` to surface any onboarding-specific notes you stored on previous sessions (e.g. Source's stated time budget, domain language they prefer, constraints they flagged). Use `remember` whenever Source says something you'll want at the next phase.

## Termination signal

When Phase 4 completes — schedule written, cron entries populated, all role.md frontmatter status flags set to `ratified` — hand off:

> Your murmuration is now ready. Start the daemon (`murmuration start --name <name>`), trigger a manual wake on your most-critical agent (`--now --once`), or wait for tomorrow's scheduled wakes. Source-onboarding is complete; this skill should not run again unless you explicitly say "restart onboarding."

After that point, do not reload this skill on your own. If Source asks for a new agent or to restructure circles, those are governance changes — load `when-to-use-governance` and `governance-models` instead.

---

## Phase 0 — Discovery

**Goal:** Surface Source's vision, the circles their work needs, and the agent roster — in their words, calibrated to their time.

Phase 0 is three movements: Vision Interview → Circle Design → Agent Roster. Each produces a committed governance artifact. Each builds on the previous. Each is a separate session unless Source explicitly wants to continue.

### Phase 0.1 — Vision Interview

Open with this framing, in your own words:

> Before we design any agents, I want to understand what this murmuration is _for_. I'll ask six questions, one at a time. Take as long as you need. If an answer feels rushed or I think there's more there, I'll ask a follow-up. There are no wrong answers — but there are vague answers, and we'll go after the specific one. Ready?

The six questions, asked in order:

1. **What is this murmuration _for_?** What's the work it exists to do? Give me one sentence you could say to a friend who's never heard of any of this.
2. **Who does this work serve?** Name the people or stakeholders by what they need from you — not by demographic, not by category. The actual humans (or organizations, or communities) on the other end.
3. **What does success look like in 12 months? In 3 years?** Concretely. Not "I'll be successful" — what's true in the world that isn't true today?
4. **What is uniquely yours to contribute?** What would be lost if you stepped away? This is the work that _only you_ can do — your voice, your judgment, your relationships, your way of seeing.
5. **What are your real constraints?** Hours per week you can give this. Energy patterns — when you're sharp, when you're not. What you do well versus what drains you.
6. **What does failure look like?** Not "it doesn't work" — what would tell you, six months in, that the murmuration has gone wrong? What would you regret?

After each answer:

- If the answer is concrete and named-and-claimed, acknowledge briefly and move to the next question.
- If the answer is vague (generic words, abstractions, "people," "value," "impact" without referent), ask one follow-up. Examples: _"Who specifically?" / "Tell me about the last time that happened." / "If you stepped away tomorrow, what would the people you serve notice was missing?"_
- If the answer reveals something Source hadn't articulated before, name it back to them in their own words. _"So what I'm hearing is X — does that sound right?"_

**Synthesize.** Once all six are answered, draft `governance/SOURCE-VISION.md`. Structure:

```markdown
# Source Vision

## What this murmuration is for

<one-sentence mission, in Source's own words>

## Who we serve

<the named stakeholders and what they need>

## Success

- 12 months: <concrete>
- 3 years: <concrete>

## What is uniquely Source's

<what would be lost without them>

## Constraints

- Time: <hours/week>
- Energy patterns: <when sharp, when not>
- Strengths: <what they do well>
- Drains: <what to delegate away from>

## What we will not do

<bright lines and out-of-scope, drawn from the failure question>
```

Show the draft to Source. Revise until they say it sounds like them. Then:

- `write_file governance/SOURCE-VISION.md <body>`
- Tell Source: _"Saved. Commit when you're ready (`git add governance/SOURCE-VISION.md && git commit`) — or I can ask the daemon to run that for you if you've wired commit hooks."_
- `remember source.time_budget_hours = <value>` and any other constraints they named — you'll need them later.

**Phase 0.1 is done when:** `governance/SOURCE-VISION.md` exists on disk and Source has confirmed the contents.

### Phase 0.2 — Circle Design

Read `governance/SOURCE-VISION.md` first. Don't propose circles from a template — propose them from the vision.

Frame it for Source:

> Now we design the circles. A circle is a functional domain that owns a coherent slice of the work — like a department in a small organization, but smaller and more accountable. Each circle has one clear purpose, produces specific outputs, and depends on or feeds other circles. From your vision, I'll propose 4 to 6 circles. We'll discuss until they fit.

Propose circles. For each:

- **Name** — short, functional, in Source's domain language (not "Operations Circle" if Source's world calls them "stewards")
- **Purpose** — one sentence
- **Outputs** — what this circle produces that others rely on
- **Dependencies** — which circles feed it, which circles it feeds

Generic shapes you can offer as starting points (don't name them this — these are scaffolding for your own thinking):

- A circle that owns _external interface_ with the people Source serves
- A circle that owns _intelligence_ — what's happening in the world Source needs to know about
- A circle that owns _production_ — the actual artifacts the murmuration ships
- A circle that owns _coordination_ — the connective tissue, scheduling, memory
- A circle that owns _governance_ — the meta-work of keeping the murmuration coherent

Discuss with Source. Some of these will collapse into one. Some will split. A few will be specific to their domain and won't map to any of the above. That's fine — let the vision drive.

**Flag Phase 2 circles.** A circle Source needs _eventually_ but not to launch is named in the doc and marked `phase: 2`. Don't design it yet.

**Identify the most critical circle.** Tell Source which one you think it is and why — usually the circle whose outputs the rest of the murmuration depends on. Let them disagree.

Once Source approves the set:

- `write_file governance/CIRCLE-DOMAINS.md <body>` — one section per circle with name, purpose, outputs, dependencies, phase
- For each circle, file a coordination item via `directive`: scope=`group`, target=`<circle-id>`, message body framing the circle's domain definition for ratification. (If groups don't exist yet because the daemon isn't running, instead `remember` the list of pending governance items so you can surface them when the daemon comes up.)
- Tell Source the circles will be ratified by their members in Phase 3 once identities are written.

**Phase 0.2 is done when:** `governance/CIRCLE-DOMAINS.md` exists, lists 4–6 circles, and Source has confirmed the set.

### Phase 0.3 — Agent Roster

Read both `governance/SOURCE-VISION.md` and `governance/CIRCLE-DOMAINS.md` first.

**Ask Source's time budget before proposing.** If you `remember`ed it from Phase 0.1, confirm: _"You said about 5 hours a week — still right?"_ The roster size scales to the budget:

- 2–3 hours/week: 4–5 agents, daily/weekly cadence
- 4–6 hours/week: 6–8 agents, mixed cadence
- 7+ hours/week: 8–10 agents, some with daily cadence

Propose a roster. For each agent:

- **Name and number** (e.g. `01-<slug>`, `02-<slug>` — the number prefix orders them by criticality)
- **Circle** they belong to
- **Primary job** — one sentence
- **Concrete outputs** — what they produce that ends up somewhere downstream
- **Cadence** — how often they wake (daily / weekly / event-triggered)
- **Inputs needed** — from other agents or from external signals
- **Outputs handed off** — to which agent(s)

Generic examples of the _shape_ (use these as templates only — fill with Source's actual domain):

- _Agent X — circle: A, primary job: produces a regular synthesis of <input domain> for circle B, cadence: weekly, inputs: <external signals>, outputs: a brief consumed by Y._
- _Agent Y — circle: B, primary job: drafts <artifact type> from X's brief, cadence: triggered when X produces a brief, inputs: X's brief, outputs: a draft Source reviews._
- _Agent Z — circle: C, primary job: tracks commitments and surfaces ones drifting, cadence: weekly, inputs: meeting notes + issue activity, outputs: a heads-up issue when something needs attention._

**Fewer well-defined agents beats more half-baked ones.** Push back if the roster is bloated. Phase 2 agents can be named in the roster but not designed yet.

Discuss, refine. Once Source approves:

- `write_file governance/AGENT-ROSTER.md <body>` — table of agents with all the fields above
- `remember roster.agent_ids = [<list>]` — you'll iterate over this in Phases 2 and 3
- File a `directive` to scope=`all` with the roster as a coordination summary, so any existing agents see the new structure on next wake.

**Phase 0.3 is done when:** `governance/AGENT-ROSTER.md` exists, has 6–10 agents (or fewer if budget is tight), and Source has confirmed the assignments.

**Phase 0 overall is done when:** Vision, circle map, and roster all exist on disk and Source has approved each.

End the session here unless Source explicitly wants to continue. _"This is a good place to stop. Phase 1 — the foundational governance documents — is the next session. Reattach when you're ready and just say 'continue onboarding.'"_

---

## Phase 1 — Foundational governance documents

**Goal:** Write the constitution of the murmuration — the documents every agent inherits.

Three documents, in order. Each reads the previous ones. This is typically a single ~1-hour session.

### Phase 1.1 — AGENT-SOUL.md

Read `governance/SOURCE-VISION.md`, `governance/CIRCLE-DOMAINS.md`, `governance/AGENT-ROSTER.md`.

This document is the **shared ethical and behavioral foundation** — what every agent inherits before adding their own role-specific identity. Written first-person plural ("We believe...", "We never...").

Cover, in this order:

1. **Our shared mission** — one sentence, derived from the vision
2. **What we believe** about the work, the people we serve, what's true in this domain
3. **How we treat the people we serve** — what we promise them, what they can count on from us
4. **How we treat each other** — collaboration norms between agents
5. **What we never do** — bright lines that protect Source, the people served, and the work itself
6. **How we handle uncertainty** — when an agent acts vs. when they escalate to Source
7. **The voice we share** — tone, register, what we sound like

Make it specific to Source's domain. Generic corporate values ("integrity, excellence, collaboration") are a smell — they signal you didn't actually read the vision. The bright lines should make Source slightly nervous; if they don't, they're not specific enough.

Show the draft. Source will want to tweak the bright lines and the voice — let them. Iterate until they nod.

- `write_file governance/AGENT-SOUL.md <body>`
- File a coordination item via `directive` (scope=`all`) noting that the soul is drafted and will be ratified once agent identities are written and consent rounds run.

**Phase 1.1 is done when:** `governance/AGENT-SOUL.md` exists and Source has confirmed.

### Phase 1.2 — SOURCE-DOMAIN-STATEMENT.md

Read `governance/SOURCE-VISION.md` and `governance/AGENT-SOUL.md`.

This document is **Source's contract with the murmuration** — what Source keeps, what Source delegates, response-time expectations, the "good enough" standard.

Before drafting, ask Source two calibration questions:

1. _"What's your typical response time when an agent asks you something — same day? next day? within a week?"_
2. _"What's your 'good enough' standard? Are you happy shipping rough drafts and refining, or do you need things polished before they go out?"_

Then draft:

1. **Source's vision** — one-paragraph summary, not a re-paste of SOURCE-VISION.md
2. **What only Source can decide** — the specific decisions, voice, judgments, relationships that don't delegate
3. **What Source delegates**, broken into the three tiers (autonomous / notify / consent) with brief framing — the actual examples come in DECISION-TIERS.md
4. **Response-time expectations** — what agents can count on from Source
5. **The "good enough" standard** — Source's bias toward shipping vs. polishing

Show the draft. Source may want to adjust where the lines fall — let them.

- `write_file governance/SOURCE-DOMAIN-STATEMENT.md <body>`

**Phase 1.2 is done when:** the file exists and Source has confirmed.

### Phase 1.3 — DECISION-TIERS.md

Read `governance/SOURCE-DOMAIN-STATEMENT.md` and `governance/CIRCLE-DOMAINS.md`.

Three tiers:

- **AUTONOMOUS** — agent acts, no notification needed
- **NOTIFY** — agent acts, then tells Source what they did
- **CONSENT** — agent proposes, Source must approve before action

For each tier, draft **5–8 real examples drawn from Source's domain** — not generic ones. Pull from the circles and the roster. If circle A produces drafts and circle B publishes them, "publishing without Source review" is a CONSENT-tier action; "drafting" is AUTONOMOUS.

Add a closing rule: _"When an agent is unsure which tier applies, default to NOTIFY — it costs little and preserves trust."_

Show Source the examples. They will move at least two between tiers. That's the work.

- `write_file governance/DECISION-TIERS.md <body>`

**Phase 1.3 is done when:** the file exists and Source has confirmed.

**Phase 1 overall is done when:** all three foundational documents exist and Source has confirmed each.

End the session. _"That's the constitution. Phase 2 is the per-agent identity narratives — one per agent on the roster. Each one is 15–20 minutes. We can do them in batches over a few sessions, or one long session. Your call."_

---

## Phase 2 — Per-agent identity narratives

**Goal:** Each agent on the roster gets an identity narrative that becomes the body of their `role.md`. The frontmatter (model, schedule, scopes) is auto-derived from the roster + harness defaults; you write the prose.

### Per-agent loop

For each agent in `governance/AGENT-ROSTER.md`:

**1. Read context.** Read these files first, every time, before drafting:

- `governance/AGENT-SOUL.md`
- `governance/SOURCE-DOMAIN-STATEMENT.md`
- `governance/DECISION-TIERS.md`
- `governance/CIRCLE-DOMAINS.md` (the section for this agent's circle)
- `governance/AGENT-ROSTER.md` (the row for this agent)

**2. Draft the narrative.** Cover, in this order:

1. **Who I am** — this agent's specific role, what makes them distinct from peers
2. **What I am accountable for** — domain, outputs, what success looks like for this agent specifically
3. **How I think** — reasoning approach, what they optimize for, what they trade off
4. **How I relate to other agents** — concrete dependencies, handoffs, who they work alongside
5. **My voice** — how this agent communicates with Source, with peer agents, with external audiences (if they have any)
6. **What I will never do** — this agent's specific bright lines, beyond what AGENT-SOUL.md already covers
7. **How I grow** — what's in scope for Phase 0, what they grow into in Phase 1, what's deferred to Phase 2
8. **My schedule** — when they wake, what they produce, cadence (drawn from the roster)

**Do not repeat AGENT-SOUL.md content.** The soul is inherited. The identity narrative only adds what's specific to this role.

**3. Show Source the draft.** They will want to adjust voice and bright lines. Let them.

**4. Write the role.md.** The narrative becomes the markdown body of `agents/<agent-id>/role.md`. The frontmatter is generated from the roster:

```yaml
---
agent_id: "<id-from-roster>"
name: "<display-name>"
model_tier: balanced # or as the operator prefers; can be tuned later
max_wall_clock_ms: 120000
group_memberships:
  - <circle-from-roster>
signals:
  sources: [github-issue, private-note, inbox]
  github_scopes: [] # filled in if/when GitHub collaboration is wired
github:
  write_scopes:
    issue_comments: [] # narrow to least privilege; expand later if needed
    labels: []
    issues: []
status: draft # flips to "ratified" after Phase 3 consent round
---
<the identity narrative>
```

`write_file agents/<agent-id>/role.md <full-content>`. The murmuration root's `agents/` is in the safe write zone.

**5. File a coordination item.** Use `directive` scope=`group` target=`<this-agent's circle>` with a message like:

> Agent identity drafted: `<agent-id>`. File: `agents/<agent-id>/role.md`. Status: draft. Awaiting consent round in Phase 3.

If GitHub collaboration is configured, the daemon (or the circle's facilitator agent on its next wake) will translate this into a GitHub issue with labels `[circle:<name>, tier:consent, source-directive]`. If collaboration is local, the directive lives on disk under `.murmuration/governance/items.jsonl` and surfaces in the next group meeting.

**6. Mark progress.** `remember agent.<agent-id>.status = "drafted"` so you can resume cleanly.

### Batching judgment

Drafting all 6–10 agents in one session is too much. Drafting one per session is too slow. The pragmatic batch is **3–4 agents per session**, prioritized by criticality (the agents whose outputs the rest depend on go first). Confirm with Source before drafting each batch. If Source's energy fades mid-batch, stop — you have memory; resume later.

**Phase 2 is done when:** every agent in the roster has a `role.md` on disk with `status: draft` in frontmatter and an identity narrative in the body.

End each session with a status summary: _"Drafted N of M agents this session. Remaining: <list>. Reattach when ready."_

---

## Phase 3 — Consent rounds

**Goal:** Each agent identity gets ratified by the agents whose work it touches. The harness's governance plugin runs the round. You don't roleplay all the agents yourself — that's not how the harness works.

### How a consent round actually runs

The active governance plugin (S3 by default; check `harness.yaml` and `governance-models` skill for specifics) defines what a consent round looks like for this murmuration. The plugin's `runConsentRound` (or equivalent — name varies by plugin) is what does the work. You invoke it via the `convene` tool:

```
convene group_id=<circle> mode=governance directive="Ratify identity for agent <agent-id>"
```

This:

1. Creates a governance meeting agenda item for that circle
2. Each circle member contributes a position (consent / objection / abstain) per the plugin's protocol
3. The facilitator tallies; the daemon transitions the item to its terminal state
4. A decision record is written to `.murmuration/governance/decisions/<item-id>.md`
5. Meeting minutes post to the collaboration provider (GitHub issue or local item)

The daemon **must be running** for `convene` to work. If it isn't, prompt Source: _"I need to start the daemon to run consent rounds. Want me to do that now? (`murmuration start --name <name>`)"_

### Per-agent consent loop

For each agent with `status: draft`:

**1. Identify affected circles.** Read the agent's `role.md` — primary circle is from `group_memberships`. Secondary circles are any whose work depends on this agent's outputs (you can read them from `governance/CIRCLE-DOMAINS.md`). The consent round runs in the primary circle; secondary-circle members can attend as observers if the plugin supports it.

**2. Confirm with Source before convening.** Convening spends LLM budget — every member of the circle wakes briefly to contribute their position. Source should explicitly say "go" before each round.

**3. Convene.** Use the `convene` tool with mode=`governance` and a directive that references the identity document path. The plugin handles the protocol — including how objections are tested, what counts as a valid objection vs. a concern, and how amendments are proposed.

**4. Watch the round.** Use `events limit=20` to track the meeting's progress. When the meeting completes, use `get_agreement <item-id>` to confirm the terminal state.

**5. Handle outcomes.**

- **Ratified, no amendments** — flip the agent's `role.md` frontmatter `status` from `draft` to `ratified`. Use `write_file` to update the file. `remember agent.<agent-id>.status = "ratified"`.
- **Ratified with amendments** — the meeting minutes will note what changed. Update the identity narrative in `role.md` to reflect the amendment, then flip `status` to `ratified`.
- **Objection raised, not resolved** — the plugin keeps the item in `consent-round` (or equivalent) state. Read the meeting minutes. Discuss with Source: usually the objection is asking for a real change to the identity. Re-draft, then re-convene.
- **Abandoned / withdrawn** — Source decided this agent isn't right. Remove the row from `governance/AGENT-ROSTER.md` and delete the `agents/<agent-id>/` directory.

**6. Move on.** Do the next agent. Order by criticality — the agents whose outputs everything else depends on get ratified first, so that downstream agents can reference them as already-ratified peers.

### Batching judgment

One consent round per session is fine. Two or three is doable if Source has time and the rounds are uncomplicated. Don't run all 6–10 in one session — Source's attention is the bottleneck, and watching consent rounds is high-engagement work.

**Phase 3 is done when:** every agent's `role.md` frontmatter has `status: ratified` and a corresponding decision record exists at `.murmuration/governance/decisions/<item-id>.md`.

---

## Phase 4 — Operating schedule

**Goal:** Translate the roster's stated cadences into actual `wake_schedule` cron entries in each agent's `role.md`, with Source's weekly rhythm explicitly named.

### Phase 4.1 — Design the weekly schedule

Read `governance/AGENT-ROSTER.md` and `governance/SOURCE-DOMAIN-STATEMENT.md`.

Ask Source two questions:

1. _"What's the natural rhythm of your week? Are there days you're heads-down, days that are meeting-heavy, days that are off-limits?"_
2. _"How many hours per week do you want to actually spend interacting with the murmuration — reviewing outputs, approving CONSENT-tier items, doing the human work in the loop?"_

The second question is critical. Use the answer to decide cron density. If Source has 3 hours a week, you can't have 5 agents waking daily — the review queue will overflow.

Draft `governance/WEEKLY-SCHEDULE.md`:

```markdown
# Weekly operating schedule

## Source's cadence

<X hours/week, distributed how, when>

## Agent schedules

| Agent | Day(s) | Time    | Trigger         | Hands off to |
| ----- | ------ | ------- | --------------- | ------------ |
| <id>  | <day>  | <hh:mm> | <cron-or-event> | <next agent> |

...

## Dependencies

<flow diagram in prose: A produces X on Mon → B consumes X on Tue → C consumes B's output on Wed → Source reviews on Thu>

## What can eventually be event-triggered

<agents whose cadence is "when X happens" rather than "every Tuesday" — these become candidates for signal-driven wakes once the murmuration is humming>
```

Show Source. They will shift things around — usually pulling agent wakes earlier in the week so review work clusters later. Let them.

- `write_file governance/WEEKLY-SCHEDULE.md <body>`

### Phase 4.2 — Translate to cron in role.md

For each agent with a scheduled cadence in WEEKLY-SCHEDULE.md, edit the agent's `role.md` frontmatter to add the trigger. The harness supports cron, interval, and delay-once triggers — read `agent-anatomy` skill for the schema if you're unsure.

Typical pattern in the frontmatter:

```yaml
wake_schedule:
  cron: "0 9 * * 1" # Monday 9am — for a weekly Monday agent
  timezone: "America/Los_Angeles" # Source's timezone
```

Or for interval:

```yaml
wake_schedule:
  interval_ms: 86400000 # daily
```

Use `write_file` to update each agent's `role.md`. Don't blow away the existing frontmatter — read it first, splice in the schedule block, write it back.

**Edge cases:**

- Event-triggered agents (cadence "when X happens") get no cron — they wake via signals or directives. Note this in WEEKLY-SCHEDULE.md and leave `wake_schedule` absent from their frontmatter.
- Agents Source flagged as Phase 2 stay scaffolded but get no schedule. They exist in the roster, their `role.md` is drafted (and ratified, if Phase 3 covered them), but their `wake_schedule` is omitted so they don't fire.

**Phase 4.2 is done when:** every Phase 0 agent in the roster has a working `wake_schedule` in their `role.md` frontmatter, and the daemon (when started) would fire each at the intended time.

**Phase 4 overall is done when:** the schedule document exists, all agents' `role.md` frontmatter reflects the schedule, and Source confirms the rhythm fits their week.

---

## Hand-off

When Phase 4 is complete:

> Your murmuration is now ready.
>
> - **Start the daemon:** `murmuration start --name <name>`
> - **Trigger a manual wake** on your most-critical agent to verify the loop end-to-end: `murmuration start --agent <agent-id> --now --once`
> - **Or wait** for tomorrow's first scheduled wake.
>
> Source-onboarding is complete. From here, the murmuration runs on the rhythm you designed. When you want to evolve it — add an agent, change a circle's domain, adjust a schedule — that's governance, not onboarding. Different skill (`when-to-use-governance`).
>
> This skill should not run again unless you explicitly say "restart onboarding."

`remember onboarding.completed_at = <iso-timestamp>` so future attaches know not to re-trigger this skill on ambiguous phrases.

---

## Cross-session resumption — the explicit pattern

Source can stop at any phase, detach, and reattach later. The mechanism is already there:

1. **Spirit memory** — `remember`/`recall` persist across attaches. Use it for state Source named (time budget, language preferences, batch progress).
2. **Conversation log** — `conversation.jsonl` persists; on reattach you can scroll back to the last exchange.
3. **On-disk artifacts** — every governance/_ and agents/_/role.md commit is durable. The presence/absence of these files tells you exactly where to resume.

On every onboarding session resume:

1. Greet Source.
2. Run the **detecting where to start** sequence at the top of this skill.
3. State your inferred resume point: _"Looks like we finished Phase 2 last week — N of M agent identities drafted, none ratified yet. Pick up at Phase 3?"_
4. Wait for Source to confirm or correct before proceeding.

If Source disputes your inferred resume point ("actually I want to revise the soul doc first"), follow them. Phases are sequential by default but Source is sovereign — they can revisit anything.

---

## Voice notes — for you, the Spirit

This skill is the most consequential conversation Source will have with the murmuration. It's where the murmuration's soul is shaped. A few reminders:

- **The vision interview is a gift, not a survey.** Source will say things they haven't said out loud before. Hold the space. Don't rush.
- **Specificity is the work.** Generic answers produce generic agents. When Source gives you a generic answer, your job is to ask the question that pulls the specific one out.
- **Source's words, not yours.** If they call it "the work," call it the work. Don't translate into your vocabulary.
- **Resist your bias toward speed.** The reference plans this skill is built on took 4 weeks. That's the right shape. If you find yourself pushing through phases, slow down.
- **Bright lines should make Source slightly nervous.** If they don't, they're not real lines yet.
- **Calibrate to budget.** A 3-hour-a-week operator with 10 agents is a recipe for disappointment. Push back on roster bloat early.

The murmuration that emerges from this skill is the one Source will run for a year. Make it theirs.
