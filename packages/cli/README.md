# @murmurations-ai/cli

Command-line interface for the Murmuration Harness daemon.

> **Status:** Phase 1A — `start` is the only functional command. Phase 1B adds `status`, `stop` (to a running daemon), and `init`.

## Commands

| Command              | Description                                                                                                   | Status      |
| -------------------- | ------------------------------------------------------------------------------------------------------------- | ----------- |
| `murmuration start`  | Boot the daemon, register agents from the Phase 1A hardcoded registry, fire hello-world wake, wait for SIGINT | ✅ Phase 1A |
| `murmuration status` | Print status of a running daemon                                                                              | ⏳ Phase 1B |
| `murmuration stop`   | Send SIGTERM to a running daemon                                                                              | ⏳ Phase 1B |
| `murmuration init`   | Run `/init-murmuration` interview skill                                                                       | ⏳ Phase 6  |

## Phase 1A usage

```bash
# From the monorepo root
pnpm --filter @murmurations-ai/cli start

# Expected output: JSON-lines log of boot, wake firing, completion
# Press Ctrl+C to shut down cleanly
```

## What the Phase 1A daemon does

1. Constructs a `SubprocessExecutor` with a resolver that maps the hello-world agent to `node examples/hello-world-agent/agent.js`
2. Constructs a `Daemon` with a `TimerScheduler` and one registered agent
3. Schedules the hello-world agent with a `delay-once` trigger (2 seconds)
4. Starts the daemon; the wake fires; the subprocess runs and exits; the daemon logs the result
5. Stays in the foreground until SIGINT / SIGTERM

This proves the wake loop end-to-end: scheduler fires → executor spawns → subprocess runs → result logged → daemon idle but alive. It does not prove anything about real LLM calls, identity doc parsing, or GitHub integration — those are Phase 2+ work.
