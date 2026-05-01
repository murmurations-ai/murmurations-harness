---
name: setup-llms
description: How to configure LLM providers (subscription CLIs, API keys, Ollama) and per-agent model overrides
---

# Setting up LLM Providers

When the operator needs help configuring AI models, setting up local models (Ollama), or fixing circuit-breaker errors related to missing providers, guide them through the LLM configuration.

There are three routes:

1. **Subscription-CLI** (recommended for new operators): route through Claude Code, Codex, or Gemini CLI. $0 marginal cost — your existing Pro/Max, ChatGPT, or Google subscription pays for it. No API key needed.
2. **API**: Direct provider API with a key in `.env`. Pay-per-token.
3. **Local (Ollama)**: Self-hosted models. Free; quality varies by hardware.

## 1. Global Default Provider

In `murmuration/harness.yaml`:

**Subscription-CLI route (recommended if you have Claude Pro/Max, ChatGPT, or Google subscription):**

```yaml
llm:
  provider: "subscription-cli"
  cli: "claude" # or "codex" / "gemini"
  model: "claude-sonnet-4-6" # see defaults below
```

Defaults per CLI:

- `claude` → `claude-sonnet-4-6` (override to `claude-opus-4-7` for deeper thinking)
- `codex` → `gpt-5.5`
- `gemini` → `gemini-2.5-flash` (override to `gemini-2.5-pro` for hard work)

**API route:**

```yaml
llm:
  provider: "gemini" # Options: gemini, anthropic, openai, ollama
```

`murmuration init` auto-detects installed CLIs and offers the subscription-CLI route as the default when one is present.

## 2. API Keys in .env (API route only)

Skip this section if you're using subscription-CLI — auth lives in the CLI's own state, not `.env`.

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

A powerful pattern is to use cheaper/faster models (Sonnet, flash, mini) for most agents, but assign a deeper reasoning model (Opus, gpt-5.5, pro) to a specific complex agent (like Architecture or Engineering Lead).

Edit the specific agent's `role.md` (e.g., `agents/architect/role.md`) frontmatter:

**Subscription-CLI override:**

```markdown
---
llm:
  provider: subscription-cli
  cli: codex
  model: gpt-5.5
  timeoutMs: 540000 # 9 min — must be < agent.maxWallClockMs
---
```

**API override:**

```markdown
---
llm:
  provider: anthropic
  model: claude-opus-4-7
---
```

This overrides the global default in `harness.yaml` just for this specific agent.

## 5. Cost Tracking

The harness tracks two cost fields per wake:

- `llm.costMicros` — actual spend (always $0 for subscription-CLI)
- `llm.shadowCostMicros` — what subscription-CLI wakes _would_ have cost on the equivalent API path (always undefined for direct API wakes)

The TUI's "Cost & Wakes" panel shows a "Saved (subscription)" line in green when the fleet is routing through subscription CLIs. The "Subscription usage" sub-panel shows tokens consumed today / 7d per (provider, model) — vendors don't expose remaining-quota, so operators compare against their plan's published allowance.

## 6. Subscription Rate Limits

When a subscription hits its quota window, the daemon surfaces an `LLMRateLimitError` (HTTP-equivalent 429). The agent state machine treats it as a transient failure with operator-configurable retry. There's no auto-wait-for-refresh — operators see the typed error in the daemon log and either wait for the quota window to reset or switch the affected agent to a different CLI / API in `role.md`.

_Remind the operator to `murmuration restart` after changing `.env` or `harness.yaml`._
