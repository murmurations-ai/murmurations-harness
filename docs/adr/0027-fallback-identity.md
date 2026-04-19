# ADR-0027 — Fallback identity for incomplete agent directories

- **Status:** Accepted (shipped v0.4.4)
- **Date:** 2026-04-19
- **Decision-maker(s):** Source
- **Related:** ADR-0016 (role template), ADR-0023 (extension system), ADR-0024 (Spirit of the Murmuration)
- **Issue:** #112

## Context

The `IdentityLoader` enforced a strict two-file layout per agent:
`agents/<id>/soul.md` + `agents/<id>/role.md` with complete YAML
frontmatter. When Source scaffolded a directory without filling in
both files, boot either crashed (`IdentityFileMissingError`,
`FrontmatterInvalidError`) or silently skipped the agent depending on
the call site. That's a poor iterative workflow — especially when
bootstrapping via the Spirit agent, or when a new dyad is
experimenting with the framework and doesn't yet know what `role.md`
needs to look like.

## Decision

### §1 — Opt-in fallback on `IdentityLoader`

Construct the loader with `fallbackOnMissing: true` to synthesize a
generic identity when `soul.md` / `role.md` is missing or the role's
frontmatter is absent/invalid. Callers can supply `onFallback(agentDir,
reason)` to get a structured signal and log/display it. When the flag
is off (the default), the existing errors still surface — no silent
behavior change for tests or strict production deployments.

`LoadedAgentIdentity.fallback` is populated on the result so callers
know the agent was synthesized rather than loaded.

### §2 — Two-tier default: operator template, then built-in

The fallback content is resolved in priority order:

1. **Operator template** — `<root>/murmuration/default-agent/soul.md`
   and `role.md`, if present. `{{agent_id}}` tokens in the content
   are replaced with the agent's directory name. This gives each
   murmuration a single place to tune the "default agent" character
   without patching the harness.
2. **Built-in default** — shipped inside
   `@murmurations-ai/core/identity`. A functional (not-inert) identity
   that declares `model_tier: balanced`, modest budget, empty plugin
   list (the files plugin is still auto-included for local governance
   via v0.4.3's `selectExtensionToolsFor`), and no GitHub write
   scopes.

### §3 — `murmuration init` copies the operator template

`runInit` materializes `<target>/murmuration/default-agent/{soul,role}.md`
from the CLI's shipped copies (`packages/cli/src/default-agent/`). The
"next steps" output tells the operator to review and edit those files
as part of their scaffolding. No flag, no prompt — the files are
always copied so every murmuration starts out operator-tunable.

### §4 — Daemon wires `fallbackOnMissing: true`

`packages/cli/src/boot.ts` constructs the daemon's `IdentityLoader`
with the flag on and an `onFallback` that logs `daemon.agent.fallback`
at `warn`. Production runs surface a visible line per fallback; tests
and tools that import `IdentityLoader` directly keep the strict
behavior by default.

## Consequences

- **Positive:** Source can scaffold `agents/<name>/` and wake the
  daemon without first authoring full governance files.
- **Positive:** Operators control the "new-agent default" by editing
  a single pair of markdown files; they don't need to fork the
  harness or wire a flag.
- **Positive:** Spirit-assisted bootstrapping becomes feasible — the
  Spirit can create an agent directory and the harness keeps
  running while it fills in the soul/role.
- **Negative:** `IdentityLoader` picked up one more responsibility
  (template resolution with interpolation). Contained inside two
  private methods; tests cover the precedence.
- **Negative:** Fallback agents have modest budgets and no write
  scopes — if an operator expects them to do work, they'll notice
  quickly. This is intentional (fail-safe), but it must be
  documented in the "next steps" output and the ADR.

## Test plan

`packages/core/src/identity/identity.test.ts` exercises:

- Synthesizing a fallback when both files are missing (onFallback
  fires, `loaded.fallback.reason === "missing-files"`)
- Synthesizing a fallback when only `soul.md` is missing
- Preserving `IdentityFileMissingError` when `fallbackOnMissing` is
  not set
- Operator template precedence + `{{agent_id}}` interpolation

`packages/cli/src/init.ts` materializes the templates into
`murmuration/default-agent/`; this is covered implicitly by anyone
running `murmuration init` + inspecting the scaffolded directory.
