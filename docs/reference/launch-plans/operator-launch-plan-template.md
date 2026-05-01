# Operator Launch Plan — Template

Anonymized reference distilled from two proven onboarding plans where first-time operators stood up working murmurations inside Claude Code. Preserves the **interview discipline** and **prompt structure** that worked; strips all PII, domain specifics, and personal attribution.

Use this as the **source material** for redesigning `murmuration init` from a form-fill tool into a guided interview. The prompts below are the behaviors the init LLM interview should reproduce.

---

## What the operator is building

A **murmuration** is a self-organizing team of AI agents that helps coordinate complex work. Each agent has a specific role, a defined domain, and a schedule. Together they research, synthesize, communicate, track, and produce — while the operator (Source) focuses on relationships, judgment, and vision.

---

## The model

In Phase 0, the operator is the harness. They open a Claude conversation, paste in an agent's identity, and run that agent's tasks. It sounds manual because it is — but it's fast (15–30 min per session), and it teaches the operator how the system works before automation. Phase 2 adds the OpenClaw / murmuration-harness daemon for scheduled, autonomous wakes.

---

## Phase 0: Discovery (Week 1)

_Goal: understand vision, stakeholders, and what agents are actually needed._

### Step 1 — Source Vision Interview

The single most important step. Template prompt:

```
You are a skilled systems design consultant.

I'm building an AI agent team to help me coordinate [DOMAIN].

Please run a structured discovery interview. Ask ONE question at a time.
Wait for my answer. Ask a follow-up if my answer is vague or could go
deeper. Don't rush — this is the most important conversation we'll have.

Cover in order:
1. What is the core mission of this work — what change am I trying to
   make in the world?
2. Who are the key stakeholders and what does each need from me?
3. What am I currently doing that is high-value and shouldn't be delegated?
4. What is currently falling through the cracks?
5. What does coordination failure look like? What breaks and why?
6. What does success look like in 12 months?

After the interview, synthesize into a one-page Source Vision Statement:
- Mission (specific, not generic)
- Stakeholders and their needs
- My unique contribution (what would be lost without me)
- My constraints (time, capacity, what I do vs. delegate)
- What I will NOT do (scope boundaries)

Start with question 1.
```

**Rules for the interview engine:**

- ONE question at a time
- Wait for answer
- Follow up on vague answers
- Don't summarize or propose until the interview is complete

Output is saved to `murmuration/soul.md` (the harness's equivalent of SOURCE-VISION.md).

### Step 2 — Circle/Domain Design

```
Read the Source Vision Statement.

Help me design the circles (functional domains) for my murmuration.
Think of circles like departments — each has a clear purpose and owns
specific work.

Based on my vision:
1. Propose 4–6 circles suited to Phase 0. For each:
   - Name (short, functional)
   - One-sentence purpose
   - Main outputs it produces
   - Which circles it feeds into or depends on
2. Flag any circles that are Phase 2 (don't need them to launch)
3. Tell me which circle is most critical to get right first

Discuss until we agree on the set. Keep Phase 0 lean: 4–5 circles max.
```

Output: one `governance/groups/<slug>.md` per circle, each with purpose + members list.

### Step 3 — Agent Roster

```
Read the Source Vision Statement and the circles.

Help me design the specific agents for my murmuration.

For each agent, define:
- Agent name and number
- Which circle they belong to
- Primary job in one sentence
- Concrete outputs they produce
- How often they should run (daily / weekly / monthly / event-triggered)
- What they need from other agents
- What other agents need from them

Guidelines:
- Phase 0 target: 6–10 agents total
- Phase 2 agents can be named but don't need full design yet
- Fewer well-defined agents beats more half-baked ones
- My available time per week for agent sessions: [X hours]

Ask me my time budget before proposing the roster. Discuss and refine.
```

Output: one `agents/<slug>/` dir per agent with `role.md` + `soul.md` scaffolded from the roster.

---

## Phase 1: Governance Documents (Week 2)

Four foundational documents:

1. **AGENT-SOUL.md** — shared ethical/behavioral foundation every agent inherits. Written first-person plural. Specific bright lines. Never generic corporate values.
2. **SOURCE-DOMAIN-STATEMENT.md** — what Source keeps vs delegates, availability, "good enough" standard.
3. **CIRCLE-DOMAINS.md** — all circles with purpose, domain, outputs, decision authority.
4. **DECISION-TIERS.md** — AUTONOMOUS / NOTIFY / CONSENT with 5–8 concrete examples of each drawn from the operator's specific domain.

Each is produced by an LLM call reading the previous docs, showing the operator the draft for approval, then writing to `governance/` and opening a consent-round GitHub issue.

---

## Phase 2: Agent Identity Documents (Week 2–3)

Per-agent identity document covering:

1. Who I Am — specific role, what makes me distinct
2. What I Am Accountable For — domain, outputs, success
3. How I Think — reasoning approach
4. How I Relate to Other Agents — dependencies, handoffs
5. My Voice — how I communicate with Source and peers
6. What I Will Never Do — agent-specific bright lines
7. How I Grow — Phase 0 / 1 / 2 trajectory
8. My Schedule — cadence, outputs

Per-agent LLM call, draft shown for approval, written to `agents/<slug>/soul.md` body.

---

## Phase 3: Consent Rounds (Week 3)

Each identity document is ratified through an S3 consent round. LLM roleplays all affected agents, tests objections against the S3 rubric (evidence-based, specific harm, relevant to shared goal), declares consent or proposes amendments.

Output: status `DRAFT` → `RATIFIED` in frontmatter, GitHub issue closed with summary comment.

---

## Phase 4: Weekly Operating Schedule (Week 3)

```
Read the agent roster and Source Domain Statement.

Ask me two questions first:
1. How often do I want to publish/deliver? (cadence and day)
2. How many hours per week can I realistically spend on agent sessions?

Then design a weekly operating schedule. For each agent:
- Which day(s) they run
- Realistic session length
- What triggers them (day, event, output from another agent)
- What they hand off and in what format

Show the full week as a flow with dependencies. Discuss and refine.
```

---

## Phase 5: First Cycle (Week 4)

End-to-end session on a real piece of work. Pick one of:

- **Partner/Stakeholder Pulse** — one-page health snapshot, flag attention needs.
- **Meeting Prep** — brief Source before a call, surface 3 key questions, list open commitments.
- **Research Synthesis** — summarize recent developments in one area, flag what matters.

Run it, produce the output, archive to GitHub, open a retrospective issue.

---

## The Interview Discipline (most important pattern)

Every interview prompt repeats the same discipline:

- **One question at a time.** Never multiple.
- **Wait for the answer.** Never preempt.
- **Follow up on vague answers.** Go deeper when needed.
- **Synthesize only at the end.** Not mid-interview.
- **Show the draft before writing files.** Source approves before anything is committed.

This discipline is what makes the difference between "generic scaffold" and "operator's actual vision captured."

---

## What to preserve when adapting to `murmuration init`

1. The **question sequences** above — they're battle-tested.
2. The **interview rules** — one-at-a-time, wait, follow up, synthesize-last, approve-before-write.
3. The **Phase 0 → Phase 1 → Phase 2** progression — vision first, then circles, then agents, then governance docs, then schedule.
4. The **anti-hallucination bright lines** in every agent soul ("no contribution this round is a valid answer").
5. The **review gate** before every file write — Source edits the LLM's proposal, then the harness commits.

## What the harness must add

1. An **LLM-driven interview loop** inside `init` (not a form-fill).
2. **Structured output** (YAML or JSON) from the synthesis step so the harness can scaffold files reliably.
3. A **review-and-edit UI** — show the proposal, let Source accept wholesale or edit per-item.
4. A **fallback to form-fill** via `--no-interview` for CI / offline / tests.

## What's out of scope for v0.6.0

- Phase 1 governance docs (AGENT-SOUL, DECISION-TIERS, etc.) — can still be authored via Spirit prompts post-init.
- Phase 3 consent rounds — the S3 plugin handles these once the murmuration is running.
- Phase 5 first-cycle content — that's live `group-wake` territory.

v0.6.0's goal: get the operator from "I have a vision" to "I have a murmuration with reasonable circles, agents, and a vision statement" in a single `init` session.

---

_Reference material anonymized from two operator launch plans authored by third parties. Structure and prompts preserved; names, domains, and attribution removed._
