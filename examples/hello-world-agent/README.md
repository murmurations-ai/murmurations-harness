# hello-world-agent

The simplest possible agent the harness can wake. No LLM, no identity doc, no real reasoning. Phase 1A only — exists to prove the wake loop is structurally correct.

## What it does

1. Reads `MURMURATION_WAKE_ID`, `MURMURATION_AGENT_ID`, and `MURMURATION_SPAWN_CONTEXT` from the environment
2. Prints three `::wake-summary::` lines to stdout following the Phase 1A output protocol
3. Exits with status 0

## The Phase 1A output protocol

Any line starting with `::wake-summary::` is appended to the wake summary. Any line starting with `::governance::<kind>::` is parsed as a governance event payload.

```
::wake-summary:: hello from agent hello-world, wake abc-123
::governance::tension:: {"title": "example tension", "body": "..."}
```

The protocol is parsed by `parseChildOutput` in `packages/core/src/execution/subprocess.ts`. It is intentionally minimal and will be replaced in Phase 2 with a real structured output contract.

## Run manually

```bash
MURMURATION_WAKE_ID=test MURMURATION_AGENT_ID=hello-world \
  node examples/hello-world-agent/agent.mjs
```

## Run via the harness

```bash
# Build first
pnpm build

# Boot the daemon
pnpm --filter @murmuration/cli start
```

The daemon will fire a wake at this agent after a 2-second delay, capture the output, and log the completion.
