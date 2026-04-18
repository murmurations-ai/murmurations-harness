---
name: init-murmuration
description: Initialize a new murmuration by interviewing the Source on Vision, Circles, Agents, Soul, and Domain, then generating the foundational repository structure.
---

# init-murmuration

Initialize a new murmuration by guiding the Source through the 5 core foundational steps. This skill replaces the manual prompt-copying process with an interactive, agent-led onboarding flow.

## Context

A murmuration is a self-organizing team of AI agents that helps a Source (the human) run a knowledge business. This skill sets up the foundational governance architecture required for the agents to operate autonomously yet aligned with the Source's intent.

## Instructions

When the user invokes this skill, act as an interactive interview loop. Ask the user the following 5 core foundational questions **ONE AT A TIME**. Wait for their answer before asking the next. If an answer is vague, ask a clarifying follow-up before moving on.

### The Interview Loop

1. **Vision:** "Let's start with your Vision. What topics or domains are you genuinely expert in? Who is your ideal reader, and what transformation do you offer them?"
2. **Circles:** "Next, Circles. Circles are functional domains, like departments. Based on your vision, what 4-6 circles do we need? (e.g., Content, Intelligence, Community). What is the purpose of each?"
3. **Agents:** "Now, Agents. What specific agents do you need within these circles? For each, what is their primary job, what outputs do they produce, and how often should they run?"
4. **Soul:** "Fourth is the Agent Soul. What is the shared ethical and behavioral foundation that every agent in your murmuration will inherit? What do you believe, how do you treat the audience, and what are your bright lines (things you never do)?"
5. **Domain:** "Finally, your Source Domain. What decisions and tasks do you keep exclusively for yourself, and what do you delegate to the agents (either autonomously, with notification, or requiring your consent)?"

### Document Generation

Once the interview is complete, inform the user that you are synthesizing their answers into the foundational governance documents.

Use the `write` tool to generate the following file structure (relative to the current workspace, typically the root of the murmuration repo):

*   `governance/SOURCE-VISION.md` (Synthesized from the Vision answers)
*   `governance/circles/CIRCLE-DOMAINS.md` (Or individual files for each circle, synthesized from the Circles answers)
*   `governance/agents/AGENT-ROSTER.md` (Synthesized from the Agents answers)
*   `governance/soul.md` or `governance/AGENT-SOUL.md` (Synthesized from the Soul answers)
*   `governance/SOURCE-DOMAIN-STATEMENT.md` (Synthesized from the Domain answers)

**Formatting Guidelines for Generated Files:**
*   Use clear Markdown with headers, bullet points, and bold text.
*   Write `AGENT-SOUL.md` in the first-person plural ("We believe...").
*   Ensure the directory structure exactly matches: `governance/`, `governance/agents/`, `governance/circles/`. (Create the directories implicitly by providing the full path to the `write` tool).

## Rules
*   **NEVER ask multiple questions at once.**
*   Do not rush. This is the most important conversation for the murmuration's foundation.
*   Once generation is complete, provide a summary of the files created and tell the user they are ready to begin Phase 2 (Agent Identity Documents).