# ADR-0046 — Phase 3: Governance Plugin Extraction

- **Status:** Accepted
- **Date:** 2026-05-08
- **Decision-maker(s):** Source (Nori), Engineering Lead

## Context

Through Phase 1–2, governance-model vocabulary leaked into `@murmurations-ai/core`:

1. **S3 tier label constants** — `TIER_AUTONOMOUS_LABEL`, `TIER_NOTIFY_LABEL`, and
   `TIER_CONSENT_LABEL` were exported from `packages/core/src/labels/index.ts`.
   Only `TIER_CONSENT_LABEL` was consumed elsewhere (in `packages/signals/src/priority.ts`),
   but their presence in core violated the harness principle that governance-specific
   vocabulary belongs in plugins, not the runtime.

2. **Weak plugin error surface** — callers of `GovernancePlugin.onEventsEmitted` and
   `evaluateAction` had no typed way to distinguish plugin-init failures from
   event-processing failures from timeouts. All errors surfaced as bare `Error`.

3. **No compat contract** — there was no mechanism for a plugin to declare which
   versions of harness core it supports, so breaking changes to the plugin interface
   were silent until runtime.

4. **Multi-circle routing unvalidated** — MURMURATION-HARNESS-SPEC.md §18.8 left
   open the question of whether parallel-rounds-with-Source-escalation was the right
   default for events touching multiple circles. No code-level test documented the
   contract.

## Decision

### 1. Remove S3 tier label constants from core

Delete `TIER_AUTONOMOUS_LABEL`, `TIER_NOTIFY_LABEL`, and `TIER_CONSENT_LABEL` from
`packages/core/src/labels/index.ts`. Inline `"tier:consent"` as a local constant in
`packages/signals/src/priority.ts` — the only consumer — rather than re-exporting
it through core. S3-specific labels belong in the S3 governance plugin.

### 2. Typed plugin error taxonomy

Add three named error classes to `packages/core/src/governance/index.ts`:

- `PluginInitError` — thrown during `onDaemonStart`; signals misconfiguration or
  missing external dependencies at boot time.
- `PluginEventError` — thrown by `onEventsEmitted` or `evaluateAction`; signals a
  recoverable processing failure on one event batch.
- `PluginTimeoutError` — thrown (or wrapped by the daemon) when a plugin call
  exceeds a configurable deadline.

These classes are `instanceof`-checkable, carry the `name` discriminant, and support
`ErrorOptions.cause` for wrapping upstream errors.

### 3. Plugin compatibility range field

Add `compatibleCoreVersionRange?: string` to the `GovernancePlugin` interface.
Add `satisfiesCoreVersionRange(coreVersion, range)` as a pure helper in core.
Wire a boot-time check in `packages/cli/src/boot.ts`: if the plugin declares a range
and `HARNESS_VERSION` does not satisfy it, abort with `PluginInitError` before the
daemon starts. Omitting the field skips the check (permissive / in-tree plugins).

The range syntax is a space-delimited list of conditions of the form `>=X.Y.Z`,
`>X.Y.Z`, `<=X.Y.Z`, `<X.Y.Z`, `=X.Y.Z`. All conditions must be satisfied (AND
semantics). This covers the common `>=0.9.0 <1.0.0` pattern without requiring a
semver package dependency in core.

### 4. Multi-circle routing contract — parallel rounds with Source escalation

Adopt the spec default: events touching multiple circles are routed in parallel.
`GovernancePlugin.onEventsEmitted` returns `GovernanceRoutingDecision[]`, each
of which carries a `routes` array that may contain N `{ target: "agent" }` entries
(one per circle) plus an optional `{ target: "source" }` for escalation when
conflict is anticipated.

Document this contract in `governance.test.ts` with four canonical cases:

1. One event → three agent routes (parallel fan-out)
2. One event → one agent route + one source route (escalation)
3. One event → one discard route (filtered out)
4. Empty decisions array (plugin chose not to route)

The alternative — a single "primary circle" model — was considered (see below) but
deferred to a future ADR if the parallel model proves operationally expensive.

## Consequences

**Easier:**

- Third-party plugin authors get typed errors to catch and log.
- Plugins can declare version compatibility and fail loudly at boot rather than
  silently misbehaving at runtime.
- Core no longer leaks S3 vocabulary; new governance models (chain-of-command,
  meritocratic, consensus) start from a clean baseline.
- The multi-circle routing contract is machine-checkable — any plugin can be tested
  against the four canonical cases.

**Harder:**

- Plugins that used to `import { TIER_CONSENT_LABEL } from "@murmurations-ai/core"`
  must inline the string. (Only one internal consumer existed; the migration is
  complete as of this ADR.)
- Range-checking logic is bespoke (not a full semver library). It handles `>=`,
  `>`, `<=`, `<`, `=` but not `^` (caret) or `~` (tilde) shorthand. Operators who
  need those forms must expand them to explicit range pairs.

**Reversibility:** Low cost. Removing the tier constants is a rename; the error
classes can be deprecated without breaking callers; the interface field is optional.

## Alternatives considered

### Single "primary circle" routing

Each multi-circle event picks one primary circle, runs one consent round there, and
notifies other circles without requiring their consent. Lower coordination cost,
clearer single point of decision. Deferred: the parallel model is more faithful to
S3 and can be tuned to the single-primary model by a plugin that always returns
exactly one agent route.

### Semver package dependency in core

Use the `semver` npm package for range parsing. Rejected to avoid adding a runtime
dependency to `@murmurations-ai/core`. The bespoke range parser covers all patterns
used in this codebase.

### Keep tier label constants, add deprecation JSDoc

Rejected. A `@deprecated` tag is not a compile-time error; the constants would
remain exported indefinitely. Hard deletion at the Phase 3 gate is the right call
while there are no external operators pinned to the current API.
