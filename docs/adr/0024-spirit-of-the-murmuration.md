# ADR-0024 — Spirit of the Murmuration

- **Status:** Proposed
- **Date:** 2026-04-17
- **Decision-maker(s):** Source (design)
- **Related:** ADR-0018 (CLI tmux interface / REPL), ADR-0019 (persistent context), ADR-0020 (Vercel AI SDK), ADR-0021 (CollaborationProvider), ADR-0022 (Langfuse self-reflection), ADR-0023 (Extension system)

## Context

The REPL (`murmuration attach`) currently routes every input through a fixed command table. Inputs that don't match a verb return an "unknown command" error. This is correct for a command interface but discards a latent opportunity: the operator is alone in the terminal with a rich body of knowledge — agent souls, governance state, configs, events — that a conversational LLM could make legible and actionable.

The operator is **Source**: the sovereign, outside the governance graph by design. They bear ultimate agency and responsibility for what the murmuration does. They may delegate decisions to the agent fabric via governance, but they retain the authority to act directly — edit roles, change souls, stop and start daemons, file directives.

What the operator lacks is a companion that:

1. **Knows the murmuration intimately** — its soul, active agents, current governance state, recent events, configuration, and operator history
2. **Understands the harness codebase** — enough to explain what a setting does, why a daemon won't start, how to wire a new agent
3. **Maintains relationship continuity** — remembers what the operator cares about, what they've tried, what worked and didn't, what they asked about last week
4. **Acts on operator intent** — can make changes (with confirmation), never independently
5. **Compounds knowledge over time** — gets better at helping _this_ operator run _this_ murmuration, not a generic harness

This ADR names that companion **the Spirit of the Murmuration**, specifies its architecture, and defines the knowledge-management system that lets it develop a solid relationship with the operator across sessions.

### On the name

"Ghost" was considered and rejected. A ghost is absent, past-tense, an echo. A **spirit** is the animating force — the thing that makes the armor move. The operator is the person inside the suit; the Spirit is what lets them move the armor precisely. This metaphor anchors the whole design: the Spirit has no authority of its own, but it makes the operator's authority reach further.

## Decision

### §1 — The Spirit's position in the architecture

The Spirit is **not** a registered agent. It is:

- **Operator-facing** — it serves the Source, not the fabric
- **Outside governance** — it has no role.md, no governance obligations, no consent to seek
- **A tool, not a member** — lives in the CLI package (`packages/cli/src/spirit/`), not as a daemon agent
- **Available when the daemon isn't** — can diagnose "why won't it start" without a running daemon

This positioning is deliberate. Making the Spirit a first-class agent would drag it into governance, couple its availability to the daemon, and confuse its relationship to Source. It is better understood as a **personal assistant for the management, governance, and running of the harness itself**.

### §2 — Dispatch architecture in the REPL

The REPL (`packages/cli/src/attach.ts`) gates inputs:

```
input ─┬─ starts with ":"          → command dispatch (as today)
       ├─ bare exact known verb    → command dispatch (back-compat)
       └─ everything else          → Spirit
```

An explicit `:spirit <message>` escape is also provided for disambiguation (e.g., when the operator's message happens to begin with a command verb in natural prose).

The command grammar tightens: bare commands remain supported for muscle memory, but any input that isn't a strict match falls through to the Spirit. This gives the REPL a dual-mode behavior — machine-precise commands when wanted, conversational assistance otherwise — without a mode switch.

### §3 — Tool surface

The Spirit acts through tools with two safety policies: **auto** for read operations and reversible daemon RPCs the operator already has as REPL verbs, and **confirm** for anything that mutates state the operator would want to review. File writes additionally show a unified diff before confirmation; that's a rendering detail, not a separate policy.

#### Auto-allow tools

| Tool                                | Purpose                                        |
| ----------------------------------- | ---------------------------------------------- |
| `status()`                          | Daemon status (same as `:status`)              |
| `agents()`                          | List agents with state summary                 |
| `groups()`                          | List groups with member count                  |
| `events(limit)`                     | Recent daemon events                           |
| `cost(period)`                      | Cost summary                                   |
| `governance_state()`                | Pending items, recent decisions                |
| `read_file(path)`                   | Read any file in murmuration root              |
| `list_dir(path)`                    | Enumerate a directory                          |
| `load_skill(name)`                  | Load a Spirit skill file (see §4)              |
| `recall(query)`                     | Search Spirit memory (see §5, Phase 2)         |
| `wake(agent_id)`                    | Trigger a wake — equivalent to `:wake <agent>` |
| `directive(scope, target, message)` | Send a Source directive — same as `:directive` |
| `convene(group_id, kind)`           | Convene a group meeting — same as `:convene`   |

#### Confirm-before-acting tools

Prompt operator with `[y/N]` in the REPL. File writes additionally show a unified diff and produce a `.bak` file; an `:undo` REPL command restores the most recent `.bak`.

| Tool                                             | Purpose                                     |
| ------------------------------------------------ | ------------------------------------------- |
| `start_daemon()`                                 | Boot the daemon                             |
| `stop_daemon()`                                  | Shut down the daemon                        |
| `restart_daemon()`                               | Stop + start                                |
| `write_file(path, content)`                      | Create or overwrite a file (diff shown)     |
| `edit_file(path, find, replace)`                 | Surgical replacement (diff shown)           |
| `create_agent(spec)`                             | Scaffold a new agent directory              |
| `edit_soul(agent_id, new_text)`                  | Modify an agent's soul (diff shown)         |
| `edit_role(agent_id, new_frontmatter, new_body)` | Modify an agent's role (diff shown)         |
| `remember(type, key, body)`                      | Write a Spirit memory (Phase 2; diff shown) |
| `draft_skill(name, body)`                        | Propose a new Spirit skill file (Phase 2)   |

#### Explicitly blocked

- Arbitrary shell execution (no `exec`, no `spawn`)
- Reading `.env` or any path matching `*.env*`
- Paths that escape the murmuration root (no `..` traversal)
- Network calls beyond what the auto-allowed tools expose
- Writes outside the murmuration root

### §4 — Skill files

The Spirit does not memorize the harness. It references a library of detailed skill files, loaded on demand. This keeps the Spirit's base system prompt small (and cache-friendly), keeps its knowledge fresh (skills ship with the harness), and lets operators extend the Spirit with their own domain skills.

#### Skill directory layout

```
packages/cli/src/spirit/skills/              ← shipped baseline
├── SKILLS.md                                ← auto-generated index
├── daemon-lifecycle.md
├── agent-anatomy.md
├── governance-models.md
├── harness-yaml.md
├── group-meetings.md
├── signals-and-wakes.md
├── directives.md
├── cost-and-budget.md
├── collaboration-provider.md
├── extensions.md
├── debugging.md
└── when-to-use-governance.md                ← operator-savviness (see §4.3)

<root>/spirit/skills/                        ← operator-authored overlay
├── our-governance.md                        ← domain-specific
├── our-research-pipeline.md
└── README.md                                ← "how to write a Spirit skill"
```

Layering rule: operator overlay wins on name collision (same filename). This lets operators correct or localize baseline skills without forking the harness.

#### Skill file format

```markdown
---
name: agent-anatomy
description: Structure of an agent — soul.md, role.md frontmatter, signal scopes, write scopes
triggers:
  - editing an agent
  - creating a new agent
  - debugging why an agent won't wake
  - questions about agent identity
version: 1
---

# Agent anatomy

[detailed prose with code snippets, file paths, frontmatter schemas —
no length limit; a skill is worth its weight only if it's thorough]
```

#### Loading strategy

- **`SKILLS.md`** (index only: name + one-line description + triggers) is **always** in the system prompt. Stable, small, aggressively cacheable.
- Full skill bodies load on demand via the `load_skill(name)` tool.
- The Spirit is instructed: _"Before answering anything substantive, check if a skill covers it and load it first. If none fits, say so — don't guess."_

#### Operator-savvy doctrine

One skill, `when-to-use-governance.md`, captures the doctrine on the three-paths choice: direct edit (Source authority), governance round (delegated ratification), or directive (ask the circle to propose). When the operator asks for a change that could go any of these ways, the Spirit names the options and lets the operator choose.

This is the skill that makes the Spirit _wise_ about the operator/governance relationship, rather than just competent at file editing.

#### Skill compounding

The Spirit can _author_ new skills via `draft_skill(name, body)`. Example flow:

> **Operator:** "We keep debating how to set max_cost_micros for a new agent. Can you capture our rule of thumb?"
>
> **Spirit:** _drafts `spirit/skills/budget-sizing.md` with the rule of thumb, the reasoning, and examples from past decisions. Shows diff. Asks for approval._
>
> **Operator:** `y`
>
> _Skill is now in the overlay. Next session, the Spirit applies it automatically._

This turns the Spirit from a one-shot assistant into a growing **institutional memory** for the murmuration.

### §5 — Memory architecture

Of all components in the harness, the Spirit needs memory the most. Agents are role-bound and cycle through wakes with fresh signals; the Spirit is relationship-bound and needs continuity to be useful.

#### Memory is not conversation history

Three distinct layers, each with a different lifetime and purpose:

| Layer            | What                                                 | Lifetime                  | Storage                                                              |
| ---------------- | ---------------------------------------------------- | ------------------------- | -------------------------------------------------------------------- |
| **Conversation** | Current back-and-forth                               | REPL session              | In-process                                                           |
| **Sessions log** | Raw transcript of every REPL session with the Spirit | Indefinite (prune by age) | `.murmuration/spirit/sessions/<date>.jsonl` (gitignored)             |
| **Memory**       | Distilled long-term knowledge                        | Indefinite                | `<root>/spirit/memory/*.md` (operator-visible, optionally committed) |

Conversation resets per session. Session logs are write-only from the Spirit; read by dreaming (§9). Memory is what the Spirit actively uses to inform responses.

#### Memory types

Start narrow. Three types cover the minimum useful taxonomy; adding types later is cheap (just a new `type:` value), removing them after operators have written files is expensive:

| Type          | Captures                                                                | Example                                                |
| ------------- | ----------------------------------------------------------------------- | ------------------------------------------------------ |
| `operator`    | Who Source is — role, preferences, working style, corrections, doctrine | "Operator prefers 'Spirit' over 'Ghost'."              |
| `murmuration` | State of the murmuration — active work, decisions, incidents            | "Engineering Circle ratified ADR-0024 on 2026-04-20."  |
| `reference`   | External pointers — where to find things                                | "Governance issues live in `murmurations-ai/harness`." |

The taxonomy may grow as genuine new categories emerge — `feedback`, `relationship`, `doctrine` were candidates considered and folded into `operator` for MVP. Revisit the split after real usage, not before.

#### Memory file format

Each memory is its own file with YAML frontmatter:

```markdown
---
name: operator-terminology-spirit
description: Operator prefers "Spirit" over "Ghost" for this assistant
type: feedback
first_observed: 2026-04-17
last_reinforced: 2026-04-17
reinforcement_count: 2
confidence: high
related: [spirit-architecture]
---

## The rule

Refer to this assistant as "the Spirit" or "Spirit of the Murmuration",
never as "ghost" (except in historical references to the earlier naming).

## Why

The operator framed it as the animating force inside the suit of armor
— the thing that lets Source move precisely. "Ghost" has absent/past
connotations that don't fit.

## How to apply

In all UI text, docs, and conversation. When reading old references to
"Ghost", silently translate to "Spirit" unless quoting.
```

#### Memory index

`<root>/spirit/memory/INDEX.md` is a single-file index of all memories: one line per memory with name, type, description, last-reinforced date. Always loaded into the Spirit's system prompt. Memory bodies load on demand via `recall(query)` or targeted read.

Keeping only the index in the base system prompt means the context cost of many memories stays bounded. A murmuration with 500 memories has a ~50 KB index; individual memories hydrate only when relevant.

#### Memory lifecycle

- **Create**: `remember(type, name, body)` tool. Spirit drafts; operator approves via Ring 4 diff.
- **Reinforce**: when Spirit detects an existing memory applies, it updates `last_reinforced` and increments `reinforcement_count`. No diff needed (metadata-only write).
- **Correct**: Spirit can update the body of an existing memory via `edit_file`; same Ring 4 diff flow.
- **Remove**: operator can delete directly, or Spirit can propose a removal with `[y/N]`.

#### Storage and portability

Default: `<root>/spirit/memory/` — operator-visible, part of the murmuration repo, optionally committed. Operators who consider memories personal can `.gitignore` the directory.

Configurable via `harness.yaml`:

```yaml
spirit:
  memory:
    storage: local # local | github | s3 (future)
    path: spirit/memory # relative to root
    commit: false # whether to git-commit on change
```

The `github` storage mode would use `CollaborationProvider.commitArtifact()` to persist memories as repo files — useful when the operator runs from multiple machines. Deferred past MVP.

### §6 — Context injection

Each Spirit turn assembles a context bundle:

```
[system — stable prefix, aggressively cached across REPL session]
  ## Spirit identity
    <spirit.md if present, else baseline>

  ## Skill index
    <SKILLS.md — names + descriptions + triggers>

  ## Memory index
    <INDEX.md — one line per memory>

  ## Murmuration soul
    <murmuration/soul.md>

  ## Agent roster
    <one paragraph per agent from role.md frontmatter + name>

  ## Governance overview
    <model, group list, terminology>

[system — refreshed per turn]
  ## Current daemon status
    <status output>

  ## Recent events (last 10)
    <event log>

  ## Prior turns in this session
    <compacted conversation history>

[user]
  <operator's message>
```

The stable prefix is large (can reach 10-20k tokens in a mature murmuration). Anthropic's prompt caching covers it across the REPL session, so the marginal cost per turn is just the refreshed section + the user message + the response.

### §7 — Identity file

Optional `<root>/spirit.md`:

```markdown
---
provider: anthropic
model: claude-sonnet-4-6
max_cost_per_turn_micros: 50000
max_steps: 10
temperature: 0.2
---

# The Spirit

You are the Spirit of the Murmuration — the operator's companion for
running this harness. You know this murmuration intimately through its
soul, agent roles, governance state, and the memories and skills you
maintain. You act only on operator intent, never independently. For any
write, show a diff and wait for confirmation.

[operator may customize personality, style, constraints]
```

`murmuration init` drops a default version. Operators override per-murmuration.

### §8 — REPL surface (Phase 1)

In-REPL:

```
:spirit <message>                    # explicit invocation (else auto-routed)
:undo                                # revert the last confirmed mutation
```

CLI subcommands (`murmuration spirit …`) land with Phase 2 alongside memory — there's no overlay or memory for them to inspect until then.

### §9 — Phase 3: Dreaming (forward reference)

Memories grow without bound unless actively curated. A future pass — provisionally called **dreaming** — will consolidate, classify, and compact session logs + memories into a denser, more useful set. Biological metaphor: sleep consolidation transits episodic memory to semantic memory offline. The design constraint is that dreaming must be a **two-stage** process — the Spirit proposes a consolidated memory diff; the operator confirms. The Spirit never silently rewrites its own memory.

Until dreaming is needed in practice, `find spirit/memory -mtime +90 -delete` is a perfectly good interim policy. Design to be captured in a follow-on ADR when real memory bloat appears.

## Consequences

**Positive:**

- Operators get a conversational interface to the harness without losing command precision.
- Skills keep the Spirit's knowledge versioned with the code; no stale training cutoffs.
- Memory gives the Spirit relationship continuity — something no current agent has.
- The Spirit can work when the daemon is down, which is exactly when it's often needed.
- Two-policy tool model is simple: auto-allow or confirm.
- Skill and memory authoring turn one-off operator wisdom into durable artifacts.

**Negative:**

- Another LLM-consuming surface; cost observability becomes more important.
- Skill and memory files proliferate; the overlay needs curation discipline.
- Prompt-injection surface widens (Spirit reads many operator-authored files); confirm-before-writing is the primary mitigation.
- Memory without dreaming will eventually bloat — interim `find -mtime +90 -delete` covers it until dreaming lands.

**Neutral:**

- The Spirit's conversational latency depends on the configured model. Claude Sonnet 4.6 is a reasonable default; operators can pin something cheaper.
- The Spirit does not participate in governance. Any change to that positioning is a future ADR, not a tweak.

## Open questions

1. **Memory in GitHub mode** — should memories use `CollaborationProvider.commitArtifact()` when the murmuration is GitHub-backed? It would give cross-machine continuity but exposes memories to anyone with repo read access. Default _off_, opt-in via config. Revisit after MVP.

2. **Streaming tool calls** — should the operator see tool invocations as they happen (dim inline), or wait for the final response? Recommendation: streaming, with tool calls prefixed with `  [tool: load_skill agent-anatomy]` in dim color. Matches Claude Code's UX.

3. **Spirit and Langfuse** — ADR-0022 proposes Langfuse trace enrichment. Should Spirit conversations be traced? Default yes (observability), but only at session granularity (not per tool call) to avoid flooding. Revisit.

4. **Skill discovery for new harness features** — when a new harness feature ships, how do its skills reach existing murmurations? Proposal: baseline skills are bundled with the CLI binary; `murmuration upgrade` syncs them. Overlays are operator-owned.

5. **Cross-murmuration memory** — an operator with multiple murmurations has separate Spirit memories per murmuration. Should there be a personal cross-cutting memory? Probably yes (at `~/.config/murmuration/spirit/`), but orthogonal — can be added later.

## Implementation plan

Three phases.

### Phase 1 — MVP (ship-in-days scope)

- `packages/cli/src/spirit/` module: `client.ts`, `dispatch.ts`, `tools/` (auto-allow tools only)
- REPL gate in `attach.ts`: non-`:`, non-bare-verb → Spirit
- Streaming response with inline tool annotations
- Per-session conversation state (no persistence)
- Hardcoded default system prompt (no `spirit.md` yet)
- 4 shipped skills: `daemon-lifecycle.md`, `agent-anatomy.md`, `governance-models.md`, `when-to-use-governance.md`
- `load_skill(name)` tool + static (hand-maintained) `SKILLS.md` index
- Cost annotation per turn

**Explicitly out of Phase 1:** memory, confirm-to-mutate tools, dreaming, overlay skills, GitHub-stored memory, `spirit.md` identity file, `murmuration spirit` CLI subcommands, auto-generated skill index.

### Phase 2 — Memory + writes

- `<root>/spirit/memory/` storage + `INDEX.md`
- Three memory types (`operator`, `murmuration`, `reference`) with schema validation
- `remember`, `recall`, memory-edit tools
- Confirm-before-acting tools (lifecycle + file writes with diff)
- `:undo` REPL command + `.bak` mechanism
- Operator-authored overlay skills (`<root>/spirit/skills/`)
- `draft_skill` tool for skill compounding
- `spirit.md` identity file + `murmuration spirit init` scaffolder
- Auto-generated `SKILLS.md` index

### Phase 3 — Dreaming + polish

- Session log consolidation (design in a follow-on ADR before implementation)
- `murmuration spirit dream` command
- Cron-scheduled dreaming via `harness.yaml`
- GitHub-stored memory option via CollaborationProvider
- Cross-murmuration personal memory (if scoped in)
- Observability (Langfuse traces for Spirit sessions)

Each phase is a separate release and can ship independently. Phase 1 alone is a meaningful improvement to the REPL.
