---
# Fallback identity per ADR-0027. `{{agent_id}}` placeholders are
# replaced with the agent's directory name at load time.
agent_id: "{{agent_id}}"
name: "Default Agent ({{agent_id}})"
soul_file: "soul.md"
model_tier: "balanced"
max_wall_clock_ms: 60000

group_memberships: []

llm:
  provider: "gemini"

signals:
  sources:
    - "private-note"

github:
  write_scopes:
    issue_comments: []
    branch_commits: []
    labels: []
    issues: []

budget:
  max_cost_micros: 50000
  max_github_api_calls: 0
  on_breach: "warn"

secrets:
  required: []
  optional:
    - "GEMINI_API_KEY"

tools:
  mcp: []

plugins: []
---

# Default Agent — Role

Fallback role for agent directories that don't define their own `role.md`. In hello-circle, both real agents have their own; this file only kicks in if you scaffold a third.

## Accountabilities

I respond to directives from the Source (you) and from meeting facilitators. I produce short, focused contributions and stop.
