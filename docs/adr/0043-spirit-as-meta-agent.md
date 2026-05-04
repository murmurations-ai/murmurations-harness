# ADR-0043 — Spirit as a meta-agent: per-murmuration context, memory, and scaffolding authority

- **Status:** Proposed
- **Date:** 2026-05-04
- **Decision-maker(s):** Source (Nori), Engineering Circle
- **Driver:** Spirit today is a stateless REPL companion: every `murmuration attach` starts cold. Source ends up re-explaining the murmuration, re-asking the same diagnostic questions, and acting as the connective tissue between sessions. The same diagnosis ADR-0029 made for agents (`agents wake context-free`) applies to Spirit at the operator boundary.
- **Related:** ADR-0019 (persistent-context executor), ADR-0023 (extension system), ADR-0024 (Spirit identity flow), ADR-0029 (agent persistent memory), ADR-0038 (Spirit MCP bridge), harness#293 (session resume).

## Context

The v0.7.0 K3 Spirit tools (`get_facilitator_log`, `get_agreement`, `list_awaiting_source_close`, `close_issue`) gave Source a thin window into the murmuration. The window is read-only, reactive, and amnesiac. Three structural gaps remain:

1. **No cross-attach context.** J1 (subscription-CLI session resume) and J2 (daemon wake-to-wake resume) closed this gap for agents. Spirit threads `sessionId` _within_ a single attach but loses everything on detach. Re-attaching tomorrow starts a new conversation with no memory of yesterday's discussion.
2. **No curated knowledge.** Agents got `@murmurations-ai/memory` in ADR-0029 — a structured place to write learnings that survive across wakes. Spirit has nothing equivalent. It re-reads `harness.yaml`, `soul.md`, and every `agents/*/role.md` on every question.
3. **No installation surface.** Spirit's skills are compiled into the binary. Source cannot teach this murmuration's Spirit something specific to _this_ operator's context (e.g. "when discussing pricing, always reference the bundle decision in proposal-2026-05-04-priorities") without forking the harness.

The vision Source has articulated — Spirit interviews for new agents, installs skills, reports proactively, owns a model of the murmuration, acts as personal assistant — is not reachable until those three gaps close. They are load-bearing on each other: a Spirit that forgets cannot accumulate a model; a Spirit without a skill surface cannot be taught the operator's patterns; a Spirit without memory cannot recommend optimizations because it has no time-series of what has been tried.

## Decision (proposed)

We ship Spirit as a **per-murmuration meta-agent** with three new persistent surfaces. All three live under `<root>/.murmuration/spirit/`. None pollute the `agents/` namespace — Spirit is not in the governance graph by design (ADR-0024) and stays outside it.

### Part 1 — Cross-attach conversation context

Spirit's REPL gets its own `ConversationStore` (the same class daemon agents use, J2). Storage:

```
<root>/.murmuration/spirit/
  conversation.jsonl    — append-only LLM turns (same shape as agents')
  session.json          — { "sessionId": "..." } for subscription-CLI resume
```

**Lifecycle:**

- `murmuration attach` reads `session.json` and rehydrates `conversation.jsonl` if either exists. Spirit picks up where the prior attach left off.
- Every turn appends to `conversation.jsonl` and persists the new `sessionId` (J1 plumbing already captures it from `claude --resume`, `codex exec resume`).
- Detach is implicit (Ctrl-C, terminal close). No flush needed — append-on-turn means the disk is always at most one turn behind.
- New REPL command `:reset` clears both files (with confirmation prompt) for fresh starts.

**Why per-murmuration scoping.** A user with three murmurations should have three Spirits with three distinct mental models. Global scoping bleeds context across operator domains and would force Spirit to re-establish "which murmuration are we in" every turn.

**Why JSONL not SQLite.** Same reasoning as ADR-0029: text-grep-able, single-writer-safe, recoverable from corruption by hand-edit, no migration story to maintain.

### Part 2 — Spirit memory

Mirrors ADR-0029 for agents but scoped to Spirit. Storage:

```
<root>/.murmuration/spirit/memory/
  MEMORY.md              — index, always loaded into the system prompt
  user_*.md              — facts about Source (preferences, role, context)
  feedback_*.md          — corrections + validations from Source
  project_*.md           — what's happening in this murmuration (drift fast)
  reference_*.md         — pointers into external systems (Linear, Slack, etc.)
```

The four memory types come from Claude Code's auto-memory system — proven taxonomy, well-trodden. Spirit's system prompt teaches the same `<types>` rules.

**Loading:** at attach, Spirit reads `MEMORY.md` (always) and lazy-loads individual memory files when relevant (same pattern as `load_skill`).

**Writing:** auto-memory rules in the system prompt (when to save user/feedback/project/reference) plus an explicit `:remember` REPL command and `remember(type, name, body)` tool. Source can also edit memory files directly — they're plain markdown.

**Why mirror agent memory exactly.** Operators learning the harness should not have to learn two memory systems. Agent memory and Spirit memory share the topic-per-file + index pattern. The only difference is the location (`agents/<id>/memory/` vs `.murmuration/spirit/memory/`) — driven by Spirit not being an agent.

### Part 3 — Per-murmuration skill installation

Today Spirit's skills are compiled in (`packages/cli/src/spirit/skills/`). v0.8.0 adds an overlay:

```
<root>/.murmuration/spirit/skills/
  SKILLS.md             — index of operator-installed skills
  *.md                  — skill bodies, loaded on demand by load_skill
```

**Loading order:** at startup, Spirit merges the bundled `SKILLS.md` index with the per-murmuration index. On `load_skill(name)`, it checks per-murmuration first, then bundled. Per-murmuration skills shadow bundled skills with the same name.

**Installation:** new tool `install_skill(name, body)` writes the file and updates the index. Source can also drop files in by hand — Spirit picks them up on next attach.

**Why not extensions.** ADR-0023 extensions target _agents_ and load via `tools.mcp` declarations in `role.md`. Spirit isn't an agent. Forcing Spirit through the extension system would couple two unrelated lifecycles. Skills are markdown — no runtime, no sandbox, no MCP server. The simplicity is the point.

## Consequences

**Positive:**

- Spirit accumulates a model of the murmuration over weeks of use. The "personal assistant who knows your domain" experience becomes possible.
- Cross-attach context closes the parity gap with agents (J1/J2 already shipped for them).
- Operators can teach this Spirit operator-specific patterns without forking. The murmuration becomes the unit of context, which matches how Source already thinks about it.

**Negative / costs:**

- Three new directories under `.murmuration/spirit/` — operators need a one-line note in CONFIGURATION.md.
- Memory poisoning surface (ADR-0029 §amendment) applies here too — anything that writes to disk is a vector. Spirit's writers are: Source via `:remember`, Spirit via auto-memory rules. Both are gated on Source intent (Spirit auto-memory only fires inside an attach session).
- `:reset` is destructive — needs a confirmation prompt and a "this cannot be undone" line.

**Out of scope for ADR-0043 (and v0.8.0):**

- **Spirit-as-cron-agent** (Spirit wakes on a schedule, emits digests to Source). The persistent-context plumbing this ADR ships _enables_ that future, but the cron loop, source-facing digest format, and proactive notification surface are deferred to v0.9.
- **First-class project model.** Murmurations don't yet have a `projects/` directory. Spirit's vision includes "report on project progress" — that needs a separate ADR establishing the project concept first.
- **Tool installation** (vs skill installation). Compiled tools stay compiled in v0.8. Per-murmuration _tools_ would mean a sandbox runtime; not yet justified.

## Migration

- New murmurations: `murmuration init` creates `<root>/.murmuration/spirit/` with empty `MEMORY.md` and `SKILLS.md` index.
- Existing murmurations: first `murmuration attach` after upgrade auto-creates the directory. No data migration.
- Operators with existing Spirit conversations: those conversations are not preserved — there is no prior on-disk state to migrate. The first post-upgrade attach starts fresh, and persistence begins from that point forward.

## Alternatives considered

- **Global Spirit memory** (`~/.murmuration/spirit/`). Rejected: bleeds context across murmurations, makes "which murmuration are we in" an explicit per-turn concern, breaks Source's mental model where the murmuration is the unit.
- **Reuse `@murmurations-ai/memory` extension directly.** Rejected: the extension's loading machinery couples to agent identity (`agentId`). Spirit isn't an agent. Subclassing or generalizing the extension is more work than re-implementing the topic-per-file pattern at Spirit's REPL boundary.
- **Persist conversation in the daemon, not on disk.** Rejected: the daemon may not be running when Source attaches (Spirit attaches even without a running daemon — `:start` boots one). Disk-first matches J2's choice and keeps Spirit functional in any daemon state.

## Open questions

1. **Memory autosave triggers.** Claude Code saves on detected patterns ("user said X", "user corrected Y"). Should Spirit's autosave be identical, or more conservative (explicit `:remember` only, until the patterns are tuned)?
2. **Reset granularity.** `:reset` clears everything. Do we also need `:reset memory` and `:reset conversation` separately?
3. **Skill name collisions.** When per-murmuration `governance-models.md` shadows the bundled one, do we warn at attach? Silent shadow is the simpler default.

These are answerable in the spec, not in this ADR.
