---
name: identity-review
description: >
  Review, reflect on, and propose changes to agent identity documents
  (soul.md, role.md). Use when asked to review your own identity, peer
  review another agent's role, reflect on effectiveness, or propose
  amendments to identity docs during governance rounds.
---

# Identity Review Skill

Use this skill when you're asked to:

- Review your own soul.md and role.md
- Peer review another agent's identity docs
- Propose amendments to role definitions
- Reflect on your effectiveness and suggest identity improvements

## Tools Available

- `read_identity(agentId)` — reads an agent's full soul.md + role.md
- `list_agents()` — lists all agents with names and groups

## For Self-Reflection

1. Call `read_identity` with your own agent ID
2. Read your soul carefully — does it accurately describe who you are?
3. Read your role — are your accountabilities complete? Are your mental models current?
4. Compare your role definition against your actual recent work
5. Propose specific amendments:
   - Quote the text you want to change
   - State what it should say instead
   - Explain why

## For Peer Review

1. Call `list_agents` to see all agents
2. Call `read_identity` for each peer you're reviewing
3. For each peer, propose ONE specific improvement:
   - A missing accountability
   - A boundary that needs clarifying
   - A mental model they should add
   - A voice adjustment
4. Be concrete — reference specific text from their docs

## For Governance Consent on Amendments

When reviewing proposed changes to your own identity docs:

- **CONSENT** — the change is acceptable, proceed
- **CONCERN** — state the concern but don't block
- **OBJECTION** — state the specific harm and your proposed amendment

## Output Format

```
### Proposed amendment for [agent-id]

**Current text:**
> [quote the existing text]

**Proposed text:**
> [state the replacement]

**Reasoning:** [why this change improves the role]
```
