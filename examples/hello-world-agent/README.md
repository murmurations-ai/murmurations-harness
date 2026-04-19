# hello-world-agent

The simplest possible murmuration the harness can wake. Pure markdown
— no JavaScript at all. Exists to prove the wake loop is structurally
correct with nothing but identity files.

## What it is

- `murmuration/soul.md` — murmuration purpose
- `agents/hello-world/soul.md` — agent character
- `agents/hello-world/role.md` — agent frontmatter + accountabilities
- `governance/groups/engineering.md` — group context

No `agent.mjs`. No `runner.mjs`. No `llm:` block in role.md. The
harness boots, fires the scheduled wake, and the default runner
records a `"skipped — no LLM client"` wake summary to the run
artifacts under `.murmuration/runs/hello-world/`. That's the proof
that identity loading, scheduling, signal aggregation, and artifact
capture all work end-to-end.

## Run via the harness

```bash
pnpm build
murmuration start --root examples/hello-world-agent
```

The daemon fires a wake after a 2-second delay, captures the skip
summary, and stays alive until `Ctrl-C`.

## Add an LLM when you're ready

Edit `agents/hello-world/role.md` and drop in an `llm:` block:

```yaml
llm:
  provider: "gemini" # or anthropic, openai, ollama, vertex, …
  model: "gemini-2.5-flash"
```

Set the corresponding API key in `.env` and the next wake calls the
LLM instead of skipping. Still no JavaScript required.
