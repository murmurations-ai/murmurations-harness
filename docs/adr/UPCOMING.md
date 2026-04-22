# Upcoming ADRs

Decisions already made in code or agreed in conversation that still need
a durable ADR to keep the architecture self-consistent. Each entry lists
what exists today, why it deserves an ADR, and the minimal scope to
record.

## A. Decisions made in code but not yet recorded

### A1. Governance plugin bundling convention

**What:** `resolveBundledGovernancePlugin` in `packages/cli/src/boot.ts`
lets operators reference bundled plugins by short name (`s3`) which
resolves to `packages/cli/src/governance-plugins/s3/index.mjs`. The
"governance-specific content lives in `examples/`" rule in CLAUDE.md
contradicts this — the bundled S3 plugin is inside `packages/cli`, not
`examples/`.

**Why ADR:** Pick one boundary and document it. Architecture reviewer
(#11) flagged the contradiction. My read: keep the bundled S3 plugin
inside the CLI so it resolves without an install step, and reduce
`examples/governance-s3/` to a pointer. But this is a real call.

### A2. Post-wake governance event parsing via English prefixes

**What:** `packages/core/src/runner/index.ts` scans LLM output for
`TENSION:` / `PROPOSAL:` / `REPORT:` and emits core-level events keyed
by those kinds. `packages/core/src/daemon/command-executor.ts` has a
`resolveKeywords = ["resolve", "ratif", "approve", "adopt", "agree",
"pass", "consent"]` heuristic.

**Why ADR:** Architecture reviewer blocker #2 — this is governance
terminology leaking into core. Either it's a documented generic
convention every plugin must support, or it's S3-specific and belongs
in the plugin. Pick one.

### A3. Dashboard polls instead of subscribing

**What:** `dashboard-tui/src/dashboard.ts:319` and
`core/src/daemon/dashboard.html:445` refresh on fixed intervals
despite `DaemonEventBus` + SSE existing.

**Why ADR:** Engineering Standard #4 says "events over polling." Either
document why dashboards are exempt (connection-loss fallback, screen-
refresh cadence) or convert. One-paragraph ADR.

### A4. Heartbeat + governance cron as `setInterval`

**What:** Daemon uses `setInterval` in two places for long-running
housekeeping even though `TimerScheduler` exists.

**Why ADR:** Same standard #4 tension as A3. Record the exemption with
its reasoning (scheduler is wake-centric; housekeeping is different).

### A5. `dashboard-tui` reads `.murmuration/*` directly instead of

using the typed daemon API

**What:** `dashboard-tui/src/data.ts` opens `state.json`,
`items.jsonl`, `logs/daemon.log`, and `runs/*/index.jsonl` directly.
The `/api/status` typed contract exists (Engineering Standard #10) but
isn't used.

**Why ADR:** Architecture reviewer should-fix #7. Either ratify direct-
read as the "offline dashboard" mode (daemon not running) and ensure
both modes are first-class, or route everything through the daemon.

### A6. Runs and pipeline moved out of `.murmuration/`

**What:** PR #206 and prior moved `runs/` and `pipeline/` out of the
hidden `.murmuration/` directory to the murmuration root so operators
can see digests and content. Logs stayed hidden.

**Why ADR:** ADR-0026 defines the canonical layout but not this split
between hidden-ops and visible-content. Document the rule.

## B. Pluggable interfaces that parallel Governance but aren't written up

### B1. Strategy plugin (measurement framework)

**What:** `packages/core/src/strategy/index.ts` defines `StrategyPlugin`
with `objectives()` + `assess(metrics)`, plus `NoOpStrategyPlugin`
default. Parallels GovernancePlugin 1:1. Consumed by
`GroupRetrospective.alignment?`.

**Why ADR:** No ADR covers it. Design intent is: each murmuration picks
OKR / KPI / North Star / None independently of its governance model.
Same shape and lifecycle as GovernancePlugin — deserves a peer ADR.

### B2. Collaboration provider ecosystem

**What:** ADR-0021 defines the interface. No ADR lists the intended
provider set (GitHub, Local, GitLab, Azure DevOps, Linear, Notion) or
the contract for a provider to declare graceful degradation when it
can't support part of the interface.

**Why ADR:** Follow-up to 0021 once a second real provider lands.

## C. Future-feature scaffolds tracked in code

These are small carved-out intents. Each needs a short ADR before the
scaffold is grown into a real feature — otherwise the scaffold rots.

### C1. `upstreamAgentIds` on the default runner

Downstream agents reading upstream agents' latest digests at wake time
via `runsDirForAgent`. Parameter exists; no caller ever passes a non-
empty list. Use cases: editorial reads research; publishing reads
editorial.

### C2. `GovernanceRouteTarget.external`

`{ target: "external"; channel: string; ref: string }` — routing
governance events to notification channels outside the harness
(Slack, webhook, email, external dashboards). Not GitHub recording
(built-in) and not process triggering.

### C3. `WakeCostBuilderInit.ceiling`

Budget enforcement hook paired with ADR-0011 §3 "War chest 1% ceiling
integration." Always `null` today; plumbing exists.

### C4. Deferred Signal sources

ADR-0013 §5 lists them: `pipeline-item` (depends on `.pipeline/` reader
— Phase 2), `governance-round` (depends on Governance Plugin Runtime —
Phase 3), `stall-alert` (depends on health checker — not yet scoped).
CF-signals-D is the carry-forward. All three are in the `Signal` union
and the `WellKnownSignalSourceId` enum.

## D. Process / meta

### D1. Pre-1.0 single-operator "no back-compat" stance

**What:** Until we have external operators, we delete legacy code and
historical comments rather than maintaining them. PRs #205/#206
followed this.

**Why ADR:** When we flip to "operators exist," this stance ends. A
short ADR recording the stance + the graduation criteria (first
external operator? v1.0 tag? npm stars threshold?) prevents future
contributors from guessing.

### D2. ADR index automation

**What:** `docs/adr/README.md` table currently stops at ADR-0019.
ADRs 0020–0029 exist on disk.

**Why note:** Not an ADR itself but worth a one-line step in the release
checklist. Architecture reviewer #9 flagged this.

---

**How to use this file:** When you start a feature that touches any of
these items, promote the relevant entry to a real `NNNN-title.md` ADR
and remove it from this list. When adding a new item, include enough
context that a future you (or a new contributor) can act on it cold.
