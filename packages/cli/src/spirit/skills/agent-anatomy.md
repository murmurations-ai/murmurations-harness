---
name: agent-anatomy
description: How agents are defined — soul.md, role.md frontmatter, signal scopes, write scopes
triggers:
  - create a new agent
  - edit an agent
  - agent won't wake
  - what fields go in role.md
  - signal scopes
  - write scopes
  - agent model tier
version: 1
---

# Agent anatomy

Every agent lives at `<root>/agents/<agent-id>/` with exactly two files: `soul.md` (identity + purpose) and `role.md` (operational frontmatter + wake prompt).

## soul.md

Free-form markdown describing **who the agent is**. This is the identity the operator writes for the agent — its perspective, values, domain. No frontmatter required. The content is threaded verbatim into the identity chain and handed to the executor on every wake.

Keep it short (a few paragraphs). Long souls are diluted; the agent's role prompt will draw on the soul but it's read as context, not instructions.

## role.md

The operational contract. YAML frontmatter + markdown body (the body is the wake prompt).

### Frontmatter schema (canonical — see `packages/core/src/identity/index.ts`)

```yaml
---
agent_id: "01-research"
name: "Research Agent"
model_tier: balanced # fast | balanced | deep
max_wall_clock_ms: 120000 # 2 min

group_memberships:
  - intelligence

llm: # optional — pin provider/model
  provider: anthropic # gemini | anthropic | openai | ollama
  model: claude-sonnet-4-6 # optional; tier default used if omitted

signals:
  sources: [github-issue, private-note, inbox]
  github_scopes:
    - owner: murmurations-ai
      repo: murmurations-harness
      filter:
        state: open
        since_days: 7
        labels: [action-item]

github:
  write_scopes:
    issue_comments: [murmurations-ai/murmurations-harness]
    labels: [murmurations-ai/murmurations-harness]
    issues: [murmurations-ai/murmurations-harness]
    branch_commits:
      - repo: murmurations-ai/murmurations-harness
        paths: ["docs/**"]

budget:
  max_cost_micros: 500000 # $0.50
  max_github_api_calls: 100
  on_breach: warn # warn | abort

secrets:
  required: [GITHUB_TOKEN]
  optional: [SLACK_WEBHOOK]

tools:
  mcp:
    - name: filesystem
      command: npx
      args: ["-y", "@modelcontextprotocol/server-filesystem", "."]
  cli: []

prompt:
  ref: prompt.md # optional — separate prompt file

---
```

The harness validates this frontmatter with Zod at load time — an invalid schema aborts the daemon. The Spirit can explain specific fields; refer to `packages/core/src/identity/index.ts` when in doubt.

## Signal scopes vs write scopes — don't confuse them

- **`signals.github_scopes`**: what the agent sees on wake. Read-only, filtered.
- **`github.write_scopes`**: what the agent can write to. Enforced at the GitHub client layer. Empty arrays mean read-only.

An agent's write scopes are **least-privilege**. To let an agent comment on issues in one repo but only label issues in another, list each repo explicitly.

## Model tier table

`fast` / `balanced` / `deep` resolve to concrete models via `<root>/murmuration/models.yaml`. If no `models.yaml`, defaults are baked into `packages/llm/src/tiers.ts`.

## Why an agent won't wake — quick checks

1. Not in `DaemonConfig.agents` (did you restart after adding it?)
2. Trigger malformed (`cron` expression invalid, `interval` missing `ms`)
3. Circuit breaker tripped (3 consecutive failures — see last wake log)
4. Missing required secret (check boot log for `secrets.missing`)
5. `max_wall_clock_ms` too low (agent kills itself)
6. Write scopes too narrow for what the wake prompt asks it to do

## Creating a new agent

Scaffold:

```
agents/<agent-id>/
├── soul.md           # identity
├── role.md           # frontmatter + wake prompt
└── prompt.md         # optional, referenced from role.md prompt.ref
```

Restart the daemon after creating. Agents discovered at boot — no hot reload.
