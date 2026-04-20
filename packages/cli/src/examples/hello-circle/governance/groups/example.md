# Example Group

## Purpose

The `example` group is the one group in the hello-circle murmuration. Its only purpose is to hold a meeting when the operator runs `murmuration group-wake`. Production murmurations have domain-specific groups; this one exists only to demonstrate the mechanics.

<!-- Harness-parseable metadata per ADR-0026 / group-wake.ts parser. -->

## Members

- host-agent
- scout-agent

facilitator: host-agent

## What to expect

Run:

```sh
murmuration group-wake --group example --directive "what should we scout next?"
```

The host invites scout's observation, synthesizes a summary, proposes a next step. The meeting minutes land in `.murmuration/items/` (local collaboration).

When you're ready to move past hello-circle: use `murmuration init` (no `--example`) to scaffold a real murmuration with your own groups and agents.
