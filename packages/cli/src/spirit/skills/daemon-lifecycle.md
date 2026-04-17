---
name: daemon-lifecycle
description: Starting, stopping, and diagnosing the murmuration daemon
triggers:
  - daemon won't start
  - how do I start the daemon
  - stop the daemon
  - daemon is stuck
  - socket connection problems
  - wake log locations
version: 1
---

# Daemon lifecycle

The daemon is the long-running process that ties the scheduler, executor, and governance plugin together. It owns the Unix socket that the REPL attaches to.

## Starting the daemon

```
murmuration start --root <path> [--name <name>] [--governance <path>]
murmuration start --now                          # override cron, fire an immediate wake
murmuration start --once                         # one-shot: fire once and exit
murmuration start --dry-run                      # validate config without running
murmuration start --log-level debug              # verbose logs
```

`--name` aliases a registered murmuration so subsequent commands can use `--name` instead of `--root`. `murmuration register <name> --root <path>` creates that alias.

## Stopping the daemon

```
murmuration stop [--name <name>]
murmuration restart [--name <name>]
```

`stop` is idempotent — calling it when no daemon runs is not an error. `restart` is `stop` + `start`.

## Socket protocol

The daemon listens on `<root>/.murmuration/daemon.sock` for JSON-lines RPC. Each line is `{id, method, params?}` going in and `{id, result?, error?}` coming back. Events are pushed as `{event, data}` (no id).

Methods include: `status`, `agents.list`, `groups.list`, `events.history`, `cost.summary`, `wake-now`, `directive`, `group-wake`, `stop`. See `packages/core/src/daemon/protocol.ts` for the canonical contract.

## Troubleshooting: daemon won't start

1. **Socket already in use** — another daemon is running or a previous one crashed without cleanup. Check: `ls <root>/.murmuration/daemon.sock`. Remove a stale socket manually if the process is gone.
2. **Missing `GITHUB_TOKEN`** in `.env` when a subsystem expects GitHub. The boot log prints `secrets.missing`. Either add the token or switch `collaboration.provider: local` in `harness.yaml`.
3. **Agent directory malformed** — the identity loader exits on invalid frontmatter. Boot log event: `daemon.boot.aborted`. Read the logged error and fix `role.md`.
4. **Governance plugin resolution failure** — the plugin path in `harness.yaml` couldn't be loaded. Plugins resolve as npm packages first, then relative to the murmuration root.

## Wake logs and digests

- Per-wake log: `<root>/.murmuration/wake-<agent>.log` — JSONL of events for that agent's last wake.
- Digests: `<root>/.murmuration/runs/<agent>/<YYYY-MM-DD>/digest-<hash>.md` — agent's written artifact.
- Group meetings: `<root>/.murmuration/runs/group-<groupId>/<YYYY-MM-DD>/meeting-*.md` (fallback when meeting minutes can't be posted to the collaboration provider).

## Circuit breaker

After 3 consecutive failures an agent is skipped until the next manual trigger. Check agent state via `:agents` or `:wake <agent>` to reset.
