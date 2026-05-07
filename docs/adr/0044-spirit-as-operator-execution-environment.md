# ADR-0044 — Spirit as Operator Execution Environment

- **Status:** Proposed
- **Date:** 2026-05-07
- **Decision-maker(s):** Source (Nori), Engineering Circle
- **Driver:** Spirit today is a knowledgeable advisor. It knows the murmuration intimately (soul, agents, governance, events), can read files, and can mutate state with operator confirmation. But it cannot execute arbitrary tasks. Claude Code and Codex — the tools Source spends the most time in — can plan multi-step work, run shell commands, use MCP servers, respond to lifecycle hooks, and render a live status footer. Spirit should reach that level of capability while retaining its domain advantage: intimate murmuration knowledge that neither Claude Code nor Codex will ever have.
- **Related:** ADR-0024 (Spirit identity and tool surface), ADR-0038 (Spirit MCP bridge), ADR-0039 (local executable authority), ADR-0043 (Spirit as meta-agent: memory and cross-attach context).

---

## Context

Spirit's current ceiling is "know and advise." The three things that keep it there:

1. **No shell execution.** ADR-0024 §3 explicitly blocks `exec` and `spawn`. Claude Code and Codex are built on shell access. Without it, Spirit cannot run builds, tests, git operations, deployments, or any operator workflow that touches the terminal.

2. **No lifecycle hooks.** Codex fires shell scripts at `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, and `Stop`. Claude Code does the same. Spirit has no equivalent. Operators cannot inject custom context, enforce pre-execution guards, or trigger side effects at attach/detach time without forking the harness.

3. **No rich terminal surface.** The REPL today is a bare line editor. There is no status footer (current cost, daemon state, working directory), no styled transcript separating Source from Spirit, no multiline input, and no configurable layout. Claude Code and Codex both render a live status line and a first-class input area. Spirit's terminal experience is noticeably behind the tools it sits alongside.

A fourth issue is cosmetic but culturally significant: Spirit uses `:commands` (vi/ex convention). Every other tool in this space — Claude Code, Codex, Slack, Discord, IRC — uses `/commands`. Operators who move fluidly between Claude Code and Spirit have to context-switch their muscle memory.

This ADR makes Spirit a first-class operator execution environment: a peer of Claude Code and Codex that also happens to know your murmuration inside out.

---

## Decision

This ADR defines a milestone release — provisionally **v0.9** — that ships four interlocking capabilities: scoped shell execution, operator lifecycle hooks, a redesigned terminal UI, and `/command` syntax. They are specified together because they share the same design principle: Spirit should feel like a capable agentic harness, not a special-purpose CLI wrapper.

---

### §1 — Scoped shell execution

Shell access is unlocked via a `run_command` tool with an operator-declared allowlist. It is not arbitrary exec.

#### Allowlist in `spirit.md`

```yaml
---
provider: anthropic
model: claude-sonnet-4-6
shell:
  allowed:
    - "git *"
    - "pnpm *"
    - "murmuration *"
    - "npx vitest *"
    - "gh issue *"
    - "gh pr *"
  cwd: . # relative to murmuration root; default "."
  timeout_ms: 60000 # per-command wall-clock limit; default 60s
  env_passthrough: [] # additional env vars beyond the safe default set
---
```

If `shell.allowed` is absent or empty, `run_command` is not registered and Spirit cannot execute shell commands. Operators opt in explicitly; the default is the current behavior.

#### Tool definition

```typescript
run_command(cmd: string, args: string[], cwd?: string): ShellResult
// ShellResult: { stdout: string; stderr: string; exitCode: number; durationMs: number }
```

Before execution Spirit matches `"${cmd} ${args.join(" ")}"` against each glob in `shell.allowed`. If no pattern matches, execution is refused and Spirit tells the operator which patterns are configured. This match happens inside the harness, before any subprocess is spawned — it is not delegated to the shell.

#### Permission tier

`run_command` sits in the **confirm** tier (same as `write_file`, `edit_soul`). Spirit shows the full command and working directory before execution:

```
  run: pnpm test
  cwd: /home/operator/murmurations/ep
  [y/N] _
```

Operators who want auto-allow for a specific command can move it to `shell.auto_allow`:

```yaml
shell:
  auto_allow:
    - "pnpm test"
    - "git status"
    - "git log *"
```

Auto-allowed commands still print inline during execution (dim prefix: `  › pnpm test`) but do not pause for confirmation.

#### Security constraints (non-negotiable regardless of allowlist)

- No writing outside `murmuration root` or `cwd` override declared in `spirit.md`.
- `env_passthrough` is additive to a safe minimal env (`PATH`, `HOME`, locale vars, `MURMURATION_ROOT`). Provider API keys (`ANTHROPIC_API_KEY`, etc.) are stripped before spawning.
- Piped commands (`cmd1 | cmd2`) are treated as a single pattern-matched string. Shell metacharacters (`&&`, `||`, `;`, `$()`, backticks) outside single-quoted literals are rejected before pattern matching — Spirit is not a shell interpreter.
- `cwd` overrides are validated against `murmuration root` at tool registration time (no `..` traversal).

---

### §2 — Lifecycle hooks

Spirit gains a hook system at five lifecycle points, implemented via the existing skill trigger mechanism (ADR-0024 §4). No new runtime is introduced — hooks are skills that auto-load and execute at named points.

#### Hook triggers

| Trigger         | Fires when                                                                   |
| --------------- | ---------------------------------------------------------------------------- |
| `session_start` | `murmuration attach` begins, after context assembly, before the first prompt |
| `session_end`   | Operator detaches (Ctrl-C, terminal close, `:quit`)                          |
| `turn_start`    | Before Spirit processes each operator message                                |
| `pre_tool`      | Before Spirit executes any tool — receives tool name in context              |
| `post_tool`     | After any tool returns — receives tool name + result summary in context      |

#### Hook skill authoring

Add the trigger name to a skill's frontmatter `triggers` list:

```yaml
---
name: morning-briefing
description: Opens each attach session with a murmuration health snapshot
triggers:
  - session_start
version: 1
---

When this skill loads at session_start:
1. Call `status()` and `events(10)`.
2. Surface any agents in failed state.
3. Summarize governance items awaiting Source action.
4. Report session cost from the prior attach (from Spirit memory if available).
Keep it to 5–8 lines. Do not wait for operator input.
```

```yaml
---
name: session-wrap
description: End-of-attach memory consolidation and cost summary
triggers:
  - session_end
version: 1
---

When this skill loads at session_end:
1. Report total session cost.
2. Auto-save any memories flagged during the session (call `remember` for each).
3. If `run_command` executed any shell commands, append a one-line summary to
   the Spirit session log.
```

#### Hook execution

Spirit processes hook skills before the first model turn (for `session_start`) or after the triggering event (for all others). The skill body is injected as a `system` block in the next turn's context. Hook-triggered turns do not wait for operator input — Spirit executes them autonomously and prints the output to the transcript.

`pre_tool` and `post_tool` hooks receive the tool name as a variable in context:

```
## Hook context
trigger: pre_tool
tool: run_command
args: { cmd: "pnpm", args: ["build"] }
```

A `pre_tool` hook that returns `BLOCK` (exact string) causes Spirit to abort the tool call and surface the reason to the operator. This is the equivalent of Codex's `PreToolUse` blocking behavior.

#### Shell-based hooks (advanced)

Operators who want imperative hook behavior (sound effects, notifications, external API calls) can declare shell hooks in `spirit.md`:

```yaml
hooks:
  session_start: "./scripts/notify-attach.sh"
  session_end: 'osascript -e ''display notification "Spirit detached" with title "Murmuration"'''
  stop: "afplay /System/Library/Sounds/Pop.aiff"
```

Shell hooks run independently of the model turn — they do not inject context. They fire at the same lifecycle points, in sequence after skill hooks. They are subject to the same allowlist as `run_command` if `shell.allowed` is declared; if not, they are still permitted (hooks are operator-declared in `spirit.md`, not model-generated). This matches the trust model Codex and Claude Code use: hooks are operator-defined scripts, not model outputs.

---

### §3 — Redesigned terminal UI

The REPL gets a three-zone layout inspired by Claude Code and Codex. Implementation target: `ink` (React for CLI) or `blessed`, whichever the dashboard-tui package (`@murmurations-ai/dashboard-tui`) can extend without a new dependency.

#### Layout

```
╔══════════════════════════════════════════════════════════════════╗
║  Spirit of the Murmuration — emergent-praxis                    ║
╠══════════════════════════════════════════════════════════════════╣
║                                                                  ║
║  [Transcript zone — scrollable, fills available height]          ║
║                                                                  ║
║  Source ▸  run the full test suite before I push this           ║
║                                                                  ║
║  Spirit  Loading skill `debugging`...                            ║
║           › pnpm test                                            ║
║           ✓ 52 tests passed (4.1s)                              ║
║           All green. Safe to push.                               ║
║                                                                  ║
╠══════════════════════════════════════════════════════════════════╣
║  > [Input zone — multiline, Shift+Enter for newline]            ║
║                                                                  ║
╠══════════════════════════════════════════════════════════════════╣
║  emergent-praxis │ 3 running, 0 failed │ $0.0024 │ ~/Code/ep    ║
╚══════════════════════════════════════════════════════════════════╝
```

#### Transcript zone

- Source messages: bold label `Source ▸`, left-aligned.
- Spirit messages: regular label `Spirit`, left-aligned with slight indent for continuation lines.
- Tool calls rendered inline in dim style: `  › pnpm test`.
- Tool results rendered inline: `  ✓ 52 tests passed` or `  ✗ exit 1`.
- Skill loads rendered in dim italic: `  [loading skill: debugging]`.
- Session separator rendered on each attach: dim horizontal rule + timestamp.
- Full scroll history preserved for the session; `PgUp`/`PgDn` navigate.

#### Input zone

- Multiline input. `Enter` submits. `Shift+Enter` inserts newline.
- Arrow keys navigate history (same session).
- `/` prefix on a new line triggers command completion (see §4).
- Paste support: large pastes are shown as `[pasted N lines]` with a `[y/N]` before submission to prevent accidental multi-paragraph sends.

#### Footer zone

The footer is a single line of configurable widgets. Default widget set:

| Widget             | Display                                     |
| ------------------ | ------------------------------------------- |
| `murmuration_name` | Name from `harness.yaml`                    |
| `agent_summary`    | `3 running, 0 failed` (or `daemon stopped`) |
| `session_cost`     | `$0.0024` (running total for this attach)   |
| `cwd`              | Current working directory (abbreviated)     |
| `model`            | Active model ID (short form)                |

Configuration in `spirit.md`:

```yaml
footer:
  widgets:
    - murmuration_name
    - agent_summary
    - session_cost
    - cwd
  separator: " │ "
  position: bottom # bottom (default) | top | none
```

`position: none` disables the footer entirely for operators who want a minimal REPL. Widget order follows declaration order. Custom widgets are not supported in v0.9 — the widget set is fixed; this is a future extension point.

---

### §4 — `/command` syntax

`:commands` are replaced by `/commands`. The routing rule in `attach.ts` changes from:

```
input starts with ":" → command dispatch
bare exact verb       → command dispatch (back-compat)
everything else       → Spirit
```

to:

```
input starts with "/" AND first token matches a registered command → command dispatch
everything else → Spirit
```

The "bare exact verb" back-compat path is dropped. This is a breaking change; it is appropriate at a milestone release.

File paths starting with `/` are not ambiguous: `Users` is not a registered command, so `/Users/nori/file.md` routes to Spirit. Unrecognized `/foo` inputs also route to Spirit with a note: `No command '/foo'. Passing to Spirit.`

#### Command set (`/command`)

All current `:command` equivalents are re-mapped:

| Old                     | New                     | Notes                                      |
| ----------------------- | ----------------------- | ------------------------------------------ |
| `:status`               | `/status`               |                                            |
| `:agents`               | `/agents`               |                                            |
| `:wake <id>`            | `/wake <id>`            |                                            |
| `:directive <id> "msg"` | `/directive <id> "msg"` |                                            |
| `:convene <group>`      | `/convene <group>`      |                                            |
| `:cost`                 | `/cost`                 |                                            |
| `:reset`                | `/reset`                | Confirmation prompt retained               |
| `:remember`             | `/remember`             |                                            |
| `:undo`                 | `/undo`                 |                                            |
| `:quit`                 | `/quit`                 |                                            |
| `:spirit <msg>`         | Removed                 | All non-`/` input routes to Spirit         |
| —                       | `/help`                 | List commands + Spirit capabilities        |
| —                       | `/model <id>`           | Switch model mid-session                   |
| —                       | `/hooks`                | List active hooks and their trigger points |
| —                       | `/skills`               | List loaded and available skills           |

Tab-completion on `/` shows registered commands. This works whether the REPL is in the full TUI or the fallback line-editor mode (for non-interactive terminals or `--no-tui`).

#### Rationale for the change

The `:` convention comes from vi/ex. The target audience for Spirit is engineers who use Claude Code and Codex daily. Every tool in that space uses `/`. The cost of the break is one muscle-memory adjustment during the v0.9 upgrade; the benefit is that Spirit feels native from the first session.

The only solid argument for keeping `:` was disambiguation from file paths. The routing fix (match first token against registered command names) resolves this without `:`.

---

## Milestone scope: v0.9

This ADR defines a discrete milestone. The four capabilities ship together because they reinforce each other: shell execution without a status footer is opaque; hooks without a transcript zone have nowhere to surface their output; `/commands` without a redesigned input area lose the completion UX that makes them useful.

**v0.9 ships:**

- `run_command` tool with allowlist + permission tiers
- Shell-based and skill-based lifecycle hooks (5 trigger points)
- Three-zone TUI (transcript + input + footer)
- `/command` syntax with tab completion
- `/hooks` and `/skills` introspection commands
- `/model` mid-session model switch
- Updated `murmuration init` scaffolding `spirit.md` with empty `shell.allowed` and default footer config
- Updated operator guide: shell access, hooks, TUI layout, command migration

**Out of scope for v0.9:**

- Custom footer widgets (fixed widget set only).
- `post_tool` hook receiving full tool output (receives summary only; full output is a context-size concern).
- Cross-murmuration hook libraries (operator overlay + bundled baseline is sufficient).
- Spirit-as-cron-agent (deferred from ADR-0043; still deferred).
- Web fetch / HTTP tools (out of scope pending a separate security review).

---

## Consequences

**Positive:**

- Spirit reaches Claude Code / Codex capability parity for the workflows operators actually run: builds, tests, git, deployments, murmuration lifecycle.
- The hook system turns Spirit from a reactive assistant into a proactive one — morning briefings, end-of-session memory saves, pre-push checks.
- The TUI makes cost and daemon state visible at all times; operators stop asking "how much did that turn cost?" or "is the daemon running?".
- `/commands` eliminate the mental context switch between Spirit and Claude Code/Codex.
- Domain advantage is preserved: Spirit retains everything from ADR-0024 and ADR-0043 (memory, skills, MCP bridge, governance awareness) that Claude Code and Codex do not have.

**Negative / costs:**

- Shell execution is a new attack surface. An operator who configures a broad allowlist (`"* *"`) essentially grants arbitrary execution via a model-generated `run_command` call. The allowlist + confirm tier mitigates this; the operator guide must be explicit about it.
- Three-zone TUI requires a terminal that supports raw mode. `--no-tui` flag retains the current line-editor for non-interactive contexts (CI piping, SSH without PTY). This adds a rendering branch to maintain.
- Breaking change on `:` → `/` will surprise operators on upgrade. Migration note in CHANGELOG and a one-time attach banner on first v0.9 run: `Command syntax has changed: use /status instead of :status. Run /help for the full list.`
- `run_command` timeout enforcement adds process-management complexity (kill child on timeout, clean up).

**Neutral:**

- Skill-based hooks reuse the existing skill system exactly; no new file format or loading machinery.
- Shell-based hooks in `spirit.md` use the same allowlist — no separate permission model to maintain.
- Footer widget set is intentionally narrow for v0.9. Premature extensibility here would add interface surface before we know what operators actually want.

---

## Open questions

1. **TUI library choice.** `ink` (React for CLI) integrates with the existing dashboard-tui package but adds React to the CLI runtime. `blessed` is lower-level and has no React dependency but is less actively maintained. `@murmurations-ai/dashboard-tui` currently uses `pi-tui` — should Spirit share that, or own its rendering? Needs a spike before implementation begins.

2. **Hook blocking granularity.** `pre_tool` hooks can return `BLOCK` to abort a tool call. Should `session_start` hooks also be able to abort the attach entirely (e.g., "daemon is not running, cannot proceed")? Useful but adds an early-exit path that complicates the boot sequence.

3. **`env_passthrough` and secrets.** The default env strip removes provider API keys before `run_command`. But some operator scripts legitimately need `GITHUB_TOKEN` or similar. `env_passthrough` covers this, but it is easy to accidentally passthrough a secret. Should there be a warning when a known-secret var name appears in `env_passthrough`?

4. **Footer in `--no-tui` mode.** The footer is a TUI widget. In `--no-tui` (line editor), should cost and daemon status be printed as a prompt prefix (`[ep | $0.0024] > `) or omitted entirely?

5. **`/model` scope.** Mid-session model switching (`/model claude-opus-4-7`) affects only the current attach. Should it persist to `spirit.md` as the new default, or remain session-local? Defaulting to session-local is safest; a `--persist` flag could write back.

6. **Codex hook compatibility.** Codex names its hooks `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`. Spirit's names differ (`session_start`, `turn_start`, `pre_tool`, `post_tool`, `session_end`). Should Spirit alias the Codex names so operators can share hook scripts? Low-cost to add; useful if operators run both.

These are answerable in the implementation spec, not in this ADR.
