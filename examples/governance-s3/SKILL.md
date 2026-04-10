---
name: s3-governance
description: >
  Self-Organizing (S3) governance skill for Murmuration Harness agents.
  Enables agents to understand, enact, and facilitate S3 governance patterns
  within the harness's pluggable governance framework: structuring
  organizational drivers, running consent rounds, forming proposals,
  recording agreements, and operating within their role's domain authority.
  Integrates with GovernancePlugin + GovernanceStateStore for state tracking,
  review dates, and durable decision records.
argument-hint: "<action> — e.g. 'open consent round for X', 'structure tension: Y', 'record agreement: Z'"
---

# S3 Governance Skill (Murmuration Harness)

You have access to Sociocracy 3.0 (S3) governance patterns, integrated with the Murmuration Harness's `GovernancePlugin` interface and `GovernanceStateStore`. Use this skill when an agent needs to make a governed decision, structure a tension, run a consent round, or operate within S3 circle governance.

## Harness Plugin

This skill's runtime backing is the S3 governance plugin at `examples/governance-s3/index.mjs`. Boot with:

```sh
murmuration start --root ../my-murmuration --governance examples/governance-s3/index.mjs
```

## Supporting Files

Load these when needed (if available in your murmuration's skill directory):

- **Pattern Library (Tier 1):** Fully automatable patterns (logbook, backlog, standup, timebox, etc.)
- **Pattern Library (Tier 2):** Agent-facilitated patterns (consent decision, proposal forming, objection test, etc.)
- **Agent Persona:** Parameterized system prompt for S3-aware agents
- **Registry Schema:** Data structures for agreements, drivers, roles, objections

---

## When to Use This Skill

| Situation | Action |
|-----------|--------|
| An agent senses something isn't working | `s3_driver_queue` — structure the tension |
| A decision needs circle input | `s3_consent_decision` — open consent round |
| A proposal needs drafting | `s3_proposal_forming` — draft from driver |
| A 🔴 objection is raised | `s3_objection_test` — does it qualify? |
| A decision has been reached | `s3_record_agreement` — commit to logbook |
| Setting up a new agent's governance context | Load and fill `s3_agent_persona.md` |
| An agreement is past its review date | `evaluate_evolve_agreements` pattern |

---

## Core Concept: The S3 Governance Loop

```
Sense tension
  ↓ s3_driver_queue
Structure organizational driver
  ↓ s3_proposal_forming
Draft proposal
  ↓ s3_consent_decision
Run consent round (GitHub issue)
  ↓ s3_objection_test (if objections raised)
Test + resolve objections
  ↓ s3_record_agreement
Record in agreement registry
  ↓ assign + implement
Work happens
  ↓ evaluate_evolve_agreements (at review_date)
Renew, amend, or retire
  ↓ back to top
```

---

## Decision Tiers (Murmuration-Specific)

Every action an agent takes falls into one of four tiers. Check the agent's role definition (governance/roles/{role-id}.yaml) to determine tier for a given action type.

| Tier | What it means | When to use |
|------|---------------|-------------|
| **Autonomous** | Act and log | Within your domain, no surprises |
| **Notify** | Act, then tell Source | Within domain but Source should know |
| **Consent** | Get circle consent first | Affects multiple roles or significant commitment |
| **Source** | Nori's explicit approval | Bright lines, cross-org, irreversible |

**Spend limit:** Check role definition. Default for Murmuration agents: $5 autonomous.

---

## Tool: s3_driver_queue

**Purpose:** Transform a felt tension into a structured organizational driver.

**When:** An agent notices something isn't working, is missing, or could be better.

**Process:**

1. Ask: What is observable about the current situation? (facts, not interpretation)
2. Ask: How does this affect the organization's ability to fulfill its purpose?
3. Determine which circle owns this driver
4. Assess urgency (low / normal / high / critical)
5. Write the driver in this format:

```yaml
id: {YYYY-MM-DD}-DRV-{NNN}
sensed_by: {role_id}
circle: {circle_name}
date: {today}
situation: "{observable situation — what is happening}"
effect: "{why this matters to the organization's purpose}"
urgency: {low|normal|high|critical}
status: open
```

6. Save to `governance/drivers/{circle}.yaml` (append)
7. If urgency is high or critical: open a `[TENSION]` GitHub issue immediately using the tension format from the agent persona prompt.
8. If normal or low: add to governance backlog for next governance meeting.

**Qualifying questions to check your driver:**
- Is the situation observable? (Could someone else verify it?)
- Is the effect on the organization's purpose real — not just inconvenient for me?
- Is this the right circle to own it?

---

## Tool: s3_proposal_forming

**Purpose:** Draft a clear, consent-ready proposal from an organizational driver.

**When:** A driver has been structured and a decision is needed.

**Process:**

1. Load the driver from `governance/drivers/{circle}.yaml`
2. Load existing agreements from `governance/decisions/{circle}/` — check for anything that already covers this
3. Check constraints: budget, domain, prior agreements, bright lines
4. Draft using this template:

```markdown
## Proposal: {Short title}

**Driver:** {driver ID and one-line summary}

**What is proposed:**
{Clear, specific statement of what will be done or decided}

**Scope — included:**
- {item}
- {item}

**Scope — NOT included (deliberate):**
- {item} — deferred to a separate proposal
- {item}

**Review:** This agreement will be reviewed on {date} ({period} from adoption).

**Reversibility:** {Is this reversible? How?}
```

5. Apply the "good enough for now, safe enough to try" test:
   - Is it specific enough to act on? (yes/no)
   - Does it address the driver without exceeding it? (yes/no)
   - Is it reversible if it doesn't work? (yes/no)
   - Is it the minimum needed? (yes/no)
   If all yes: proceed to consent round. If any no: refine first.

6. Submit to `s3_consent_decision`.

---

## Tool: s3_consent_decision

**Purpose:** Run an asynchronous consent round via GitHub issue.

**When:** A proposal requires circle input before acting.

**Process:**

1. Open GitHub issue:
   - **Title:** `[CONSENT] {Circle}: {Short proposal title}`
   - **Labels:** `circle:{name}`, `type:consent-round`
   - **Body:** (use template below)

2. Tag all affected roles in the issue.

3. Monitor responses until:
   - All affected roles have responded, OR
   - Timeout reached (default 48h; extend once by 24h if quorum not reached)

4. For each 🔴 objection: run `s3_objection_test`

5. If no valid objections: proceed to `s3_record_agreement`, close issue with summary.

6. If valid objections: run `resolve_objections` pattern (see tier2.yaml).
   - Max two amendment rounds
   - If unresolved after two rounds: escalate to Source

**GitHub Issue Template:**

```markdown
## Driver
{Organizational driver — situation + effect on purpose}

## Proposal
{Full text of proposal}

## Scope
**Included:** {list}
**NOT included:** {list}

## Affected Roles
{@mention each role being asked to consent}

## Deadline
{ISO datetime} — {N}h from opening

---
## How to respond

Comment with one of:
✅ **Consent** — "good enough for now, safe enough to try"
⚠️ **Concern** — noted, not blocking
🔴 **Objection** — blocking; include: (1) what harm, (2) why it's real and likely, (3) how this proposal causes it
```

---

## Tool: s3_objection_test

**Purpose:** Determine whether a 🔴 objection qualifies as a valid (blocking) objection or should be downgraded to a ⚠️ concern.

**When:** A circle member raises a 🔴 objection in a consent round.

**The Four Criteria (ALL must be true):**

| # | Criterion | Question to ask |
|---|-----------|-----------------|
| 1 | **Harm** | Would adopting this proposal cause harm to the organization's ability to fulfill its purpose, or miss an important opportunity? |
| 2 | **Reality** | Is this harm real and likely — not merely theoretical or hypothetical? |
| 3 | **Causation** | Does the harm arise specifically from THIS proposal? |
| 4 | **Improvement** | Would resolving this objection make the proposal better? |

**Process:**

1. Read the objection statement.
2. Apply each criterion. Document your reasoning for each.
3. If ALL four are met: **valid objection** → proceed to `resolve_objections` in tier2.yaml
4. If ANY criterion fails: **not a valid objection**
   - Downgrade to ⚠️ concern
   - Explain to the objector which criterion wasn't met and why
   - Record the concern in the issue; continue the round

**Common invalid objection patterns:**
- "I prefer a different approach" → fails criterion 1 (preference ≠ harm)
- "This might cause problems someday" → fails criterion 2 (theoretical)
- "I'm not sure this is right" → fails criterion 2 (uncertainty ≠ real harm)
- "We should do X instead" → this is a proposal, not an objection

**Output format:**
```yaml
objection_id: {id}
raised_by: {role_id}
statement: "{verbatim objection}"
test:
  harm: {true|false} — {reasoning}
  reality: {true|false} — {reasoning}
  causation: {true|false} — {reasoning}
  improvement: {true|false} — {reasoning}
qualifies: {true|false}
outcome: {valid_objection | downgraded_to_concern}
```

---

## Tool: s3_record_agreement

**Purpose:** Commit a governance decision to the agreement registry.

**When:** A decision has been reached (any tier).

**Process:**

1. Generate ID: `{YYYY-MM-DD}-{NNN}` (increment NNN for same-day decisions)
2. Set `review_date` = today + review_period
3. Write file to `governance/decisions/{circle}/{id}.yaml`
4. If consent tier: post summary comment to consent round issue and close it
5. If notify tier: post brief summary to circle communication channel
6. Update `governance/decisions/{circle}/index.yaml` (append entry)

**Agreement file template:**
```yaml
id: "{YYYY-MM-DD-NNN}"
pattern: "{s3 pattern name}"
circle: "{circle}"
date: "{today}"
driver: "{driver ID or one-line summary}"
decision: "{plain language — what was decided}"
proposal_text: |
  {full text of ratified proposal}
decision_tier: "{autonomous|notify|consent|source}"
proposer: "{role_id}"
owners:
  - "{role_id}"
affected_roles:
  - "{role_id}"
consent_round_url: "{GitHub issue URL or null}"
objections_raised: {int}
concerns_raised: {int}
review_date: "{YYYY-MM-DD}"
review_period: "{90d|6m|1y}"
status: active
notes: ""
```

---

## Configuring an Agent with This Skill

To make a Murmuration agent S3-aware:

1. Read `~/.claude/skills/s3-governance/prompts/s3_agent_persona.md`
2. Load the agent's role definition from `governance/roles/{role-id}.yaml`
3. Fill all `{PLACEHOLDERS}` with the agent's actual role data
4. Include the filled persona in the agent's system prompt
5. Load `patterns/tier1.yaml` and `patterns/tier2.yaml` as reference
6. Load the circle's current agreements: `governance/decisions/{circle}/index.yaml`

The agent now knows:
- Its domain and what it can decide autonomously
- How to structure a tension as a driver
- How to run or participate in a consent round
- How to test objections
- How to record decisions
- When to escalate to Source

---

## Integration with the Murmuration Harness

This skill integrates with the harness's `GovernancePlugin` interface and `GovernanceStateStore`:

| Skill tool | Harness integration |
|------------|---------------------|
| `s3_driver_queue` | Emits a `tension` governance event → S3 plugin creates a `GovernanceItem` in the state store → routes to Source + targeted agent |
| `s3_consent_decision` | Opens a `[CONSENT]` GitHub issue → plugin tracks via `proposal` state graph (drafted → consent-round → ratified) |
| `s3_objection_test` | Plugin transitions consent-round → deliberating (if objection valid) or stays in consent-round (if invalid) |
| `s3_record_agreement` | Plugin transitions to terminal state → `GovernanceDecisionRecord` is built → `reviewAt` set automatically from `defaultReviewDays: 90` |
| `evaluate_evolve_agreements` | `store.query({ reviewDue: true })` surfaces items past their review date |

**State graphs (from S3GovernancePlugin):**
```
tension:  open → deliberating → consent-round → resolved | withdrawn
proposal: drafted → consent-round → ratified | rejected | withdrawn
```

**Decision tiers** map directly to the harness's `evaluateAction` flow:
- **Autonomous** → `evaluateAction` returns `{ allow: true }` (agent proceeds)
- **Notify** → agent proceeds + emits `notify` governance event → routed to Source
- **Consent** → agent opens consent round via `s3_consent_decision` → waits for resolution
- **Source** → `evaluateAction` returns `{ allow: false, reason: "requires Source approval" }` → agent escalates

**To use this skill in any murmuration:**
1. Boot the daemon with `--governance examples/governance-s3/index.mjs`
2. Agents emit governance events via the `::governance::tension:: {...}` subprocess protocol or the in-process runner's `governanceEvents` return
3. The S3 plugin handles routing, state tracking, and review scheduling
4. Replace GitHub issues with your coordination channel if needed
5. Keep the consent emoji protocol (✅ ⚠️ 🔴)
6. Set spend limits appropriate to your organization's budget

---

## Quick Reference

```
Sense tension          → s3_driver_queue
Draft proposal         → s3_proposal_forming
Circle decision needed → s3_consent_decision (GitHub [CONSENT] issue)
Objection raised       → s3_objection_test (4 criteria)
Resolution reached     → s3_record_agreement (write to governance/decisions/)
Agreement expiring     → evaluate_evolve_agreements (tier2.yaml)
New agent setup        → s3_agent_persona.md (fill placeholders)
```
