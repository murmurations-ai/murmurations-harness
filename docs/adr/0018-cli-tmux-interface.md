# ADR-0018 — CLI tmux-style interface and parity contract

- **Status:** Accepted (shipped)
- **Date:** 2026-04-13
- **Decision-maker(s):** Source (design), Engineering Circle (consent pending), CLI / TUI / Web maintainers (implementation)
- **Consulted:** Operators (current heavy users of `murmuration attach`), Daemon Runtime Agent, Dashboard Agent
- **Supersedes:** _none_
- **Extends:** ADR-0007 (stdio protocol), socket protocol in `packages/core/src/daemon/http.ts` and `packages/core/src/daemon/socket-server.ts`
- **Related:** `docs/CLI-TMUX-DESIGN.md` (the full design specification this ADR ratifies)

## Context

The harness already runs many of its operator-facing capabilities through three surfaces: a CLI (`@murmurations-ai/cli`), a pi-tui dashboard (`@murmurations-ai/dashboard-tui`), and a static HTML web dashboard served by `DaemonHttp`. Each surface has grown organically. The result is a set of capability gaps that operators run into within the first week of real use:

1. **The CLI is not the most powerful surface.** The web dashboard exposes "Send Directive" and "Convene Group" buttons that the CLI batch verbs do not yet wrap. Power users who live in the terminal are forced into the browser to do common operations.
2. **There is no coherent multi-murmuration model.** A user running three murmurations has three separate `attach` sessions, three separate dashboards, and no aggregated view. The session registry exists (`~/.murmuration/sessions.json`) but is under-used.
3. **The REPL command vocabulary is small and undiscoverable.** `attach` supports `status`, `directive`, `wake`, `convene`, `switch`, `stop`, `quit` and nothing else. There is no `:help`, no tab completion for many verbs, no way to search or inspect history without leaving the REPL.
4. **Parity drift is not detected.** When a new method is added to the socket protocol, nothing forces the CLI/TUI/web to absorb it. The dashboards quietly diverge.
5. **No leader-key model.** Operators familiar with `tmux` / `screen` have an obvious expectation of how a long-lived multi-session terminal tool should feel. The harness does not meet that expectation despite being structurally identical to tmux (long-lived server, named sessions, attach/detach over a Unix socket).

The fix is partly composition (most of the pieces already exist) and partly contract (we need rules that prevent drift). This ADR ratifies both.

The full design — command surface, REPL grammar, leader keymap, configuration schema, phased plan, and risk register — lives in `docs/CLI-TMUX-DESIGN.md`. This ADR is the load-bearing decision record; the design doc is the elaboration.

## Decision

### §1 — Adopt the tmux mental model

The harness adopts tmux as its operator mental model. The mapping is normative:

| tmux            | Murmuration                                         |
| --------------- | --------------------------------------------------- |
| server          | the daemon (one per murmuration root)               |
| session         | a registered murmuration (entry in `sessions.json`) |
| window          | a group                                             |
| pane            | an agent within a group                             |
| attach / detach | `murmuration attach <name>` / leader-key `d`        |
| send-keys       | `murmuration directive`                             |
| `.tmux.conf`    | `~/.murmuration/config.toml`                        |

The two invariants this model enforces:

1. **Daemons outlive their clients.** Detach never stops work; attach never restarts it. This is already true at the daemon layer; the ADR commits to never breaking it.
2. **A single leader key gates a learnable command vocabulary.** Default `Ctrl-a`, configurable, with collision detection against `$TMUX`.

### §2 — Three CLI modes, one command vocabulary

The CLI exposes operator capability through three modes that share the same underlying command set:

- **Batch verbs** — `murmuration <verb> [flags]`. Scriptable, used by cron, CI, and muscle memory.
- **REPL mode** — `murmuration attach <name>`. Line-oriented, `:`-prefixed commands (vim ex-style), tab completion, free-text only inside an explicit `:directive` flow.
- **Leader-key mode** — modal layer on top of the REPL. Single-keystroke shortcuts that dispatch to REPL commands.

**Hard rule: every interactive operation must also exist as a batch verb.** If the REPL can do it, the CLI batch surface can too. Leader keys dispatch to REPL commands; REPL commands dispatch to RPCs; batch verbs call the same RPCs directly. There is one command vocabulary, three ways to invoke it.

### §3 — Parity matrix as an enforced contract

A parity matrix lives at `packages/core/src/daemon/protocol.ts` next to the schema. Every RPC method declares which surfaces support it (`cliBatch`, `cliRepl`, `tuiDash`, `webDash`) as part of its definition, not as documentation:

```ts
export interface ProtocolMethod<Req, Res> {
  readonly name: string;
  readonly request: ZodSchema<Req>;
  readonly response: ZodSchema<Res>;
  readonly mutating: boolean; // §6
  readonly surfaces: {
    readonly cliBatch: "shipped" | "planned" | "out-of-scope";
    readonly cliRepl: "shipped" | "planned" | "out-of-scope";
    readonly tuiDash: "shipped" | "planned" | "out-of-scope";
    readonly webDash: "shipped" | "planned" | "out-of-scope";
  };
}
```

**CI gates:**

1. Every method declared in `protocol.ts` must have at least `cliBatch === "shipped"`. Failing this fails the build. _The CLI never has an `out-of-scope` cell._
2. A `parity.test.ts` walks each method and asserts that `surfaces.cliBatch === "shipped"` implies a corresponding registered batch verb in `@murmurations-ai/cli`, and `surfaces.cliRepl === "shipped"` implies a registered REPL command in `attach.ts`.
3. The TUI and web dashboards may declare `out-of-scope` for any cell — but the CLI may not.

This converts parity from aspirational documentation into a buildable invariant.

### §4 — Protocol additions (one batch, schema-versioned)

The current socket methods (`status`, `directive`, `wake-now`, `group-wake`, `stop`) cover roughly half of the desired surface. The following additions ship as one batch:

```
agents.list / agents.get / agents.pause / agents.resume / agents.logs
groups.list / groups.get / groups.backlog
wakes.cancel / meetings.cancel
events.subscribe / events.history
cost.summary
search
daemon.info  (returns version, schemaVersion, startedAt, root, name)
```

Every response envelope grows a `schemaVersion: number` field. Clients refuse to operate against a daemon whose schema is newer than they understand and emit a clear upgrade message. Bumping rules:

- **Minor bump** for additions (clients tolerate unknown fields).
- **Major bump** for incompatible changes (clients refuse).

This is the cheapest available defense against the "weird intermittent bug" class that comes from mismatched client/daemon versions.

### §5 — Streaming over the socket

`agents.logs --follow` and `events.subscribe` need a streaming idiom. Decision: **one connection per stream**, not multiplexed subscriptions over a single connection. Rationale:

- Unix-domain sockets are cheap to open. The complexity of multiplexing (subscription IDs, head-of-line blocking, fan-out bookkeeping) is not worth the small connection-count savings.
- The HTTP/SSE bridge can fan one socket subscription out to many web clients on its own — the daemon does not need to handle that itself.
- Per-stream connections are trivially tunnelable over SSH later (`murmuration attach user@host:name`), which the multiplexed design would complicate.

If benchmarks later show connection-per-stream is a real cost (>500 concurrent streams per daemon), revisit. Until then, simplicity wins.

### §6 — Read-only attach mode

A new connection flag `mode: "read-only"` is set during the socket handshake. The daemon enforces it by rejecting any RPC whose `ProtocolMethod.mutating` field is `true`, returning `PermissionError("connection is read-only")`. The `mutating` field is required on every method definition in `protocol.ts`; CI rejects PRs that omit it.

Read-only attach is what the web dashboard's anonymous viewers and shoulder-surfing demos use. The CLI exposes it via `murmuration attach <name> --read-only`.

### §7 — Configuration file

A new file at `~/.murmuration/config.toml`, loaded at attach time, reloadable in-REPL (`C-a r`). Schema is a Zod object so unknown keys produce friendly errors instead of silent ignores.

```toml
[ui]
leader = "C-a"
prompt = "{name}> "
default_view = "overview"
color = "auto"

[keys]
"C-a d" = ":detach"
"C-a s" = ":switch"
"C-a /" = ":search"

[aliases]
ll = ":agents --filter running"

[sessions]
pinned = ["alpha", "gov-test"]
```

`murmuration config edit` opens `$EDITOR`. `murmuration config get/set <key> [value]` round-trips individual keys. Install flow detects `$TMUX` and proposes `C-\`` as a non-conflicting default leader.

### §8 — Help is generated, not maintained

`murmuration help [<topic>]` and `:help [<cmd>]` are generated from the same command registry the dispatcher uses. A CI test asserts every registered verb and every REPL command has a non-empty `help` string and a one-line `summary`. There are no undocumented verbs by construction.

### §9 — Phased delivery

Five phases, each independently shippable. Detail in `docs/CLI-TMUX-DESIGN.md §9`.

1. **Foundations** — `protocol.ts` SSOT, `schemaVersion`, config loader, generated help, parity test scaffold.
2. **Batch verb expansion** — `agents`, `groups`, `events`, `cost`, `logs` verbs; `--name` unification; `--all` and `--watch`; `--json` everywhere.
3. **REPL maturation** — `:`-prefixed grammar, leader-key state machine, fuzzy pickers, `:search` / `:open` / `:edit` / `:cancel` / `:pause` / `:resume`, cheat sheet overlay.
4. **Multi-murmuration overview** — `murmuration top` aggregator across all registered running daemons; mirrored as TUI tab and web `/all` route.
5. **Polish & docs** — `docs/CLI-COOKBOOK.md`, asciinema demo, ARCHITECTURE.md update.

Each phase keeps `pnpm run check` green and ships behind no flags.

### §10 — Out of scope for this ADR

- **Cross-machine attach** (`murmuration attach user@host:name`). The protocol design does not preclude it (newline-delimited JSON over stdio is trivially SSH-tunnelable), but the auth model, agent forwarding, and SSH config UX deserve their own ADR.
- **Web dashboard feature parity with CLI.** The matrix deliberately leaves several rows `out-of-scope` for the web surface (cancel, pause, edit, role-md edit). Destructive or developer-affecting actions belong in the CLI; the web dashboard is for visibility plus the safe high-frequency mutations (directive, wake, convene).
- **Plugin-defined REPL commands.** A future plugin API may want to register new `:`-commands; the registry is structured to support this but no public extension point ships in v1.
- **Persistent REPL history across attach sessions.** Per-session in-memory history only for v1; persistent history file in a follow-up.

## Consequences

### Positive

- Power users gain a coherent, learnable, terminal-native operator surface.
- Parity drift becomes a build-time error rather than a discovery-time surprise.
- The CLI is unambiguously the most capable client; scripts can do anything humans can.
- Schema-versioned protocol catches mismatched-client bugs explicitly.
- Read-only attach unlocks safe demo and shoulder-surfing scenarios.
- Tmux mental model gives new operators an instant intuition with zero documentation.
- Future cross-machine attach is structurally enabled.

### Negative

- One-time cost of moving the existing REPL from bare verbs to `:`-prefixed commands. Mitigated by keeping bare verbs as fallbacks for one release with a deprecation notice.
- Default leader key (`C-a`) collides with most operators' tmux prefix. Mitigated by `$TMUX` detection at install and by making the leader trivially rebindable.
- Parity test will initially flag many `planned` cells and the suite will be noisy until Phase 2 lands. Mitigated by allowing `planned` as a CI-passing state, only failing on undeclared methods or missing CLI implementations.
- Connection-per-stream may not scale past a few hundred concurrent log tails per daemon. Acceptable for the current operator model; revisit if benchmarks bite.
- Hand-rolled fuzzy picker (~200 LOC) is one more thing to maintain. Mitigated by deliberately scoping it to substring + camel-case acronym matching, no full Levenshtein.

### Neutral

- `~/.murmuration/config.toml` is a new on-disk schema to evolve. Versioned via the same Zod loader as everything else.
- The TUI dashboard remains single-murmuration in v1; multi-session view ships in Phase 4. No regression, just bounded scope.
- Plugin-authored REPL commands are out of scope but not foreclosed.

## Alternatives considered

- **Leave the CLI as-is and invest in the web dashboard.** Rejected: power users explicitly do not want a browser in the loop. The web dashboard is for visibility and casual mutations; the CLI is for daily driving.
- **Build a full `bubbletea`/`tview`-style TUI for everything and skip the REPL.** Rejected: a TUI is harder to script, harder to compose with shell pipelines, and harder to remote-attach. The REPL preserves the property that everything you can do, you can also pipe and grep.
- **Multiplex streaming subscriptions over one socket connection.** Rejected as premature optimization; see §5.
- **Make leader key non-configurable to avoid documentation fragmentation.** Rejected: collision with operators' existing tmux prefix is too common.
- **Document parity in a README table instead of enforcing it in CI.** Rejected: README tables drift; build-time invariants do not.
- **Ship the REPL grammar without the `:` prefix.** Rejected: the `:` prefix cleanly separates commands from free text, prevents the "I typed a typo and convened a meeting" foot-gun, and matches operator intuition from vim/ex.
- **Single `murmuration ui` command that auto-selects CLI/TUI/web based on terminal capability.** Rejected as cute but confusing — operators want to know which surface they're in.

## Carry-forwards

- **CF-cli-A** — Cross-machine attach over SSH (`user@host:name`). Separate ADR.
- **CF-cli-B** — Plugin-defined REPL commands and batch verbs.
- **CF-cli-C** — Persistent REPL history at `~/.murmuration/history`.
- **CF-cli-D** — `murmuration replay <session> <since>` to rehydrate a past attach session from event-history records.
- **CF-cli-E** — Native shell completions (`murmuration completion bash|zsh|fish`) generated from the command registry.
- **CF-cli-F** — `:exec <shell-cmd>` REPL escape for one-off shell commands without detaching.
- **CF-cli-G** — Multi-pane REPL ("show me events on the left, agents on the right") if the line-oriented model proves too narrow.

---

_End of ADR-0018. This ADR is binding for the CLI / TUI / Web surfaces. The full design specification, including the parity matrix snapshot, command surface, leader keymap, and phased plan, lives in `docs/CLI-TMUX-DESIGN.md`._
