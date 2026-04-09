# ADR-0016 — Extended `role.md` Frontmatter Schema for Real Agents

- **Status:** Accepted
- **Date:** 2026-04-09
- **Decision-maker(s):** Architecture Agent #23 (author), Engineering Lead #22 (gate), Source (final consent)
- **Consulted:** TypeScript / Runtime Agent #24 (Zod + types), Security Agent #25 (write scopes, secrets), Performance #27 (budget integration), DevOps #26 (cron parsing)
- **Closes:** PHASE-2-PLAN P3, blocks Phase 2C step 2C1
- **Builds on:** ADR-0010 (secrets), ADR-0011 (cost record), ADR-0012 (github client), ADR-0013 (signal aggregator), CF-signals-C

## Context

The Phase 1B `roleFrontmatterSchema` (`packages/core/src/identity/index.ts:88-96`) ships exactly the fields hello-world needs: `agent_id`, `name`, `model_tier`, `wake_schedule`, `circle_memberships`, `max_wall_clock_ms`. That was deliberately minimum-viable: enough to register an agent, not enough to _operate_ one.

Phase 2 introduces the first real agent (Research #1). A real agent needs: a provider pin, a cron expression, signal scoping, github write scopes, a prompt reference, a budget ceiling, and secret declarations. The schema must extend without breaking hello-world.

## Decision

### Full extended frontmatter schema (worked example: Research Agent #1)

```yaml
# agents/01-research/role.md
agent_id: "01-research"
name: "Research Agent"
soul_file: "soul.md"

# legacy compat
model_tier: "balanced"
max_wall_clock_ms: 600000 # 10 min weekly digest wake
circle_memberships:
  - "intelligence"

# LLM provider + model
llm:
  provider: "gemini" # "gemini" | "anthropic" | "openai" | "ollama"
  model: "gemini-2.5-pro" # optional; resolved from model_tier if absent

# wake schedule (extended)
wake_schedule:
  cron: "0 18 * * 0" # Sunday 18:00

# signal subscriptions (CF-signals-C)
signals:
  sources:
    - "github-issue"
    - "private-note"
    - "inbox-message"
  github_scopes:
    - owner: "xeeban"
      repo: "emergent-praxis"
      filter:
        state: "all"
        since_days: 7
    - owner: "murmurations-ai"
      repo: "murmurations-harness"
      filter:
        state: "all"
        since_days: 7

# GitHub write scopes (least-privilege)
github:
  write_scopes:
    issue_comments:
      - "xeeban/emergent-praxis"
    branch_commits:
      - repo: "xeeban/emergent-praxis"
        paths:
          - "notes/weekly/**"
    labels: []

# prompt reference
prompt:
  ref: "./prompts/wake.md"

# budget ceiling (feeds ADR-0011 BudgetCeiling)
budget:
  max_cost_micros: 500000 # 50¢ per weekly wake
  max_github_api_calls: 100
  on_breach: "abort"

# secret declarations (unioned at boot per ADR-0010)
secrets:
  required:
    - "GEMINI_API_KEY"
  optional: []
```

### Open question decisions

- **`llm.provider` vs `llm.model` precedence:** `provider` is required (boot fails fast if absent). `model` is optional; if present, it overrides the tier. Both pinned is legal; explicit `model` always wins.
- **`signals` location:** frontmatter, with daemon-level defaults when absent. Honours CF-signals-C without forcing every agent to declare repos.
- **`signals.sources` default:** `["github-issue", "private-note", "inbox-message"]` (the three 1B-d implementations).
- **`github.write_scopes` default:** `{}` — no writes allowed. Agents not declaring write scopes are read-only.
- **`prompt.ref` default:** `null`. Hello-world has no prompt file; the runner falls back to the subprocess executor's trivial path.
- **Naming convention:** YAML stays **snake_case** (matches existing convention); TypeScript types stay camelCase; the loader maps between them.

### Zod schema extension (drop-in for `packages/core/src/identity/index.ts`)

```ts
import { CronExpressionParser } from "cron-parser"; // new dep

const modelTierSchema = z.enum(["fast", "balanced", "deep"]);
const llmProviderSchema = z.enum(["gemini", "anthropic", "openai", "ollama"]);

const cronStringSchema = z
  .string()
  .min(1)
  .refine(
    (s) => {
      try {
        CronExpressionParser.parse(s);
        return true;
      } catch {
        return false;
      }
    },
    { message: "wake_schedule.cron must be a valid cron expression" },
  );

const wakeScheduleSchema = z
  .object({
    cron: cronStringSchema.optional(),
    delayMs: z.number().int().nonnegative().optional(),
    intervalMs: z.number().int().nonnegative().optional(),
    events: z.array(z.string().min(1)).optional(),
  })
  .refine(
    (s) =>
      Boolean(s.cron || s.delayMs !== undefined || s.intervalMs !== undefined || s.events?.length),
    { message: "wake_schedule must declare at least one trigger" },
  );

const llmSchema = z.object({
  provider: llmProviderSchema,
  model: z.string().min(1).optional(),
});

const githubFilterSchema = z
  .object({
    state: z.enum(["open", "closed", "all"]).default("all"),
    since_days: z.number().int().positive().optional(),
    labels: z.array(z.string().min(1)).optional(),
  })
  .strict();

const githubScopeSchema = z
  .object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    filter: githubFilterSchema.default({ state: "all" }),
  })
  .strict();

const signalsSchema = z
  .object({
    sources: z
      .array(
        z.enum([
          "github-issue",
          "private-note",
          "inbox-message",
          "pipeline-item",
          "governance-round",
          "stall-alert",
        ]),
      )
      .default(["github-issue", "private-note", "inbox-message"]),
    github_scopes: z.array(githubScopeSchema).optional(),
  })
  .default({ sources: ["github-issue", "private-note", "inbox-message"] });

const branchCommitScopeSchema = z
  .object({
    repo: z.string().regex(/^[^/]+\/[^/]+$/, "repo must be owner/name"),
    paths: z.array(z.string().min(1)).min(1),
  })
  .strict();

const githubWriteScopesSchema = z
  .object({
    issue_comments: z.array(z.string().regex(/^[^/]+\/[^/]+$/)).default([]),
    branch_commits: z.array(branchCommitScopeSchema).default([]),
    labels: z.array(z.string()).default([]),
  })
  .default({ issue_comments: [], branch_commits: [], labels: [] });

const githubSchema = z
  .object({
    write_scopes: githubWriteScopesSchema,
  })
  .default({ write_scopes: { issue_comments: [], branch_commits: [], labels: [] } });

const promptSchema = z
  .object({
    ref: z.string().min(1).optional(),
  })
  .default({});

const budgetSchema = z
  .object({
    max_cost_micros: z.number().int().nonnegative().default(0),
    max_github_api_calls: z.number().int().nonnegative().default(0),
    on_breach: z.enum(["warn", "abort"]).default("warn"),
  })
  .default({ max_cost_micros: 0, max_github_api_calls: 0, on_breach: "warn" });

const secretsSchema = z
  .object({
    required: z.array(z.string().min(1)).default([]),
    optional: z.array(z.string().min(1)).default([]),
  })
  .default({ required: [], optional: [] });

export const roleFrontmatterSchema = z.object({
  agent_id: z.string().min(1),
  name: z.string().min(1),
  soul_file: z.string().min(1).optional(),

  // legacy compat
  model_tier: modelTierSchema,
  wake_schedule: wakeScheduleSchema.optional(),
  circle_memberships: z.array(z.string().min(1)).default([]),
  max_wall_clock_ms: z.number().int().positive().default(15_000),

  // new in ADR-0016
  llm: llmSchema.optional(), // schema-optional; daemon enforces for LLM agents
  signals: signalsSchema,
  github: githubSchema,
  prompt: promptSchema,
  budget: budgetSchema,
  secrets: secretsSchema,
});
```

**`llm` is schema-optional** so hello-world still parses. The daemon enforces presence at registration time only for agents whose executor requires LLM. Hello-world is exempt (subprocess executor, no LLM call).

### `RegisteredAgent` extension

Seven new fields on `RegisteredAgent` in `packages/core/src/daemon/index.ts`:

- `llm?: { provider, model? }` — undefined for non-LLM agents (hello-world)
- `signalScopes?: { sources, githubScopes? }` — absent → daemon default
- `githubWriteScopes: { issueComments, branchCommits, labels }` — defaults to empty (read-only)
- `promptPath?: string` — absolute path resolved from `prompt.ref` relative to role.md
- `budget: { maxCostMicros, maxGithubApiCalls, onBreach }` — feeds ADR-0011
- `secrets: { required, optional }` — unioned across agents at boot

Not added: raw frontmatter object, prompt body (lazy-read by runner), `signals.sources` enum-narrowing details (belong with the aggregator).

### `registeredAgentFromLoadedIdentity` changes

- New optional parameter: `options: { rolePath: string }` — needed because `prompt.ref` is relative to role.md. `IdentityLoader.load()` already knows this path; thread it through as a second return field.
- Snake_case → camelCase mapping for all new fields (e.g. `frontmatter.github.write_scopes.issue_comments` → `registered.githubWriteScopes.issueComments`).

### Defaults table

| Field                                   | Required?                                                 | Default if absent                                          |
| --------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------- |
| `llm.provider`                          | Schema-optional; required for LLM agents at register time | none                                                       |
| `llm.model`                             | Optional                                                  | resolved from `model_tier` via `models.yaml`               |
| `wake_schedule`                         | At least one trigger                                      | rejected if all of cron/delay/interval/events absent       |
| `signals.sources`                       | Optional                                                  | `["github-issue", "private-note", "inbox-message"]`        |
| `signals.github_scopes`                 | Optional                                                  | absent → daemon default                                    |
| `github.write_scopes.*`                 | Optional                                                  | empty arrays → read-only                                   |
| `prompt.ref`                            | Optional                                                  | undefined → no prompt file                                 |
| `budget.max_cost_micros`                | Optional                                                  | `0` (ADR-0011 interprets as "fall back to daemon ceiling") |
| `budget.max_github_api_calls`           | Optional                                                  | `0` (same fallback)                                        |
| `budget.on_breach`                      | Optional                                                  | `"warn"`                                                   |
| `secrets.required` / `secrets.optional` | Optional                                                  | `[]`                                                       |

### Validation edge cases

- `llm.provider` missing on an LLM agent → schema accepts; **daemon registration rejects** with `daemon.agent.register.failed` (code `missing-llm-provider`). Hello-world is exempt.
- `llm.provider` unknown enum → `FrontmatterInvalidError` at load.
- `llm.model` pinned but not in catalog → **runtime check at first call**, not load. Load-time validation would couple the identity loader to the pricing catalog.
- `wake_schedule.cron` parse failure → `cronStringSchema.refine(...)` rejects at load.
- `wake_schedule` empty → rejected by the refine.
- Overlapping `branch_commits.paths` between two agents → **out of scope for ADR-0016.** Filed as CF-role-A for Security #25.
- `secrets.required` keys the provider can't supply → caught by `Daemon.loadSecrets()` per ADR-0010; daemon unions per-agent `secrets.required` into the existing declaration before calling `loadSecrets()`.
- `github.write_scopes.branch_commits[].repo` not in `owner/name` form → `branchCommitScopeSchema` regex at load.

## Backwards compatibility

The hello-world agent's current frontmatter declares only the six original fields. After this ADR:

| New field             | Required?             | Hello-world result                                                            |
| --------------------- | --------------------- | ----------------------------------------------------------------------------- |
| `llm`                 | schema-optional       | absent → no LLM client → unchanged                                            |
| `signals`             | optional with default | default 3 sources → daemon aggregator → unchanged                             |
| `github.write_scopes` | optional with default | read-only → no writes attempted → unchanged                                   |
| `prompt.ref`          | optional              | absent → `promptPath = undefined` → subprocess executor unchanged             |
| `budget`              | optional with default | defaults to `{0,0,warn}` → ADR-0011 falls back to daemon ceilings → unchanged |
| `secrets`             | optional with default | `[]/[]` → unioned with declarations → unchanged                               |

Hello-world parses, registers, runs. **Zero edits required.**

## Tests (add to `identity.test.ts`)

~12 new specs: minimal hello-world loads, full Research #1 loads, `llm.provider` unknown enum rejected, `wake_schedule.cron` invalid rejected, `wake_schedule` with no triggers rejected, `github.write_scopes` defaults empty, `budget` defaults `{0,0,warn}`, `signals.sources` defaults to 3, `branch_commits.repo` not in owner/name rejected, `prompt.ref` resolves to absolute path, `secrets.required` unions across multiple agents at boot.

## Out of scope

- Agent lifecycle hooks (startup/shutdown/pre-wake/post-wake) — Phase 3+
- Inter-agent inbox convention governance — Phase 3+ (CF-signals-F)
- Hot-reload of role.md — Phase 3+
- Role inheritance / template composition
- Frontmatter migration tooling

## Carry-forwards

- **CF-role-A** — Cross-agent `branch_commits.paths` overlap lint at daemon boot. Owner: Security #25. Phase 3.
- **CF-role-B** — Pricing catalog ↔ `llm.model` load-time validation: re-evaluate after ADR-0015 ratifies. Owner: Performance #27.
- **CF-role-C** — `wake_schedule.events` enum ratification (which sources can trigger wakes). Phase 3, paired with governance plugin.
- **CF-role-D** — Prompt file format / frontmatter inside prompts (templates, variable interpolation). Phase 3+.
- **CF-role-E** — Daemon-level `signals.github_scopes` defaults interaction with per-role scopes. Architecture #23 + TypeScript #24.

## New runtime dependency

**`cron-parser`** — small, MIT, single-purpose. Notify-tier per Engineering Circle §5; 24h Security #25 window applies. DevOps #26 adds to `packages/core/package.json`.

## Consequences

### Positive

- Real agents are expressible without ad-hoc daemon-side config.
- Pluggable provider boundary honoured at the role level (ADR-0014 contract).
- Least-privilege GitHub writes enforced by declaration, not by trust.
- Hello-world keeps working — Phase 1 dual-run unaffected.
- Schema is the contract; daemon is a thin mapper. New agents add fields without daemon code changes.

### Negative

- New dep (`cron-parser`).
- `llm` schema-optional / runtime-required split is subtle. Documented in JSDoc and tested.
- Runtime validation of `llm.model` against the pricing catalog is deferred to first-call rather than load — fast-feedback at boot is sacrificed for decoupling.
- `RegisteredAgent` grows from ~7 to ~13 fields.

## Alternatives considered

- **Inline the wake prompt in frontmatter as a string field** — rejected; large prompts in YAML are read-hostile.
- **Make `llm.provider` strictly required at schema level** — rejected; breaks hello-world.
- **Put `signals.github_scopes` only at daemon level** — rejected; contradicts CF-signals-C.
- **Valibot / Arktype** — rejected; Zod is the codebase standard.
- **Flat `promptRef` instead of nested `prompt.ref`** — rejected; nesting leaves room for `prompt.systemRef`, `prompt.examplesRef` in Phase 3.

---

_Topology stays clean. The role file becomes the agent's declarative contract. The daemon stays a mapper. The boundary between identity (what the agent IS) and runtime config (what it's allowed to DO) is now explicit at every field._

_— Architecture Agent #23_
