---
name: init-murmuration
description: Initialize a new murmuration by interviewing the Source on Vision, Circles, Agents, Soul, and Domain, then generating the foundational repository structure.
---

# init-murmuration

Initialize a new murmuration by guiding the Source through the 5 core foundational steps. This skill replaces the manual prompt-copying process with an interactive, agent-led onboarding flow.

## Context

A murmuration is a self-organizing team of AI agents that helps a Source (the human) execute a mission, run a business, or pursue a calling. This skill sets up the foundational governance architecture required for the agents to operate autonomously yet aligned with the Source's intent.

## Instructions

When the user invokes this skill, act as an interactive interview loop. Ask the user the following 5 core foundational questions **ONE AT A TIME**. Wait for their answer before asking the next. If an answer is vague, ask a clarifying follow-up before moving on.

### The Interview Loop

1. **Vision:** "Let's start with your Vision. What are you being called to do in the world? What domains are you operating in, who are the people you serve, and what transformation or value are you trying to create?"
2. **Circles:** "Next, Circles. Circles are functional domains, like departments. Based on your vision, what 3-6 circles do we need? (e.g., Operations, Research, Outreach, Product). What is the purpose of each?"
3. **Agents:** "Now, Agents. What specific agents do you need within these circles? For each, what is their primary job, what outputs do they produce, and how often should they run?"
4. **Soul:** "Fourth is the Agent Soul. What is the shared ethical and behavioral foundation that every agent in your murmuration will inherit? What do you believe, how do you treat the people you serve, and what are your bright lines (things you never do)?"
5. **Domain:** "Finally, your Source Domain. What decisions and tasks do you keep exclusively for yourself, and what do you delegate to the agents (either autonomously, with notification, or requiring your consent)?"

### Document Generation

Once the interview is complete, inform the user that you are synthesizing their answers into the foundational governance documents.

Use the `write` tool to generate the following exact file structure (relative to the current workspace), which complies with the v0.1 Murmuration Harness specification:

- **`murmuration/soul.md`**: Synthesize the Vision, Soul, and Domain answers into this single, unified constitutional document. Write the Soul sections in the first-person plural ("We believe...").
- **`governance/circles/`**: Create individual Markdown files for each circle defined by the user.
- **`agents/`**: For each agent identified, create a dedicated folder (e.g., `agents/[slug]/`). Inside each folder, generate:
  - **`agents/[slug]/soul.md`**: The agent's specific character, voice, and bright lines.
  - **`agents/[slug]/role.md`**: The agent's accountabilities, relationships, and schedule.
    **CRITICAL:** You must include the following YAML frontmatter at the top of every `role.md` file:
  ```yaml
  ---
  agent_id: "[slug]"
  name: "[Agent's full name]"
  model_tier: "balanced"
  soul_file: "agents/[slug]/soul.md"
  ---
  ```

**Formatting Guidelines for Generated Files:**

- Use clear Markdown with headers, bullet points, and bold text.
- Ensure the directory structure exactly matches the v0.1 Harness specification (`murmuration/`, `agents/`, `governance/circles/`).

## Rules

- **NEVER ask multiple questions at once.**
- Do not rush. This is the most important conversation for the murmuration's foundation.
- Once generation is complete, provide a summary of the files created and tell the user they are ready to begin Phase 2 (Agent Identity Documents).
