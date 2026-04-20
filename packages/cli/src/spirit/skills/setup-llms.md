---
name: setup-llms
description: How to configure LLM providers (API keys, Ollama) and per-agent model overrides
---

# Setting up LLM Providers

When the operator needs help configuring AI models, setting up local models (Ollama), or fixing circuit-breaker errors related to missing providers, guide them through the LLM configuration.

## 1. Global Default Provider

In `murmuration/harness.yaml`, the global default provider is set. This is what agents use if they don't specify otherwise.

```yaml
llm:
  provider: "gemini" # Options: gemini, anthropic, openai, ollama
```

## 2. API Keys in .env

The harness reads provider keys from the `.env` file at the root of the workspace.
Ensure the operator has the correct variables set for the providers they intend to use:

- `GEMINI_API_KEY=...`
- `ANTHROPIC_API_KEY=...`
- `OPENAI_API_KEY=...`

## 3. Setting up Ollama (Local Models)

If the operator wants to use local models for privacy or cost savings, they can use Ollama.

1. Ensure Ollama is installed and running on their machine (or a reachable network host).
2. Add the base URL to the `.env` file:
   ```
   OLLAMA_BASE_URL=http://localhost:11434
   ```
   _(If Ollama is on another machine, use that IP, e.g., `http://192.168.1.100:11434`)_
3. **Important:** If agents are configured to use `ollama` but the service isn't running or reachable, the daemon's circuit breakers will trip and the agents will fail to wake.

## 4. Per-Agent Overrides (Mixing Models)

A powerful pattern is to use cheaper/faster models (like Gemini Pro or local Ollama) for most agents, but assign an expensive reasoning model (like Claude 3.5 Sonnet) to a specific complex agent (like a Quality Assurance or Architecture agent).

Instruct the operator to edit the specific agent's `role.md` file (e.g., `agents/architect/role.md`) and add frontmatter:

```markdown
---
llm:
  provider: anthropic
  model: claude-3-5-sonnet-latest
---

# Architect Role

...
```

This overrides the global default in `harness.yaml` just for this specific agent.

_Remind the operator to `murmuration restart` after changing `.env` or `harness.yaml`._
