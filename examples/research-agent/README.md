# Research Agent example

This example ships the Murmuration Harness' first realistic agent: **Research Agent #1**, ported from the Emergent Praxis governance layer. The source material is:

- Identity: [`governance/agents/01-research-agent.md`](https://github.com/xeeban/emergent-praxis/blob/main/governance/agents/01-research-agent.md) (ratified Issue #31, 2026-03-17)
- Manifest: [`governance/agents/manifests/01-research-agent.yaml`](https://github.com/xeeban/emergent-praxis/blob/main/governance/agents/manifests/01-research-agent.yaml) (v1.0, authored 2026-03-21 by Wren #7)

See `agents/01-research/role.md` §Deliberate divergences for the Phase 2 differences between this harness example and the EP manifest.

Unlike the `hello-world-agent` example, this one exercises the **full** Phase 2 composition root:

- Frontmatter extensions from ADR-0016 — `llm`, `signals`, `github.write_scopes`, `budget`, `secrets`, `prompt`
- The GitHub mutation surface from ADR-0017 — writing the weekly digest to `notes/weekly/**` via `createCommitOnBranch`
- The four-provider LLM client from ADR-0014 — pinned to **Gemini 2.5 Pro** for the Phase 2 dual-run; swappable to Ollama for free dev loops
- The pricing catalog from ADR-0015 — every wake emits a non-zero `WakeCostRecord.llm.costMicros`
- The signal aggregator from ADR-0013 — reads issues across `xeeban/emergent-praxis` and `murmurations-ai/murmurations-harness`

## Status

- **Identity chain (soul.md + role.md + circle context):** ported from EP, ready to load
- **Wake prompt (`prompts/wake.md`):** ported verbatim from the EP manifest's weekly cron trigger prompt, adapted for the harness runtime (identity already loaded, digest-as-file-commit per ADR-0017, Discord out of scope). Phase 2C4 1:1 mirror gate resolved against manifest v1.0.

## Running

Phase 2D3's `bootHelloWorldDaemon` is hardcoded to the `hello-world-agent` example. A follow-up harness change is needed to accept `--root` / `--agent` CLI args so this example can be booted. Until then, the identity files are validated by `IdentityLoader.load("01-research")` unit tests and by the frontmatter parse.

## Cadence

`wake_schedule.cron: "0 18 * * 0"` — Sunday 18:00 UTC (per Phase 2 plan 2D4; configurable). The existing OpenClaw Research Agent runs Monday 06:00 PT; the different cadence ensures the dual-run doesn't collide.

## Provider swap proof

Change one line in `role.md`:

```yaml
llm:
  provider: "ollama"
  model: "llama3.2"
```

…and the same wake runs free and locally against mothership.local (or wherever `OLLAMA_BASE_URL` points). This is the Phase 2C7 provider-swap demonstration.
