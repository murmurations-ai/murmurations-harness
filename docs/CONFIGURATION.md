# Configuration reference

Everything an operator can tune via `murmuration/harness.yaml`.

Load order:

```
defaults (in code) → harness.yaml → CLI flags → environment variables
```

Anything not set falls back to the default. Anything invalid falls back silently (the loader never throws) so a typo in one field doesn't brick the daemon. Use `murmuration doctor` to validate a setup.

## Example

```yaml
# murmuration/harness.yaml

llm:
  provider: gemini # gemini | anthropic | openai | ollama
  model: gemini-2.5-pro # optional; omit to let the tier resolver pick

governance:
  plugin: s3 # bundled alias, or ./path/to/plugin.mjs, or npm package

collaboration:
  provider: github # github | local
  repo: my-org/my-murmuration # required when provider = github

products:
  - name: my-product
    repo: my-org/my-product

logging:
  level: info # debug | info | warn | error

spirit:
  maxSteps: 32 # Spirit tool-loop budget per turn
```

## Fields

### `llm`

Harness-level default LLM. Individual agents override via their `role.md` `llm:` frontmatter.

| Field      | Type   | Default       | Notes                                                                                                                             |
| ---------- | ------ | ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `provider` | enum   | `gemini`      | One of `gemini`, `anthropic`, `openai`, `ollama`.                                                                                 |
| `model`    | string | tier-resolved | Explicit model ID. When omitted the tier resolver picks a "balanced" model for the provider; see `packages/llm/src/providers.ts`. |

The Spirit inherits this default unless a future `spirit.md` overrides it.

### `governance`

| Field    | Type   | Default     | Notes                                                                                                                                                         |
| -------- | ------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugin` | string | `undefined` | Bundled alias (`s3`, `self-organizing`), a path starting with `.` or `/`, or an installed npm package name. When omitted the harness runs without governance. |

`murmuration doctor` reports the resolution kind (bundled-alias / local-path / npm-package / unresolvable).

### `collaboration`

Where meeting minutes, action items, and signals are written.

| Field      | Type   | Default     | Notes                                                                                                           |
| ---------- | ------ | ----------- | --------------------------------------------------------------------------------------------------------------- |
| `provider` | enum   | `github`    | `github` (canonical) or `local` (writes to `.murmuration/items/` on disk — useful for testing without a token). |
| `repo`     | string | `undefined` | `owner/repo`. Required when `provider: github`.                                                                 |

### `products`

Additional repos the harness may open issues/PRs against. Agents reference these by name from `role.md` write scopes.

```yaml
products:
  - name: my-product
    repo: my-org/my-product
```

Each entry needs both `name` and `repo`. Malformed entries are silently dropped.

### `logging`

| Field   | Type | Default | Notes                                |
| ------- | ---- | ------- | ------------------------------------ |
| `level` | enum | `info`  | `debug` / `info` / `warn` / `error`. |

### `spirit`

Spirit-specific knobs. The Spirit is the operator's read-only companion; see [ADR-0024](./adr/0024-spirit-of-the-murmuration.md).

| Field      | Type   | Default | Notes                                                                                                                                                                                                                                                                      |
| ---------- | ------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxSteps` | number | `32`    | Tool-use budget per Spirit turn. Each step is one round-trip to the LLM plus any tool calls. Larger murmurations (many agents) need a bigger budget or the Spirit runs out of steps before producing a final answer. Must be ≥ 1; invalid values fall back to the default. |

When the budget is exhausted the REPL shows:

```
(Spirit ran out of tool-use budget before producing an answer. Try narrowing the question, or ask for a shorter summary.)
```

## Precedence

CLI flags override `harness.yaml` for the keys they cover:

| Flag                  | Overrides                |
| --------------------- | ------------------------ |
| `--governance <path>` | `governance.plugin`      |
| `--collaboration <p>` | `collaboration.provider` |
| `--log-level <lvl>`   | `logging.level`          |

Environment variables are read at runtime by the providers themselves (e.g. `GEMINI_API_KEY`, `GITHUB_TOKEN`) — they never appear in `harness.yaml`. See `.env.example`.

## Spirit memory (v0.7.0 [O])

The Spirit accumulates curated facts across attaches at:

```
<root>/.murmuration/spirit/memory/
  MEMORY.md        — index, always loaded into the Spirit system prompt
  user_*.md        — facts about Source (preferences, role, working context)
  feedback_*.md    — corrections + validations from Source
  project_*.md     — what's happening in this murmuration (drift fast)
  reference_*.md   — pointers into external systems (Linear, Slack, vaults)
```

The four-type taxonomy comes from Claude Code's auto-memory system — same shape, same write rules, same hand-edit semantics.

**REPL commands:**

| Command            | Effect                                                                                |
| ------------------ | ------------------------------------------------------------------------------------- |
| `:remember <name>` | Source-explicit save (interactive: prompt for description, multi-line body until `.`) |
| `:forget <name>`   | Confirm-then-remove                                                                   |
| `:reset memory`    | Clear every memory file + index (cannot be undone)                                    |

**Spirit tools** (called by the LLM during a turn):

| Tool                                      | Purpose                                               |
| ----------------------------------------- | ----------------------------------------------------- |
| `remember(type, name, description, body)` | Auto-save when Spirit detects a save-worthy moment    |
| `forget(name)`                            | Idempotent remove                                     |
| `recall(query?)`                          | Case-insensitive search; no query → returns the index |

**Hand-edit:** the files are plain markdown with frontmatter (`name`, `description`, `type`). Source can edit `MEMORY.md` and individual files directly — Spirit picks up changes on next attach.

**Sync between machines:** memory lives under `<root>/.murmuration/`, which is **not** in git by default (would expose `user`-type memory in repo). For cross-machine continuity, sync the murmuration root via your usual mechanism (cloud storage, manual rsync) — there's no harness-managed sync.

## Spirit skills (v0.7.0 [R])

Operators can install skills at:

```
<root>/.murmuration/spirit/skills/
  SKILLS.md       — operator-installed skill index
  *.md            — operator-installed skill bodies
```

Per-murmuration skills **shadow bundled skills with the same name**. Skills are markdown — no runtime, no sandbox. Use them to teach this Spirit operator-specific patterns (e.g. `pricing-context`, `incident-response`) without forking the harness.

**Install:**

- Spirit tool: `install_skill(name, description, body)` — writes the file + updates SKILLS.md.
- Hand-drop: write `.md` files directly into the skills dir; Spirit picks them up next attach.

**Load:** `load_skill(name)` checks the per-murmuration overlay first, then falls back to bundled. The response prefixes `[per-murmuration]` or `[bundled]` so the caller knows which body it got.

**System prompt:** at attach, the prompt includes both the bundled skill index AND the per-murmuration index — operators see what's available without an explicit `recall`/`load_skill`.

## Spirit cross-attach context (v0.7.0 [N])

The Spirit's REPL session persists across attaches at:

```
<root>/.murmuration/spirit/
  conversation.jsonl    — append-only LLM turns
  session.json          — { "sessionId": "..." } for subscription-CLI resume
```

On `murmuration attach`, Spirit hydrates prior conversation + sessionId. On every turn, both files update before the next prompt. Detach is implicit (Ctrl-C, terminal close) — appends are immediately durable.

**REPL commands:**

| Command           | Effect                                                                 |
| ----------------- | ---------------------------------------------------------------------- |
| `:reset`          | Clear `conversation.jsonl` + `session.json` (next attach starts fresh) |
| `:bye`            | Detach with a "context preserved" farewell                             |
| `:report [scope]` | One-call murmuration report — health \| activity \| attention \| all   |

## Not yet configurable

Several tunables are still hardcoded and tracked in [issue #152](https://github.com/murmurations-ai/murmurations-harness/issues/152): daemon circuit-breaker threshold, LLM retry policy, signal aggregator caps, meeting-prompt context caps, and group-meeting LLM params. Each moves to `harness.yaml` in subsequent PRs following the `spirit.maxSteps` pattern.

## What never goes in `harness.yaml`

- **Secrets** — API keys, tokens, passphrases. Use `.env` (see `secrets-dotenv` provider) or a platform secrets manager.
- **Identity** — agent souls, roles, group membership. These live in `agents/<slug>/` and `governance/groups/` per [ADR-0026](./adr/0026-harness-directory-layout.md).
- **Per-agent overrides** — model, schedule, budget, write scopes. These go in `agents/<slug>/role.md` frontmatter per [ADR-0016](./adr/0016-role-md-schema.md).

Engineering Standard #11 in [ARCHITECTURE.md](./ARCHITECTURE.md) explains the split: reasonable defaults with config-file overrides for operational knobs; never for identity or secrets.
