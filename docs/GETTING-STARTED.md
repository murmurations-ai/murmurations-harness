# Getting Started with the Murmuration Harness

The Murmuration Harness is a generic AI-agent coordination runtime. One human (the **Source**) runs any number of AI agents as a coordinated "murmuration" — scheduling wakes, convening group meetings, tracking costs, and producing artifacts.

This guide walks you from zero to a running meeting in under 10 minutes. No prior harness experience required.

---

## Prerequisites

- **Node.js 20+** (`node --version`)
- **npm** (ships with Node)
- **An API key** for your LLM provider of choice. Free-tier Gemini works great for testing — get one at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) (no credit card required).
- **Required Tools:** Agents need MCP servers installed to perform their duties. See the [Toolchain Setup Guide](./TOOLCHAIN-GUIDE.md) for instructions on setting up GitHub, jMunch, etc.
- **Optional: a GitHub personal access token** if you want agents to read/write GitHub Issues. For the tutorial you can skip it — the example uses local-only collaboration.

---

## Path A — Fast: run the bundled example (5 minutes)

The fastest way to see the harness work is to scaffold the bundled `hello-circle` example. Two agents, one group, no GitHub required.

### 1. Install the CLI

```sh
npm install -g @murmurations-ai/cli
```

Expected output: `added 123 packages` (varies).

### 2. Scaffold the example

```sh
murmuration init --example hello my-first-murm
cd my-first-murm
```

Expected output:

```
✓ Copied example "hello-circle" to /path/to/my-first-murm
  Registered as "my-first-murm".

Next:

  cd my-first-murm
  cp .env.example .env
  chmod 600 .env
  # edit .env and paste your GEMINI_API_KEY

  murmuration doctor --name my-first-murm
  murmuration group-wake --name my-first-murm --group example --directive "what should we scout next?"
```

### 3. Paste your Gemini API key

```sh
cp .env.example .env
chmod 600 .env
```

Then open `.env` in your editor and paste your key:

```
GEMINI_API_KEY=AIzaSy...your-actual-key...
```

### 4. Validate the setup

```sh
murmuration doctor
```

Expected output:

```
murmuration doctor — checking /path/to/my-first-murm

  Layout .................. ✓
  Schema .................. ✓
  Secrets ................. ✓
  Governance .............. ℹ 1 info
  Live validation ......... (skipped; pass --live to enable)
  Drift / best-practice ... ✓

  Summary
  ✓ No errors. Your murmuration should run.
```

The one info notice is about the no-op governance plugin — expected for hello-circle.

Want to verify your API key actually works? Add `--live`:

```sh
murmuration doctor --live
```

### 5. Run your first meeting

```sh
murmuration group-wake --group example --directive "what should we scout next?"
```

The facilitator (`host-agent`) invites the scout (`scout-agent`) to contribute. The scout offers observations. The facilitator synthesizes a summary and names a next step. You'll see a streaming transcript in your terminal.

Meeting minutes land in `.murmuration/items/` locally. That's it — you've run a meeting.

---

## Path B — Real: create your own murmuration (~20 minutes)

Once the example works, scaffold a real murmuration tailored to your use case:

```sh
murmuration init my-production-murm
```

The interactive interview will ask:

1. **Purpose** — a sentence describing what this murmuration is for
2. **Default LLM provider** — gemini / anthropic / openai / ollama
3. **API key** — paste it; input is hidden; you'll see a last-4 confirmation
4. **Collaboration provider** — `github` (recommended) or `local`
5. **GitHub repo + token** (if github chosen)
6. **Agent definitions** — name, provider override, group, wake schedule (one loop per agent)
7. **Governance model** — self-organizing (S3) / chain-of-command / meritocratic / consensus / parliamentary / none

Every question has a reasonable default you can ENTER through. API keys are validated for shape before confirmation (the init rejects an obviously wrong paste and lets you try again).

After init, run `murmuration doctor` to validate, edit the scaffolded `role.md` / `soul.md` / `governance/groups/*.md` to flesh out your agents and groups, then `murmuration start` to boot the daemon (or `murmuration group-wake` for on-demand meetings).

---

## What to do when…

The top things that can go wrong, with the exact fix.

| Symptom                                                  | What it means                                                               | Fix                                                                                           |
| -------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `murmuration: command not found`                         | CLI isn't installed or PATH doesn't include npm's global bin                | `npm install -g @murmurations-ai/cli`; verify with `which murmuration`                        |
| `doctor` reports `layout.murmuration.missing`            | You're not in a murmuration directory                                       | `cd` into the directory you created with `init`, or pass `--root <path>`                      |
| `doctor` reports `secrets.env.<KEY>.missing`             | Your `.env` has the placeholder but not a real key                          | Edit `.env` and paste your actual key; save                                                   |
| `doctor` reports `layout.env.mode`                       | `.env` is group/world-readable                                              | `chmod 600 .env`, or run `murmuration doctor --fix`                                           |
| `doctor` reports `schema.role.<slug>.model_tier`         | A role.md has a non-enum `model_tier`                                       | Use one of `"fast"`, `"balanced"`, `"deep"`                                                   |
| `doctor` reports `schema.role.<slug>.llm.provider`       | A role.md has an unrecognized provider                                      | Use one of `"gemini"`, `"anthropic"`, `"openai"`, `"ollama"`                                  |
| `doctor` reports `layout.legacy-circles.only`            | You migrated from pre-ADR-0026 but still have `governance/circles/`         | `murmuration doctor --fix` renames it to `governance/groups/`                                 |
| `group-wake: could not read LLM config from facilitator` | The facilitator agent's `role.md` has a schema issue                        | Run `murmuration doctor` — the real error is reported there                                   |
| `create-issue: PERMISSION_DENIED`                        | Your `GITHUB_TOKEN` lacks `repo` scope, or the repo is wrong                | Regenerate token with `repo` scope; verify `collaboration.repo` in `murmuration/harness.yaml` |
| `group-wake` runs but the facilitator fails mid-turn     | Usually hit rate limit or out of quota on the LLM provider                  | Check the provider's dashboard; try again, or switch providers per-agent in role.md           |
| Meeting minutes don't appear in GitHub Issues            | Collaboration provider is `local` (writes to `.murmuration/items/` instead) | Check `collaboration.provider` in `murmuration/harness.yaml`                                  |

When in doubt, `murmuration doctor` is the first thing to run. It validates against the full rubric and auto-fixes what it can.

---

## Key commands reference

| Command                                                 | What it does                                  |
| ------------------------------------------------------- | --------------------------------------------- |
| `murmuration init [dir]`                                | Interactive scaffold of a new murmuration     |
| `murmuration init --example hello [dir]`                | Scaffold the bundled hello-circle example     |
| `murmuration doctor [--live] [--fix] [--json]`          | Diagnose a murmuration's setup                |
| `murmuration start [--root\|--name]`                    | Boot the daemon                               |
| `murmuration group-wake --group <id> --directive "..."` | Convene a group meeting on demand             |
| `murmuration directive --agent <id> "..."`              | Send a directive to a specific agent          |
| `murmuration agents`                                    | List registered agents and their state        |
| `murmuration attach <name>`                             | Interactive REPL attached to a running daemon |
| `murmuration status`                                    | Show daemon + agent state summary             |
| `murmuration stop`                                      | Graceful shutdown                             |

Pass `--help` to any command for full flag documentation.

---

## Next steps

- **Flesh out your agents.** Each `agents/<slug>/role.md` and `soul.md` is yours to edit. The init scaffolds sensible defaults; you make them specific.
- **Pick a governance model.** v0.5.0 ships with five: S3 (self-organizing), chain-of-command, meritocratic, consensus, parliamentary. Declare one in `murmuration/harness.yaml`.
- **Set real wake schedules.** By default, new agents are dispatch-only. Add `wake_schedule.cron` when you're ready for autonomous wakes.
- **Tune budgets and write scopes** per agent as you observe what they actually need.
- **Read the architecture docs.** [docs/ARCHITECTURE.md](./ARCHITECTURE.md) covers the engineering standards; ADRs under [docs/adr/](./adr/) cover every load-bearing design decision.

Questions, bugs, feedback: open an issue on [murmurations-ai/murmurations-harness](https://github.com/murmurations-ai/murmurations-harness/issues).
