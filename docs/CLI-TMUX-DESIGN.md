# CLI Tmux-Style Interface — Design Specification & Plan

Status: Draft v0.1
Audience: Maintainers, power-user operators, contributors building the TUI / web dashboard
Related: `docs/ARCHITECTURE.md`, `packages/cli/src/attach.ts`, `packages/core/src/daemon/http.ts`, `packages/dashboard-tui`

---

## 1. Motivation

A murmuration is a long-running, multi-agent coordination process. In practice, an operator running real work will have **several murmurations active at once** — one per project, one per experiment, one for governance rehearsal — exactly the way a developer keeps several `tmux` sessions running on a workstation.

Today the harness already has the _ingredients_ for this kind of experience:

- a session registry at `~/.murmuration/sessions.json` keyed by name,
- a Unix-socket control protocol per daemon (`.murmuration/daemon.sock`),
- a heartbeat-aware `list` command,
- an `attach` REPL with `directive`, `wake`, `convene`, `switch`, `stop`, `quit`,
- a pi-tui dashboard (`@murmuration/dashboard-tui`),
- an HTTP/SSE dashboard surface (`DaemonHttp`) with a static HTML client.

What's missing is **a coherent mental model** that ties these pieces together, and a **CLI that is the most powerful surface, not the least**. Power users should be able to live in the terminal and never lose any capability that the TUI or web dashboard offers.

This document proposes that mental model — borrowed unapologetically from `tmux` — and specifies the command, REPL, and key-binding surfaces needed to realize it. It also defines a parity contract that keeps the three interface modes (CLI, TUI, Web) in lockstep.

---

## 2. The Tmux Analogy

The mapping is almost one-to-one and is worth taking seriously, because it gives operators an instant intuition for the system.

| tmux concept            | Murmuration analogue                                            |
| ----------------------- | --------------------------------------------------------------- |
| server                  | the `murmuration` daemon (one per murmuration root)             |
| session                 | a registered murmuration (`~/.murmuration/sessions.json` entry) |
| window                  | a group (circle / department / committee)                       |
| pane                    | an agent within a group                                         |
| `tmux ls`               | `murmuration list`                                              |
| `tmux attach -t name`   | `murmuration attach <name>`                                     |
| `tmux detach` (`C-b d`) | leader-key `d` inside the REPL — daemon keeps running           |
| `tmux switch -t`        | REPL `:switch <name>` or leader-key `s`                         |
| `tmux kill-session`     | `murmuration stop <name>`                                       |
| `tmux new -s`           | `murmuration init` + `murmuration start --name`                 |
| `tmux send-keys`        | `murmuration directive --name --agent`                          |
| `.tmux.conf`            | `~/.murmuration/config.toml` (key bindings, default views)      |

The two crucial properties tmux exposes — and that we want — are:

1. **Daemons outlive their clients.** Detaching never stops work. Attaching never restarts it.
2. **One leader key gates a small, learnable command vocabulary** that runs the system without leaving the keyboard.

---

## 3. Three Modes of CLI Use

A power user should be able to move fluidly between three modes without changing programs.

### 3.1 Batch mode (one-shot subcommands)

`murmuration <verb> [flags]`. This is the existing surface (`start`, `stop`, `list`, `directive`, `group-wake`, `backlog`, `status`, …) plus a small number of additions. Batch mode is what scripts, cron, CI, and muscle memory use.

Design rule: **every interactive operation must also exist as a batch verb.** If the REPL can do it, `murmuration <verb>` can do it. This is the parity rule that keeps the CLI scriptable.

### 3.2 REPL mode (`murmuration attach`)

A line-oriented prompt connected to one daemon at a time, with `:`-prefixed commands (mnemonic: vim ex-mode; also avoids collision with free-text directives). The REPL is the operator's command line _inside_ a murmuration: search, list, inspect, mutate.

The current REPL already handles `status`, `directive`, `wake`, `convene`, `switch`, `stop`, `quit`. The design below extends it.

### 3.3 Leader-key mode (tmux-style)

A modal layer on top of the REPL. Pressing the leader (default `Ctrl-a`, configurable) puts the REPL into "command-pending" state for a single keystroke. `Ctrl-a d` detaches; `Ctrl-a l` opens the murmuration list picker; `Ctrl-a s` switches; `Ctrl-a g` jumps to a group; `Ctrl-a a` jumps to an agent; `Ctrl-a ?` shows the cheat sheet. This is the layer that makes terminal use _fast_ once muscle memory takes over.

The three modes share the same underlying socket protocol and the same command vocabulary; leader-key bindings are just shortcuts to REPL commands, and REPL commands are just interactive bindings to the same RPC methods batch verbs use.

---

## 4. Architectural Principles

These principles should govern any additions to the interface layer.

**Daemon is the source of truth.** No interface (CLI, TUI, web) holds authoritative state. Every read goes through `status` / `event` RPCs; every write goes through a typed command. Interface processes are stateless modulo cached snapshots.

**One protocol, three transports.** The Unix socket protocol (newline-delimited JSON, request/response + event stream) is canonical. The HTTP layer (`DaemonHttp`) is a thin bridge for the web dashboard and remote attach. The REPL and TUI both speak the socket directly. Adding a method means adding it to one schema, not three.

**Parity is enforced, not aspirational.** A `parity matrix` (see §7) lives next to the protocol schema. Every command must declare which surfaces support it; CI fails if the matrix and the actual implementations diverge. The CLI is the reference implementation — TUI and web ship features _after_ the CLI does, never before.

**Leader-key bindings are a presentation concern, not a protocol concern.** The keymap is a config file. Bindings dispatch to REPL commands, which dispatch to RPCs. Nothing in the daemon knows about keys.

**Detach is free; attach is cheap.** Closing a client must never affect the daemon. Reattaching must replay enough recent state (event ring buffer, current snapshot) that the operator catches up in under a second. The 50-event ring already in `DaemonHttp` is the right shape; the socket protocol should expose the same.

**Names over paths.** Power users address murmurations by short stable names (`alpha`, `gov-test`, `prod`). Paths are an implementation detail surfaced only by `list -l` and `status --verbose`.

**Discoverability is non-optional.** `:?`, `:help <cmd>`, leader `?`, and a top-level `murmuration help <topic>` must be exhaustive and generated from the same command registry the dispatcher uses. No undocumented verbs.

---

## 5. Command Surface

### 5.1 Batch verbs

The current set, plus the additions marked **NEW**.

```
murmuration init [dir]
murmuration start    [--root|--name] [--now|--once|--dry-run] [--governance <path>]
murmuration stop     [--name|--root] [--all]                         # --all NEW
murmuration restart  [--name|--root]
murmuration status   [--name|--root] [--json] [--watch]              # --watch NEW
murmuration list     [-l|--long] [--json] [--filter running|stale]   # --filter NEW
murmuration register   <name> --root <path>
murmuration unregister <name>
murmuration attach   <name> [--read-only] [--no-leader]              # flags NEW

murmuration directive  --name <n> [--agent|--group|--all] "msg"      # --name unification NEW
murmuration wake       --name <n> --agent <id> [--reason "…"]        # NEW (alias of REPL `:wake`)
murmuration convene    --name <n> --group <id> [--kind operational|governance|retro]
murmuration backlog    --name <n> --group <id> [--repo o/r] [--refresh]

murmuration agents     --name <n> [--json] [--filter running|idle|failed]    # NEW
murmuration groups     --name <n> [--json]                                   # NEW
murmuration events     --name <n> [--since <ts>] [--follow] [--json]         # NEW (tail -f)
murmuration cost       --name <n> [--today|--week|--all] [--by-agent]        # NEW
murmuration logs       --name <n> --agent <id> [--follow] [--lines N]        # NEW

murmuration config     [get|set|edit] <key> [value]                          # NEW
murmuration help       [<topic>]                                             # NEW (generated)
```

**Naming consistency.** `--name` is the canonical session selector everywhere. `--root` remains supported for unregistered murmurations and scripts. The two are mutually exclusive.

**`--all`.** `stop --all`, `status --all`, `events --all --follow` operate over every registered, running session. This is what an operator wants when winding down for the day.

### 5.2 REPL commands

Inside `murmuration attach`, the prompt becomes `name>`. Commands are `:`-prefixed; bare lines are interpreted as free-form text only inside the explicit `:directive` flow (to avoid the "I typed a typo and started a meeting" foot-gun).

```
:status [--verbose]               daemon health, agent counts, in-flight meetings
:list                             same as `murmuration list` (other sessions)
:switch <name>                    detach + attach to another session
:detach                           leave REPL; daemon keeps running

:agents [--filter …]              tabular agent listing
:agent  <id>                      drill into one agent (state, last wake, cost, recent events)
:groups
:group  <id>                      members, last meeting, backlog summary
:backlog <id> [--refresh]

:wake    <agent> [--reason "…"]
:convene <group>  [--kind …] [--directive "…"]
:directive <agent|group|--all> "message"
:cancel  <wake-id|meeting-id>     NEW — interrupts an in-flight wake/meeting
:pause   <agent>                  NEW — sets idle, suppresses scheduler
:resume  <agent>                  NEW

:events [--follow] [--filter …]   live event tail with regex filter
:logs   <agent> [--follow]
:cost   [--today|--week]

:search <query>                   NEW — fuzzy search across agents, groups,
                                  recent events, GitHub issues in signal cache
:open   <issue-url|agent|group>   NEW — opens in $BROWSER (issue) or jumps in REPL
:edit   <agent>                   NEW — opens the agent's role.md in $EDITOR

:config [get|set] <key> [value]
:help   [<cmd>]
:quit                             stop the REPL only (alias :q, Ctrl-D)
```

Tab completion is mandatory for: command names, agent IDs, group IDs, session names, recent issue numbers. The current `attach.ts` already does the first three.

### 5.3 Leader-key bindings (default keymap)

Leader is `Ctrl-a` by default (rebindable; users who already use `Ctrl-a` for tmux can set it to `Ctrl-b` or `\``).

```
C-a d        :detach
C-a D        :detach + :stop confirmation
C-a l        list-and-pick murmurations (popup)
C-a s        :switch <name> picker
C-a a        :agent <id> picker
C-a g        :group <id> picker
C-a w        :wake <agent> picker
C-a c        :convene <group> picker
C-a m        :directive picker
C-a e        :events --follow
C-a $        :status --verbose
C-a /        :search prompt
C-a ?        cheat sheet overlay
C-a :        raw command prompt (vim-ex style)
C-a r        :reload config
C-a q        :quit (with confirmation)
```

These bindings are stored in `~/.murmuration/config.toml` under `[keys]` and reloaded on `C-a r`. Users may add their own bindings to any REPL command.

---

## 6. Daemon Protocol Additions

The current socket methods (`status`, `directive`, `wake-now`, `group-wake`, `stop`) cover roughly half of the surface above. The following additions are required, and should land in one batch with a versioned schema.

```
RPC methods (newline-delimited JSON over .murmuration/daemon.sock)

  agents.list        -> Agent[]
  agents.get         { id } -> AgentDetail
  agents.pause       { id }                    NEW
  agents.resume      { id }                    NEW
  agents.logs        { id, follow?, lines? }   NEW (streaming response)

  groups.list        -> Group[]
  groups.get         { id } -> GroupDetail
  groups.backlog     { id, refresh? } -> Backlog

  wakes.cancel       { wakeId }                NEW
  meetings.cancel    { meetingId }             NEW

  events.subscribe   { since?, filter? }       NEW (streaming, replaces ad-hoc tail)
  events.history     { since?, limit? }        NEW (ring buffer dump)

  cost.summary       { window }                NEW
  search             { query, kinds? }         NEW

  daemon.info        -> { version, schemaVersion, startedAt, root, name }
  daemon.shutdown    (existing `stop`)
```

**Schema versioning.** Add `schemaVersion: number` to `daemon.info` and to every response envelope. CLI/TUI/web clients refuse to operate when the daemon's schema is newer than they understand, with a clear upgrade message. Mismatch is the #1 source of "weird" bugs in tools like this; making it explicit is cheap.

**Streaming responses.** `agents.logs --follow` and `events.subscribe` need a streaming idiom over the socket. Easiest: keep the existing event envelope (`{ "event": ..., "data": ... }`) but tag it with the originating subscription id so a single connection can multiplex multiple streams. The HTTP layer already does this via SSE; the socket should mirror it.

**Read-only attach.** A new connection flag `mode: "read-only"` that the daemon enforces by rejecting any RPC tagged as mutating. Useful for shoulder-surfing demos and for the web dashboard's anonymous viewers.

---

## 7. Parity Matrix (CLI / TUI / Web)

This matrix is the contract. It lives at `packages/core/src/daemon/protocol.ts` next to the schema, and CI validates that every method has a row and every row has at least the CLI column checked.

| Capability                 | CLI batch | CLI REPL | TUI dash | Web dash |
| -------------------------- | :-------: | :------: | :------: | :------: |
| List murmurations          |    ✅     |    ✅    |    🟡    |    🟡    |
| Attach / detach / switch   |    ✅     |    ✅    |    🟡    |    ❌    |
| Status snapshot            |    ✅     |    ✅    |    ✅    |    ✅    |
| Live event stream          |    ✅     |    ✅    |    ✅    |    ✅    |
| Agent list / detail        |    ✅     |    ✅    |    ✅    |    ✅    |
| Group list / detail        |    ✅     |    ✅    |    ✅    |    ✅    |
| Send directive             |    ✅     |    ✅    |    🟡    |    ✅    |
| Wake agent now             |    ✅     |    ✅    |    🟡    |    ✅    |
| Convene group meeting      |    ✅     |    ✅    |    🟡    |    ✅    |
| Cancel in-flight wake      |    🟡     |    🟡    |    ❌    |    ❌    |
| Pause / resume agent       |    🟡     |    🟡    |    ❌    |    ❌    |
| Backlog view / refresh     |    ✅     |    ✅    |    🟡    |    ❌    |
| Cost summary               |    🟡     |    🟡    |    ✅    |    ✅    |
| Tail agent logs            |    🟡     |    🟡    |    ❌    |    ❌    |
| Search                     |    🟡     |    🟡    |    ❌    |    ❌    |
| Edit role.md               |    🟡     |    🟡    |    ❌    |    ❌    |
| Stop / restart daemon      |    ✅     |    ✅    |    🟡    |    ✅    |
| Multi-murmuration overview |    ✅     |    🟡    |    ❌    |    ❌    |
| Read-only mode             |    🟡     |    🟡    |    ❌    |    🟡    |

✅ = exists today. 🟡 = planned in this design. ❌ = explicitly out of scope for the named surface.

The rule that follows from the matrix: **the CLI never has a ❌**. Whatever a power user can do anywhere, they can do at the prompt.

---

## 8. Configuration

A new file: `~/.murmuration/config.toml`. Read at attach time; reloadable in-REPL.

```toml
[ui]
leader = "C-a"             # C-a, C-b, C-`, or any single-key sequence
prompt = "{name}> "        # supports {name}, {root}, {agents}, {now}
default_view = "overview"  # overview | agents | groups | events
color = "auto"             # auto | always | never

[keys]
"C-a d" = ":detach"
"C-a s" = ":switch"
"C-a /" = ":search"
# user-defined bindings dispatch to any REPL command

[aliases]
mu = "murmuration"
ll = ":agents --filter running"

[sessions]
# optional pinned sessions surfaced first in `list`
pinned = ["alpha", "gov-test"]
```

`murmuration config edit` opens `$EDITOR`. `murmuration config get ui.leader` and `set` round-trip individual keys. The schema is a typed Zod object so unknown keys produce friendly errors instead of silent ignores.

---

## 9. Phased Implementation Plan

The work is sized for incremental delivery. Each phase is independently shippable and leaves the system in a working state.

### Phase 1 — Foundations (≈1 sprint)

Goal: lock down the protocol and parity machinery, with no user-visible feature gaps yet.

1. Define `protocol.ts` as the single source of truth for socket methods, request/response types, and the parity matrix. Generate the dispatcher table from it.
2. Add `schemaVersion` to `daemon.info` and to every envelope; client refuses on mismatch.
3. Add streaming-response multiplexing to the socket transport (subscription ids).
4. Introduce `~/.murmuration/config.toml` loader (Zod-typed) and wire it into `attach`.
5. Generate `murmuration help` and `:help` from the command registry; CI test asserts every verb has help text.

Exit criteria: `pnpm run check` green; existing CLI/TUI/web behavior unchanged; new help system complete; parity matrix in place with current state recorded.

### Phase 2 — Batch verb expansion (≈1 sprint)

Goal: get the CLI to feature-complete vs the TUI/web for read-only operations.

1. Add `agents`, `groups`, `events`, `cost`, `logs` batch verbs (read-only RPCs).
2. Unify `--name` selection across every verb; deprecate (but keep) `--root` aliases.
3. Add `--all` to `status`, `stop`, `events --follow`.
4. Add `status --watch` (re-render every N seconds, exit on `q`).
5. JSON output mode (`--json`) on every read verb for scripting.

Exit criteria: every read in §7 marked ✅ for CLI batch.

### Phase 3 — REPL maturation (≈1–2 sprints)

Goal: make the REPL the primary way a power user runs the day.

1. Switch REPL command syntax to `:`-prefixed; keep current commands as fallbacks for one release with a deprecation notice.
2. Implement leader-key state machine with the default keymap.
3. Implement pickers (sessions, agents, groups, wakes, meetings) using a small fzf-style fuzzy matcher (no external dependency — `~200 LOC`).
4. Implement `:search`, `:open`, `:edit`, `:cancel`, `:pause`, `:resume`.
5. Cheat sheet overlay (`C-a ?`).
6. Tab completion across all new commands.

Exit criteria: every row in §7's CLI REPL column marked ✅ or 🟡-resolved.

### Phase 4 — Multi-murmuration overview (≈1 sprint)

Goal: a single "where am I" pane that spans every running daemon.

1. New `murmuration top` (or `:top`) — aggregated dashboard across all registered, running murmurations: name, agents running/idle/failed, today's cost, last event time, attention items.
2. Aggregator queries each daemon's `status` and `events.history` in parallel; degrades gracefully on stale heartbeats.
3. Push the same view into the TUI dashboard as a new "All Sessions" tab.
4. Push the same view into the web dashboard as a `/all` route.

Exit criteria: a single command (`murmuration top` / `:top` / TUI tab / web `/all`) shows the state of every murmuration the operator owns.

### Phase 5 — Polish & docs (≈0.5 sprint)

1. `docs/CLI-COOKBOOK.md` — recipe-driven walk-through (start a murmuration, attach, send a directive, convene, detach, batch a directive across all sessions).
2. Cast a 5-minute asciinema demo and link from README.
3. Update `ARCHITECTURE.md` with the protocol/parity sections.
4. ADR: "CLI tmux-style interface and parity contract."

---

## 10. Risks & Open Questions

**Leader-key conflicts with terminal multiplexers.** Operators who use tmux already have `C-a` or `C-b` claimed. The default must be configurable from the first release, and the install flow should detect `$TMUX` and suggest a non-conflicting default (`C-\`` is a reasonable fallback).

**Streaming over a single socket.** Multiplexing subscriptions over one connection is more complex than opening a connection per stream. The simpler approach (one connection per stream) is cheap on Unix sockets and avoids head-of-line blocking; it's worth benchmarking before committing to multiplexing.

**Read-only enforcement.** Tagging every RPC as mutating/non-mutating is bookkeeping that drifts unless it lives in the schema. Make it a required field of the method definition in `protocol.ts`, not a separate list.

**Web dashboard scope creep.** The matrix deliberately leaves several rows ❌ for the web surface (cancel, pause, edit). Keep them out. The web dashboard is for visibility and the safe high-frequency mutations (directive, wake, convene); destructive or developer-affecting actions belong in the CLI.

**Cross-machine attach.** Today the socket is local. A natural next step is `murmuration attach user@host:name` over SSH, reusing the same protocol on stdio. Out of scope for v1, but the protocol design should not preclude it (which it doesn't, because newline-delimited JSON is trivially tunnelable).

**Schema version churn.** Bumping `schemaVersion` on every additive change will frustrate users with mismatched clients. Use semver-style: bump minor for additions (clients tolerate unknown fields), major only for incompatible changes (clients refuse).

---

## 11. Summary

The harness already has every architectural piece needed for a tmux-class operator experience: a long-lived daemon per murmuration, a control socket, a session registry with heartbeats, an attach REPL, and a separate visualization layer. What it lacks is _coherence_: a stated mental model, a parity contract, a leader-key vocabulary, and a CLI that is unambiguously the most powerful client.

This document proposes treating that coherence as a first-class deliverable. The work is mostly composition rather than invention — about a sprint of foundation, a sprint of CLI breadth, two sprints of REPL depth, a sprint of multi-murmuration overview, and a half-sprint of docs. At the end, a power user attaches with `murmuration attach alpha`, hits `Ctrl-a /`, fuzzy-finds an issue, jumps to the responsible agent, sends a directive, detaches with `Ctrl-a d`, and never leaves the keyboard — and every action they took is also a scriptable batch verb, and every state they saw is also visible in the TUI and the web dashboard.

That is the bar.
