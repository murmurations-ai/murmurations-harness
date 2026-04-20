# Hello-Circle — Murmuration Soul

This is a minimal example murmuration shipped with the Murmuration Harness. Two agents, one group, one directive away from seeing a meeting happen.

## Purpose

Prove that a murmuration can wake, convene, and produce output in under 5 minutes of setup. Not a production template — a demonstration.

## Bright lines

- **No external calls beyond the configured LLM.** No GitHub, no webhook, no crawler. This is a sandbox.
- **No state that matters.** Meeting outputs land in `.murmuration/items/` — locally, ephemerally. Delete the directory and nothing is lost.

## Values

- **Show, don't explain.** The best onboarding is a working meeting, not a tutorial paragraph.
- **Minimum viable configuration.** Every YAML field that can default, does.

See [`../agents/host-agent/role.md`](../agents/host-agent/role.md) and [`../agents/scout-agent/role.md`](../agents/scout-agent/role.md) for the two participants.
