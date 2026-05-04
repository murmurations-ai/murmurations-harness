# Spec 0002 — Spirit Meta-Agent Expansion (v0.7.0)

- **Status:** Draft
- **Owner:** Source (Nori) + Engineering Circle
- **Target release:** Murmuration Harness v0.7.0 (bundled with the agent-effectiveness sweep — Spec 0001)
- **Driver date:** 2026-05-04
- **References:** Spec 0001 (agent effectiveness — sister spec, same release), ADR-0043 (Spirit as meta-agent), ADR-0029 (agent memory), ADR-0024 (Spirit identity), ADR-0038 (Spirit MCP bridge), v0.7.0 J1/J2 (session resume plumbing)

---

## 1. Executive summary

Spirit today is a stateless REPL companion. Every `murmuration attach` starts cold; Source carries the connective tissue between sessions. v0.7.0 turns Spirit into a **per-murmuration meta-agent** that:

1. **Remembers across sessions** — conversation context + curated memory survive detach/re-attach.
2. **Knows itself** — synthesizes a structured model of the murmuration on demand, cached in memory.
3. **Reports clearly** — surfaces health, recent activity, and Source's attention queue as prose, not JSON dumps.
4. **Can be taught** — accepts per-murmuration skills installed via REPL or hand-drop.

Spirit becomes the personal-assistant interface to the murmuration. ADR-0043 contains the architectural decisions; this spec is the implementation plan.

**Why bundled with v0.7.0.** v0.7.0 is the "agent improvement sweep" — Spec 0001 raises agent effectiveness (closure authority, done-criteria, priority bundles, metrics); this spec raises Spirit's effectiveness (cross-attach context, memory, reporting, installable skills) using the same J1/J2/ADR-0029 plumbing. Splitting them would ship two halves of one coherent improvement.

**Scope discipline.** This spec is foundation only — no proactive cron, no project model, no agent-scaffolding interview loop. Those land in v0.7.1 and v0.8 once the foundation is stable. See §13.

---

## 2. Problem statement

### What works today (post-v0.7.0)

- Spirit threads `sessionId` _within_ one attach (J1).
- 15 tools cover daemon RPC, filesystem, governance close, and skill loading.
- 7 bundled skills teach the harness's domain.

### What doesn't

| Gap                        | Cost to Source                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| Re-attach loses everything | Re-explain the murmuration every session; no continuity on multi-day investigations                  |
| No memory                  | Spirit re-reads `harness.yaml`, every `agents/*/role.md`, every `groups/*.md` per question           |
| No murmuration overview    | Asking "what does this murmuration do?" walks 10+ files; answer is not stable across sessions        |
| No reporting synthesis     | `status`, `agents`, `events`, `metrics` each return JSON; Source assembles the narrative             |
| No installation surface    | Operator-specific skill (e.g. "for pricing questions, reference proposal-X") requires a harness fork |

### The fix in one sentence

Give Spirit the same persistence Story v0.7.0 gave agents (J1/J2 + ADR-0029 memory), then build reporting and skill-installation surfaces on top.

---

## 3. Goals and non-goals

### Goals

- After re-attach, Spirit recalls the prior conversation without prompting.
- After re-attach, Spirit references previously-saved facts about Source and this murmuration.
- `report` tool returns a single-page prose synthesis of murmuration health (one tool, one call).
- Operator can install a markdown skill into a running murmuration and have Spirit load it without restart.
- Memory autosave triggers documented; Source has full control via `:remember` / `:forget` / direct file edit.

### Non-goals (explicitly out of scope for v0.7.0)

- Spirit-as-cron-agent (proactive wakes) — v0.8
- First-class project model (`projects/<slug>/`) — separate ADR + spec
- Per-murmuration _tool_ installation (sandboxed runtime) — out of scope
- Web/TUI surface for Spirit memory — REPL only
- Agent-scaffolding interview tools (`scaffold_agent`) — v0.7.1
- Optimization advisor (pattern-recognition over time-series metrics) — v0.7.1

---

## 4. Architecture

### 4.1 Disk layout

```
<root>/.murmuration/spirit/
  conversation.jsonl       — append-only LLM turns (J2 shape)
  session.json             — { "sessionId": "..." } for CLI resume (J1)
  memory/
    MEMORY.md              — index, always loaded into system prompt
    user_*.md              — facts about Source
    feedback_*.md          — corrections + validations
    project_*.md           — what's happening in this murmuration
    reference_*.md         — pointers to external systems
  skills/
    SKILLS.md              — index of operator-installed skills
    *.md                   — skill bodies, lazy-loaded
```

### 4.2 Lifecycle

**At attach (`murmuration attach <name>`):**

1. Spirit client constructs `ConversationStore` rooted at `<root>/.murmuration/spirit/`.
2. `store.load()` rehydrates `conversation.jsonl` and `session.json`.
3. System prompt is built from: hardcoded base prompt (existing) + bundled `SKILLS.md` + per-murmuration `SKILLS.md` (overlay) + `MEMORY.md` index.
4. Spirit greets: "Resumed from <last-turn-timestamp>" or "Fresh attach (no prior context)."

**On every turn:**

1. User message → Spirit client → LLM (with `sessionId` + last user message only when sessionId is set, else full history — same as J1).
2. LLM response captured, including new `sessionId` from result event.
3. Both messages appended to `conversation.jsonl`, `session.json` rewritten if `sessionId` changed.
4. Auto-memory rules in system prompt may trigger `remember(type, name, body)` tool calls.

**On detach (Ctrl-C, terminal close):**

- No flush needed — append-on-turn means disk is at most one turn behind.
- Optionally, `:bye` REPL command writes a "session-end" sentinel to conversation.jsonl for clean attach greetings.

### 4.3 Memory model

Mirrors Claude Code's auto-memory taxonomy verbatim (proven, well-trodden):

| Type        | When written                          | Example                                                                                       |
| ----------- | ------------------------------------- | --------------------------------------------------------------------------------------------- |
| `user`      | Operator role, preferences, knowledge | "Source operates in Pacific time, runs daily standup at 7am"                                  |
| `feedback`  | Corrections + validations from Source | "Don't run full EP murmuration tests — costs ~1/3 daily token allowance. Use `--agent <id>`." |
| `project`   | What's happening in this murmuration  | "v0.7.0 release branch is `feat/v0.7.0-agent-effectiveness`, PR #311 open"                    |
| `reference` | Pointers to external systems          | "EP runbook lives at `Xeeban-AI/00 - Projects/...`"                                           |

`MEMORY.md` is the index — one line per memory file, kept under 200 lines so it fits in the system prompt without pushing skills out.

### 4.4 Tool additions

| Tool                         | Purpose                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `remember(type, name, body)` | Write a memory file + update index                                                                                             |
| `forget(name)`               | Remove a memory file + update index                                                                                            |
| `recall(query?)`             | Search memory; default returns the index                                                                                       |
| `metrics(--since <days>)`    | Wraps `computeMetricsFromDisk` from K1                                                                                         |
| `report(scope?)`             | Synthesizes status + metrics + recent events + governance into prose; `scope` ∈ `health` \| `activity` \| `attention` \| `all` |
| `describe_murmuration`       | Walks `harness.yaml`, `soul.md`, `agents/*`, `groups/*`; caches summary in `project_murmuration_overview.md`                   |
| `install_skill(name, body)`  | Writes per-murmuration skill + updates index                                                                                   |

### 4.5 REPL command additions

| Leader-key command | Effect                                                                 |
| ------------------ | ---------------------------------------------------------------------- |
| `:remember <name>` | Prompt for body, save as Source-explicit memory (type=user by default) |
| `:forget <name>`   | Confirm, then remove memory file                                       |
| `:reset`           | Clear conversation.jsonl + session.json (confirm prompt)               |
| `:reset memory`    | Clear memory directory only (confirm prompt)                           |
| `:report`          | Equivalent to `report all` tool call                                   |
| `:bye`             | Write session-end sentinel + exit                                      |

---

## 5. Workstream breakdown

### Workstream N — Per-murmuration Spirit conversation context

**Goal:** Spirit no longer forgets across attaches.

**Deliverables:**

- New `SpiritContextStore` class (or reuse `ConversationStore` with a Spirit-specific config) at `<root>/.murmuration/spirit/`
- Wire into `packages/cli/src/spirit/client.ts` — load on attach, append on turn
- Greeting on attach: "Resumed from <ts>" vs "Fresh attach"
- `:reset` REPL command with confirmation prompt
- `:bye` REPL command writes session-end sentinel

**Dependencies:** none (J1/J2 plumbing already shipped in v0.7.0).

**Acceptance:**

- Test: attach, send message, detach, re-attach, verify conversation visible in `conversation.jsonl`.
- Test: sessionId from last attach is reused on next attach (when subscription-CLI provider is active).
- Test: `:reset` clears both files; subsequent attach is fresh.
- Smoke: real REPL flow against a live `claude` CLI (`RUN_SUBSCRIPTION_CLI_SMOKE=1`).

### Workstream O — Spirit memory

**Goal:** Spirit accumulates curated facts across attaches.

**Deliverables:**

- `<root>/.murmuration/spirit/memory/` directory created at attach if absent
- New tools: `remember`, `forget`, `recall`
- New REPL commands: `:remember`, `:forget`, `:reset memory`
- System prompt extended with the four-type taxonomy + autosave rules (copied/adapted from Claude Code's auto-memory section)
- `MEMORY.md` index, always rendered into system prompt at attach (truncate at 200 lines)

**Dependencies:** Workstream N (memory directory lives next to conversation.jsonl).

**Acceptance:**

- Test: `remember` tool writes a file + updates index.
- Test: `forget` removes the file + index entry.
- Test: `recall("query")` matches via case-insensitive substring across all memory files.
- Test: `MEMORY.md` truncation at 200 lines preserves frontmatter.
- A real attach session demonstrates auto-memory firing on a "Source said X" pattern.

### Workstream P — Murmuration overview

**Goal:** Spirit answers "what is this murmuration?" with a coherent summary instead of file-walking every time.

**Deliverables:**

- New `describe_murmuration` Spirit tool that walks `harness.yaml`, `murmuration/soul.md`, `agents/*/role.md` (frontmatter only), `governance/groups/*.md`
- Output is structured: governance model, agent count + roles, group structure, wake schedule summary, write scopes summary
- Result auto-written to `project_murmuration_overview.md` in Spirit memory; future calls return the cached version unless `--refresh` is passed
- Cache invalidates if any sourced file's mtime is newer than the cache's mtime

**Dependencies:** Workstream O (writes to memory).

**Acceptance:**

- Test: first call walks files and writes overview; second call reads from cache.
- Test: editing `harness.yaml` invalidates the cache; next call rewrites.
- Test: overview includes every agent dir under `agents/` (no silent skips).

### Workstream Q — Reporting surfaces

**Goal:** Spirit synthesizes operator-readable reports — Source asks one question, gets one answer.

**Deliverables:**

- New `metrics` Spirit tool wrapping `computeMetricsFromDisk` from K1 (no daemon required)
- New `report(scope?)` Spirit tool synthesizing status + metrics + events + governance into prose; scope in `{health, activity, attention, all}`
- New `attention_queue` Spirit tool: failing agents + low met-rate accountabilities + awaiting-source-close items, ranked
- `:report` REPL leader command (alias for `report all`)

**Dependencies:** Workstreams N + O (reports auto-save themselves to `project_*.md` so subsequent attaches start with "since the last report you asked for…").

**Acceptance:**

- Test: `metrics` returns the same shape as `murmuration metrics --json`.
- Test: `report health` includes wake completion rate, error rate, met-rate, governance review count.
- Test: `report attention` ranks items by Source-actionability heuristic (documented in spec).
- Real attach session: ask `:report`, get one screen of useful prose, no JSON dump.

### Workstream R — Per-murmuration skill installation

**Goal:** Operators can teach this Spirit operator-specific patterns without forking the harness.

**Deliverables:**

- `<root>/.murmuration/spirit/skills/` directory created at attach if absent
- `install_skill(name, body)` tool writes `<name>.md` + updates per-murmuration `SKILLS.md` index
- `load_skill` checks per-murmuration first, then bundled (per-murmuration shadows bundled with same name)
- System prompt at attach merges bundled `SKILLS.md` with per-murmuration `SKILLS.md` (per-murmuration shown first)
- Hand-dropped files picked up on next attach

**Dependencies:** none (independent of N/O/P/Q).

**Acceptance:**

- Test: `install_skill("pricing-context", body)` creates the file + index entry.
- Test: `load_skill("pricing-context")` returns the per-murmuration body.
- Test: a per-murmuration skill with the same name as a bundled skill (e.g. `governance-models`) shadows it.
- Test: hand-dropped `<root>/.murmuration/spirit/skills/foo.md` is loadable next attach.

### Workstream S — Documentation + acceptance fixture

**Goal:** v0.7.0's Spirit half ships with the same tag-blocking gate the agent-effectiveness half (Workstream L) provided.

**Deliverables:**

- `docs/CONFIGURATION.md` § Spirit Memory — explain the four memory types, how to edit by hand, how `:reset memory` works, the autosave rules
- `docs/CONFIGURATION.md` § Spirit Skills — install_skill, hand-drop, shadow semantics
- `packages/cli/src/spirit/spirit-meta-fixture.test.ts` — synthetic-corpus-style fixture exercising all five workstreams
- README mention of the feature

**Dependencies:** Workstreams N–R complete.

**Acceptance:**

- Fixture pins memory write/read shape, conversation persistence across simulated attach, report synthesis output.
- All Spec 0001 (A–M) tests still pass.
- `pnpm run check` clean.

---

## 6. Sequencing

Spec 0001 (A–M) is already on `feat/v0.7.0-agent-effectiveness`. Spec 0002 (N–S) lands on the same branch before the v0.7.0 tag.

```
Week 1 (this spec)
  └── Workstream N (cross-attach context) ── load-bearing prereq ────────┐
                                                                          │
Week 2                                                                    │
  ├── Workstream O (memory) ── depends on N ─────────────────────────────┤
  └── Workstream R (skill install) ── independent, parallel ─────────────┘

Week 3
  ├── Workstream P (overview) ── depends on O ───────────────────────────┐
  └── Workstream Q (reporting) ── depends on O ──────────────────────────┘

Week 4
  └── Workstream S (fixture + docs) + tag v0.7.0 (joint with Spec 0001) ─┘
```

Total wall-clock: ~3–4 weeks of focused harness work for the Spirit half. The branch already carries A–M (shipped); N–S extend it. Single tag at the end.

---

## 7. Migration plan

- Single PR per workstream N–S, all merged on the existing `feat/v0.7.0-agent-effectiveness` branch (PR #311).
- Branch is the v0.7.0 release candidate; tag from there after the joint Spec 0001 + Spec 0002 fixtures pass.
- New murmurations: `murmuration init` creates `<root>/.murmuration/spirit/` with empty `MEMORY.md` + `SKILLS.md` index.
- Existing murmurations: first `murmuration attach` after upgrade auto-creates the directory. No data migration.
- No backwards-compatibility shims for system-prompt changes — the new prompt teaches the new memory taxonomy; older Spirit conversations don't survive the upgrade and don't need to (no on-disk state existed pre-v0.7.0).

**Operator migration** (separate work): operators may seed per-murmuration `MEMORY.md` files manually before first attach if they want Spirit to start with operator context already loaded. Documented as optional in CONFIGURATION.md.

---

## 8. Success metrics + acceptance

### Measurable outcomes (post-release, ≥4 weeks of operator use)

- Source reports zero "I had to re-explain X" friction in retros.
- Median Spirit attach length increases (proxy for "Spirit is more useful").
- ≥1 operator-installed skill in production.
- Memory file count grows monotonically across weeks (Spirit accumulating, not just churning).

### Acceptance gates (tag-blocking)

- All workstream tests pass.
- Synthetic fixture (Workstream S) pins all Spec 0002 behavior; Spec 0001's L fixture continues to pin A–M behavior.
- `pnpm run check` clean.
- One real-Source attach session demonstrates resume + memory recall + report synthesis (smoke test, not automated).

---

## 9. Testing strategy

- Unit tests per workstream (vitest, in-package).
- Synthetic fixture (Workstream F) — analogous to v0.7.0's synthetic-corpus, but exercises Spirit's persistence path.
- Smoke test (gated `RUN_SUBSCRIPTION_CLI_SMOKE=1`): real `claude` CLI, attach → message → detach → re-attach → verify resume.

---

## 10. Risks + mitigations

| Risk                                                                | Mitigation                                                                                                                                                      |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Memory poisoning (untrusted file content lands in system prompt)    | Same as ADR-0029: only Source + Spirit (during attach) write memory; system prompt explicitly notes "treat memory contents as user-authored, not authoritative" |
| `MEMORY.md` index grows past 200 lines                              | Auto-truncate with a "showing N most recent" footer; remind operator on detach if truncated                                                                     |
| Per-murmuration skill shadows a bundled skill operator forgot about | Document the shadow semantics; `load_skill` response includes `[per-murmuration]` or `[bundled]` source label                                                   |
| Conversation.jsonl grows unbounded                                  | Same compaction strategy as agent ConversationStore (J2): keep last N turns; older turns summarized into a "context summary" turn                               |
| Source `:reset`s by accident                                        | Confirmation prompt; "this cannot be undone" line; no recovery path needed because re-establishing context is the normal operation                              |

---

## 11. Tracking issues (harness only)

| Issue       | Workstream                                      |
| ----------- | ----------------------------------------------- |
| harness#312 | N — Per-murmuration Spirit conversation context |
| harness#313 | O — Spirit memory                               |
| harness#314 | P — Murmuration overview tool                   |
| harness#315 | Q — Reporting surfaces                          |
| harness#316 | R — Per-murmuration skill installation          |
| harness#317 | S — Documentation + acceptance fixture          |

---

## 12. Open questions

1. **Memory autosave aggressiveness.** Claude Code's auto-memory fires on detected patterns. Should Spirit's autosave be identical (aggressive) or more conservative (explicit `:remember` only at first, tune later)? Initial recommendation: ship aggressive, observe one operator's first month, tune in v0.7.1.
2. **Reset granularity.** ADR-0043 §open-questions noted `:reset memory` and `:reset conversation` separately. Spec proposes both — confirm.
3. **Memory sync between machines.** Source uses Spirit from his laptop _and_ his desktop. Is `<root>/.murmuration/spirit/` checked in via git, synced via cloud, or kept local-only? Recommendation: explicitly _not_ in git (would expose user-type memory in repo); operator decides if they want cloud sync. Document in CONFIGURATION.md.
4. **Subscription-CLI sessionId portability.** Across machines, the CLI's session store is local. Cross-machine attach with the same `sessionId` will fail upstream (CLI returns "session not found"). Spirit should detect this and fall back to fresh-session-with-conversation-replay. Acceptance test required.
5. **First-attach onboarding.** A fresh murmuration's Spirit has no memory. Should we ship a starter `MEMORY.md` template that prompts Source to seed user-type context, or stay empty? Recommendation: empty, with a system-prompt nudge ("If this is the first attach, ask Source what's important about this murmuration") so onboarding flows naturally.

---

## 13. Out-of-scope follow-ups (post-v0.7.0)

- **v0.7.1 — Spirit recommendations.** Optimization advisor that surfaces "agent X has 3 consecutive failures" or "weekly-digest met-rate dropped from 80% to 30% over 2 weeks." Pattern recognition over time-series metrics.
- **v0.7.1 — Agent scaffolding interview.** `propose-new-agent` skill + `scaffold_agent` / `commit_agent` tools. Discovery loop → staging → install.
- **v0.8.0 — Spirit-as-cron-agent.** Spirit wakes on a schedule, emits digest _to Source_ (not GitHub). Mirrors agent pattern but Source-facing. Needs separate ADR (notification surface, schedule semantics, opt-in vs default).
- **v0.8.0 — Project model.** First-class `projects/<slug>/` directory; agents declare project membership; Spirit `project_status(slug)` aggregates relevant signals across the murmuration.

These are flagged here so v0.7.0's foundation is built with them in mind, but they don't gate v0.7.0's tag.
