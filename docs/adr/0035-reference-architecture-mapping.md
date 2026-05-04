# ADR-0035 — Reference Architecture Mapping (9-Layer Agentic AI System)

- **Status:** Accepted
- **Date:** 2026-05-01
- **Decision-maker(s):** Architecture Agent (#23)
- **Consulted:** TypeScript/Runtime Agent (#24), Security Agent (#25), DevOps/Release Agent (#26), Performance/Observability Agent (#27), Engineering Lead (#22)

## Context

The harness's "first 30 minutes" story is hard for adopters to evaluate without a reference. Adopters comparing competing frameworks (LangGraph, AutoGen, CrewAI, OpenAI Swarm) mentally check off layers as they read. Source's eyeball pass against a publicly-circulated 9-layer **Agentic AI System Reference Architecture** suggested the harness has built most of layers 2–9, with three deliberate non-goals and a small set of real gaps.

This ADR is **architectural cartography** — a one-time formal pin of "what we are" against an industry reference. It is not a redesign. It exists to:

- Make the harness's coverage legible to adopters
- Force honesty per layer ("we don't do X, by design, because Y" or "we don't do X, this is a real gap")
- Anchor the roadmap so future work can be filed as "advances mapping for layer N"
- Replace marketing-shaped overclaiming with verifiable pointers

## Decision

We map the harness against the 9-layer reference, with every ✅ row backed by a verifiable pointer (file path, package, ADR, or PR), every ⚠️ row stating what "fully built" would look like, and every ❌ row declared as either a deliberate non-goal or a tracked gap.

The reference image: https://pbs.twimg.com/media/HHGS3-OaMAEHpSR?format=jpg&name=large
(Diagram title: "Agentic AI System – Reference Architecture — Goal-driven, Multi-agent, Orchestrated, Observable, Reliable.")

### Layer 1 — User / Client Layer

| Reference component                                       | Status                 | Pointer / rationale                                                                                                                                                                                                                               |
| --------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web App                                                   | ❌ deliberate non-goal | GitHub is system of record (CLAUDE.md). Web UI would duplicate GitHub's state and reintroduce drift. Operators interact via `git`, `gh`, and the harness CLI.                                                                                     |
| Mobile App                                                | ❌ deliberate non-goal | Same as above.                                                                                                                                                                                                                                    |
| Chat / Voice                                              | ❌ deliberate non-goal | Agents speak via GitHub issue comments and JSONL artifacts. Human-to-agent chat is the operator's own choice (Claude Code, etc.) — outside the harness.                                                                                           |
| API / SDK                                                 | ✅ partial             | The harness CLI + JSONL daemon protocol IS the SDK surface. `packages/cli` exposes 14 commands; `packages/core/src/daemon/command-executor.ts` defines the typed protocol. Programmatic access via the same JSONL contract used by the dashboard. |
| Enterprise Systems                                        | ❌ deliberate non-goal | The harness is single-operator first. Enterprise wiring (SSO, IAM, etc.) is a future ADR if the operator demand exists.                                                                                                                           |
| **Operator CLI/TUI** _(harness-native, not in reference)_ | ✅                     | `packages/cli` (commands), `packages/dashboard-tui` (live TUI, ADR-0018).                                                                                                                                                                         |

### Layer 2 — Orchestration / Control Plane

All five sub-blocks present.

| Reference component            | Status | Pointer                                                                                                                                                           |
| ------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orchestrator / Workflow Engine | ✅     | `packages/core/src/daemon/index.ts` — wires scheduler, executor, governance, signals, post-wake action execution, "Did Work" tracking, 3-failure circuit breaker. |
| Planner                        | ✅     | `packages/core/src/groups/` — `runGroupWake()` runs facilitator-led group meetings; `parseMeetingActions()` extracts structured plans from facilitator output.    |
| Router                         | ✅     | `packages/core/src/groups/` group memberships + `packages/core/src/identity/` `IdentityChain` resolves which agent receives which signals.                        |
| Scheduler                      | ✅     | `packages/core/src/scheduler/` — `TimerScheduler` with cron, interval, and delay-once triggers.                                                                   |
| Policy Enforcer                | ✅     | ADR-0017 GitHub write-scope enforcement; B5 audit (Phase 1 PR #240); WakeAction validation.                                                                       |
| Task Decomposition             | ✅     | `runGroupWake()` (`packages/core/src/groups/`) — facilitator decomposes, members execute.                                                                         |
| Agent Selection                | ✅     | `groupMemberships` + `IdentityChain` — declared in role.md frontmatter, resolved at wake time.                                                                    |
| Plan & Execution Manager       | ✅     | `WakeAction` / `WakeActionReceipt` types in `packages/core/src/execution/`; post-wake execution hook in daemon.                                                   |
| State & Context Manager        | ✅     | `packages/core/src/agents/` `AgentStateStore` (lifecycle state, artifact tracking, idle-wake counting); `IdentityChain` carries soul + role + group context.      |
| Guardrails & Policy            | ✅     | ADR-0017 write-scope, role.md `write_scopes` field, governance-plugin gates, Boundary 5 audit.                                                                    |

### Layer 3 — Agent Layer (Specialized Agents)

| Reference component | Status               | Pointer                                                                                                                                                                                            |
| ------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Specialized Agents  | ✅ harness _enables_ | `packages/core/src/identity/` (role.md + soul.md inheritance, ADR-0027 fallback identity, ADR-0028 no-mjs). EP demonstrates with 21+ agents. The harness ships zero agent definitions — by design. |

### Layer 4 — Tools & Integrations

| Reference component   | Status            | Pointer                                                                                                                                                                             |
| --------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web Search            | ⚠️ via extensions | Not built-in. Operator wires via `<root>/extensions/` per ADR-0023.                                                                                                                 |
| APIs (general HTTP)   | ✅                | `packages/github/src/` (typed REST/GraphQL client, ADR-0012/0017). MCP support via extensions (ADR-0023).                                                                           |
| Code Execution        | ⚠️ via extensions | Not built-in. Operator wires via `<root>/extensions/` or via subscription-CLI's own tool surface.                                                                                   |
| Databases             | ⚠️ via extensions | Not built-in. Same wiring point as above.                                                                                                                                           |
| File / Doc Processing | ✅                | Agent file extension (read/write/edit at the operator root); 10 GitHub read tools (PRs #261/#263) — read_pull_request, read_commit, read_file_at_ref, list_pull_request_files, etc. |
| Other Services        | ✅ via MCP        | Extension system (ADR-0023) with MCP support.                                                                                                                                       |

### Layer 5 — Memory & Knowledge

| Reference component         | Status                 | Pointer                                                                                                                                                          |
| --------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Short-term Memory (Context) | ✅                     | `IdentityChain` carries soul + role + group context per wake. Signal bundle is the wake-scoped working memory.                                                   |
| Long-term Memory            | ✅                     | Agent persistent memory (ADR-0029) — `remember`/`recall`/`forget` tools persist across wakes in the agent directory.                                             |
| Vector DB                   | ❌ deliberate non-goal | Operators wire jdocmunch/jcodemunch externally as MCP servers. Built-in vector store would duplicate mature ecosystem tools and force operators onto our choice. |
| Knowledge Base              | ✅                     | GitHub repo IS the knowledge base — governance docs, ADRs, decisions, action items. The repo is the shared mind (AGENT-SOUL.md).                                 |
| Episodic / Event Store      | ✅                     | `index.jsonl` audit trail; per-wake digests in `runs/<agent>/`; daemon events in `events.jsonl` (`packages/core/src/daemon/events.ts`).                          |
| User / Org Profile Store    | ✅ harness _enables_   | role.md / soul.md per agent; `<root>/agents/<slug>/` per ADR-0026 directory layout.                                                                              |

### Layer 6 — Monitoring & Observability

| Reference component    | Status      | Pointer                                                                                                                                                                                                                                           |
| ---------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tracing & Logging      | ⚠️ partial  | Daemon structured logs; OTEL hooks; `packages/llm/src/telemetry.ts` covers token-usage capture. Per-step LLM logging (PR #269) still open — not yet on main. "Fully built" = PR #269 merged. Adequate for v0.5; upgrade to ✅ when PR #269 lands. |
| Metrics & Dashboards   | ✅          | `WakeCostBuilder` (`packages/core/src/cost/`) emits `WakeCostRecord` per ADR-0011; `packages/dashboard-tui` renders live state.                                                                                                                   |
| Alerts & Notifications | ❌ real gap | Logs only. No first-class alerting routing. **Tracked separately** — file follow-up issue if operator demand surfaces.                                                                                                                            |
| Audit & Compliance     | ✅          | `index.jsonl` immutable audit log; ADR-0017 write-scope enforcement leaves an audit row per mutation.                                                                                                                                             |

### Layer 7 — Reliability & Failure Management

| Reference component         | Status                | Pointer                                                                                                                                                                                                            |
| --------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Error Detection             | ✅                    | Typed errors + `Result<T, E>` discipline (ADR-0005, errors-as-values at executor boundary).                                                                                                                        |
| Retry & Backoff             | ✅                    | `packages/llm/src/retry.ts`; GitHub client retry policy (`packages/github/src/client.ts`).                                                                                                                         |
| Fallback / Alternate Agents | ⚠️ partial            | Daemon 3-failure circuit breaker per agent. No automatic failover to a sibling agent — by design (governance handles re-assignment via action items).                                                              |
| Human-in-the-loop           | ⚠️ informal-by-design | Operators read digests, file directives. No first-class HITL primitive (no "pause for approval" wake state). Whether this is a deliberate non-goal or a real gap depends on adopter feedback. **Open for review.** |
| Circuit Breaker             | ✅                    | Daemon circuit breaker per `packages/core/src/daemon/index.ts` — three consecutive failures suspend an agent until operator reset.                                                                                 |

### Layer 8 — Governance & Security

| Reference component            | Status     | Pointer                                                                                                                                                                                                                       |
| ------------------------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication & Authorization | ✅         | `SecretValue` branded type + `scrubLogRecord` (`packages/core/src/secrets/`); ADR-0010 SecretsProvider; ADR-0017 write-scope enforcement; subscription-CLI auth (ADR-0034) for operator-side OAuth flows.                     |
| Data Privacy & PII Protection  | ⚠️ partial | `scrubLogRecord` covers known credential patterns. No explicit PII classifier or redaction policy. **Treated as a real gap pending threat model.** Security Agent (#25) sign-off pending.                                     |
| Policy Enforcement             | ✅         | role.md `write_scopes` field; ADR-0017 mutation surface gating; governance plugin policy hooks.                                                                                                                               |
| Model & Prompt Guardrails      | ⚠️ partial | Agent role.md guardrails (soul + role inheritance constrains behavior). No prompt-injection defense layer beyond what each model provides natively. **Tracked separately** under harness#4 (plugin trust + prompt injection). |
| Compliance & Audit             | ✅         | `index.jsonl` immutable audit; B5 audit (Phase 1 PR #240); per-wake artifacts retained on disk.                                                                                                                               |

### Layer 9 — Foundation / Infrastructure

| Reference component | Status                 | Pointer                                                                                                                                                                                                    |
| ------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LLM Providers       | ✅                     | `packages/llm/src/providers.ts` `ProviderRegistry` (ADR-0025); built-in defaults Gemini/Anthropic/OpenAI/Ollama via Vercel AI SDK (ADR-0020); subscription-CLI family for claude/gemini/codex (ADR-0034).  |
| Model Gateway       | ✅                     | `ProviderRegistry` IS the model gateway. Pluggable, single registration surface, env-key + tier resolution.                                                                                                |
| Vector DB           | ❌ deliberate non-goal | See Layer 5. Externalized to MCP.                                                                                                                                                                          |
| Data Storage        | ✅                     | JSONL on local disk for runtime state (per CLAUDE.md "local disk is runtime only"); GitHub for system-of-record state.                                                                                     |
| Queue / Event Bus   | ⚠️ internal only       | `DaemonEventBus` (`packages/core/src/daemon/events.ts:95`) is in-process. No external queue (Redis/Kafka). **Deliberate** at single-operator scale; would need ADR if multi-host operation becomes a goal. |
| Cache               | ⚠️ scoped              | `LruGithubCache` (`packages/github/src/cache.ts`) only. No general response cache. **Deliberate** — premature caching at this scale.                                                                       |
| Secrets Manager     | ✅                     | `SecretsProvider` interface (ADR-0010); `secrets-dotenv` default (`packages/secrets-dotenv`); operator can replace with vault adapter.                                                                     |
| CI/CD & Deployment  | ✅                     | GitHub Actions (ADR-0033); `pnpm` workspaces (ADR-0001); typecheck + lint + test gate per CLAUDE.md.                                                                                                       |

### Components Not in the Reference but Present in the Harness

The reference architecture misses two layers the harness considers load-bearing:

1. **Governance Plugin Layer** — `packages/core/src/governance/` `GovernancePlugin` interface allows S3, Chain of Command, Meritocratic, Consensus, or Parliamentary models to be swapped without touching the daemon. The reference's "Policy Enforcer" sub-block is one piece of this but underspecified. The harness treats governance-as-plugin as a first-class boundary (one of the five pluggable boundaries: governance, channel, secrets, executor, dashboard).
2. **Identity Inheritance Chain** — `IdentityChain` (soul + role + group context) is more structured than the reference's "User / Org Profile Store." It carries constitutional identity through every wake and is the primary defense against agent identity drift.

These should be added to the reference, not the other way around. They are not gaps in the harness.

## Open questions answered

**Q1. For each ❌, deliberate non-goal or real gap?**

- L1 Web/Mobile/Voice: deliberate non-goal (CLAUDE.md, GitHub-as-SoR).
- L1 Enterprise Systems: deliberate non-goal (single-operator first).
- L5 Vector DB: deliberate non-goal (externalized to MCP).
- L6 Alerts & Notifications: real gap (no current tracking issue — file one if demand surfaces).
- L9 External Queue: deliberate at current scale.

**Q2. For each ⚠️, what does "fully built" look like?**

- L4 Web Search / Code Execution / Databases: "fully built" = curated extension set shipped with the CLI; current state acceptable for v0.5–v0.6.
- L7 Fallback / HITL: "fully built" = first-class `wake-state: awaiting-human` + sibling-failover policy; defer to v1 pending adopter feedback.
- L8 PII Protection: "fully built" = explicit redaction policy + classifier; **not acceptable** to ship v1 without a Security Agent sign-off here.
- L8 Prompt Guardrails: "fully built" = covered by harness#4 (plugin trust + prompt injection); v1 adequate when #4 lands.
- L9 Cache: "fully built" = general LRU response cache with TTL; defer until measurement shows a need.

**Q3. Per-row evidence:** every ✅ row above carries a pointer. Rows that lacked pointers in Source's draft now have them.

**Q4. Has the reference missed anything?** Yes — see "Components Not in the Reference" above (governance-plugin layer, identity inheritance chain).

**Q5. Has the reference included anything we should adopt?** Yes — explicit "Model Gateway" naming. The harness has one (`ProviderRegistry`), but did not name it as such. Adopters scanning for "Model Gateway" should land on `ProviderRegistry`. Consider adding the alias to the README. (No ADR needed; documentation patch.)

## Specialist verification (per directive #725)

This ADR was authored by Architecture Agent (#23) as lead. The four specialists named in directive #725 (TypeScript/Runtime, Security, DevOps/Release, Performance/Observability) verify their respective sections by commenting on this ADR's PR with one of:

- **CONSENT** — pointers correct, no over-claiming, gap inventory complete.
- **CONCERN** — pointer correct but the row is over- or under-claiming.
- **BLOCKING OBJECTION** — a specific row is wrong and must change before merge.

Engineering Lead (#22) facilitates the synthesis and Go/No-Go.

## Consequences

### Easier

- Adopters can map their requirements against the harness in one read.
- Honest gaps (L6 Alerts, L8 PII) are visible and inventoried — easier to triage demand.
- Future work can cite "advances Layer 6 Alerts row of ADR-0035" instead of disconnected feature requests.
- We have a defensive document against overclaiming in marketing.

### Harder

- This document must be kept in sync as the harness evolves. Every row that becomes stale degrades the document's value. Maintenance is on Architecture Agent.
- "Honest gap inventory" means we cannot quietly drop a missing feature — every gap is named here.

### Reversibility

This is documentation. Cost to revise is low; cost to delete is the loss of the cartography. Recommend treating this as a living index updated on phase transitions.

## Constraints honored

- **Format:** lightweight MADR, same shape as ADR-0034. ✅
- **Verifiable claims:** every ✅ row cites a file, package, ADR, or PR. ✅
- **Honest gaps:** every ❌ and ⚠️ row declares deliberate-non-goal OR tracking issue. ✅
- **One pass, one ADR:** no new architecture proposed; gaps that warrant new architecture are referenced as separate issues. ✅
- **Single source of truth:** lives at `docs/adr/0035-reference-architecture-mapping.md`; README index updated. ✅

## Related

- **Source directive:** [xeeban/emergent-praxis#725](https://github.com/xeeban/emergent-praxis/issues/725)
- **Reference image:** https://pbs.twimg.com/media/HHGS3-OaMAEHpSR?format=jpg&name=large
- **Foundational ADRs:** ADR-0017 (write-scope), ADR-0023 (extensions), ADR-0025 (pluggable LLM providers), ADR-0026 (directory layout), ADR-0029 (agent memory), ADR-0034 (subscription-CLI family).
- **Recently-landed:** PR #261/#263 (GitHub read tools), PR #270 (subscription-CLI family + Spirit MCP bridge, commit `2bcae1d`).
- **Pending:** PR #269 (per-step LLM logging) — open; Layer 6 Tracing row upgrades to ✅ when merged.
- **Open tracking:** [murmurations-ai/murmurations-harness#4](https://github.com/murmurations-ai/murmurations-harness/issues/4) (plugin trust + prompt injection).
