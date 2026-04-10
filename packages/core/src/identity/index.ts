/**
 * Identity loader — reads agent identity files from disk and assembles
 * them into the {@link IdentityChain} the executor receives.
 *
 * Spec §5 (identity model): inheritance is
 *
 *   murmuration/soul.md → agents/NN-name/soul.md → agents/NN-name/role.md
 *   + governance/circles/<id>.md (one per circle membership)
 *
 * The `role.md` file carries YAML frontmatter with operational config
 * (spec §5.3); this module parses and validates it via Zod, then reads
 * the narrative bodies of all four layer kinds into strings the
 * executor can hand to a subprocess.
 *
 * Closes CF-1 from the Engineering Lead #22 Phase 1A gate review
 * (https://github.com/murmurations-ai/murmurations-harness/issues/6).
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import cronParser from "cron-parser";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import {
  makeAgentId,
  makeCircleId,
  type AgentId,
  type AgentRoleFrontmatter,
  type CircleId,
  type IdentityChain,
  type IdentityLayer,
  type ModelTier,
} from "../execution/index.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Base class for identity-loader failures. */
export class IdentityLoaderError extends Error {
  public override readonly cause: unknown;
  public constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message);
    this.name = new.target.name;
    this.cause = options.cause;
  }
}

/** A required identity file was not present on disk. */
export class IdentityFileMissingError extends IdentityLoaderError {
  public readonly path: string;
  public constructor(path: string, options: { readonly cause?: unknown } = {}) {
    super(`identity file not found: ${path}`, options);
    this.path = path;
  }
}

/** Frontmatter validation failed (missing field, wrong type, etc). */
export class FrontmatterInvalidError extends IdentityLoaderError {
  public readonly path: string;
  public readonly issues: readonly string[];
  public constructor(
    path: string,
    issues: readonly string[],
    options: { readonly cause?: unknown } = {},
  ) {
    super(`invalid frontmatter in ${path}:\n  - ${issues.join("\n  - ")}`, options);
    this.path = path;
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// Frontmatter schema
// ---------------------------------------------------------------------------

const modelTierSchema = z.enum(["fast", "balanced", "deep"]);

/**
 * LLM provider enum — kept in sync with `@murmuration/llm`'s
 * `ProviderId`. Extended in ADR-0016 (Phase 2C role template).
 */
const llmProviderSchema = z.enum(["gemini", "anthropic", "openai", "ollama"]);

/**
 * Cron expression validator. Uses `cron-parser` at load time; any
 * malformed expression surfaces as a `FrontmatterInvalidError`.
 */
const cronStringSchema = z
  .string()
  .min(1)
  .refine(
    (s) => {
      try {
        cronParser.parseExpression(s);
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
    /** IANA timezone for the cron expression (e.g. "America/Vancouver").
     *  If absent, cron fires in UTC. Only meaningful when `cron` is set. */
    tz: z.string().min(1).optional(),
  })
  .refine(
    (s) =>
      s.cron !== undefined ||
      s.delayMs !== undefined ||
      s.intervalMs !== undefined ||
      (s.events !== undefined && s.events.length > 0),
    { message: "wake_schedule must declare at least one trigger" },
  );

// ---------------------------------------------------------------------------
// ADR-0016 extensions — llm, signals, github, prompt, budget, secrets
// ---------------------------------------------------------------------------

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

/**
 * Signal sources are open strings, not a closed enum. The harness
 * ships well-known sources (`github-issue`, `private-note`,
 * `inbox-message`, `pipeline-item`, `governance-round`, `stall-alert`)
 * with typed Signal variants, but operators can declare any string
 * (e.g. `"pr-review"`, `"slack-message"`, `"ci-failure"`) and the
 * aggregator will route them through the `custom` Signal variant.
 */
const signalsSchema = z
  .object({
    sources: z.array(z.string().min(1)).default(["github-issue", "private-note", "inbox-message"]),
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
    issues: z.array(z.string().regex(/^[^/]+\/[^/]+$/)).default([]), // CF-github-I
  })
  .default({ issue_comments: [], branch_commits: [], labels: [], issues: [] });

const githubSchema = z
  .object({
    write_scopes: githubWriteScopesSchema,
  })
  .default({ write_scopes: { issue_comments: [], branch_commits: [], labels: [], issues: [] } });

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

/** Shape expected from `role.md` YAML frontmatter. Spec §5.3 + ADR-0016. */
export const roleFrontmatterSchema = z.object({
  agent_id: z.string().min(1),
  name: z.string().min(1),
  soul_file: z.string().min(1).optional(),

  // legacy compat (Phase 1B)
  model_tier: modelTierSchema,
  wake_schedule: wakeScheduleSchema.optional(),
  circle_memberships: z.array(z.string().min(1)).default([]),
  max_wall_clock_ms: z.number().int().positive().default(15_000),

  // new in ADR-0016 (Phase 2C)
  llm: llmSchema.optional(), // schema-optional; daemon enforces for LLM agents
  signals: signalsSchema,
  github: githubSchema,
  prompt: promptSchema,
  budget: budgetSchema,
  secrets: secretsSchema,
});

/** Parsed, validated shape of a `role.md` frontmatter block. */
export type RoleFrontmatterParsed = z.infer<typeof roleFrontmatterSchema>;

// ---------------------------------------------------------------------------
// Markdown + frontmatter splitter
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/**
 * Split a markdown file into YAML frontmatter text and narrative body.
 * Returns `{ frontmatter: null, body }` if there is no frontmatter.
 */
export const splitFrontmatter = (
  source: string,
): { readonly frontmatter: string | null; readonly body: string } => {
  const match = FRONTMATTER_RE.exec(source);
  if (!match) {
    return { frontmatter: null, body: source };
  }
  return { frontmatter: match[1] ?? "", body: match[2] ?? "" };
};

// ---------------------------------------------------------------------------
// Loader configuration
// ---------------------------------------------------------------------------

/**
 * Where to find the identity files. Default layout:
 *
 *   <rootDir>/murmuration/soul.md
 *   <rootDir>/agents/<agentDir>/soul.md
 *   <rootDir>/agents/<agentDir>/role.md
 *   <rootDir>/governance/circles/<circleId>.md
 */
export interface IdentityLoaderConfig {
  /** Repository root (absolute or relative to process.cwd()). */
  readonly rootDir: string;
  /** Path to `murmuration/soul.md` relative to `rootDir`. Defaults to `"murmuration/soul.md"`. */
  readonly murmurationSoulPath?: string;
  /** Path to the agents directory relative to `rootDir`. Defaults to `"agents"`. */
  readonly agentsDir?: string;
  /** Path to the circles directory relative to `rootDir`. Defaults to `"governance/circles"`. */
  readonly circlesDir?: string;
}

// ---------------------------------------------------------------------------
// IdentityLoader
// ---------------------------------------------------------------------------

/** Result of loading one agent's full identity chain. */
export interface LoadedAgentIdentity {
  readonly agentId: AgentId;
  readonly chain: IdentityChain;
  readonly frontmatter: RoleFrontmatterParsed;
}

/**
 * Phase 1B identity loader. Reads the four layer files from disk,
 * parses and validates the role frontmatter, and returns an
 * {@link IdentityChain} ready to hand to {@link AgentExecutor.spawn}.
 *
 * Not cached: every `load()` call re-reads the files. The caller
 * (typically the daemon on boot, or a future identity-reload signal)
 * decides when to refresh.
 */
export class IdentityLoader {
  readonly #rootDir: string;
  readonly #murmurationSoulPath: string;
  readonly #agentsDir: string;
  readonly #circlesDir: string;

  public constructor(config: IdentityLoaderConfig) {
    this.#rootDir = resolve(config.rootDir);
    this.#murmurationSoulPath = config.murmurationSoulPath ?? "murmuration/soul.md";
    this.#agentsDir = config.agentsDir ?? "agents";
    this.#circlesDir = config.circlesDir ?? "governance/circles";
  }

  /**
   * Load one agent's identity. `agentDir` is the subdirectory name
   * under `agents/` (e.g. `"01-research"`, `"my-agent"`). The loader expects the
   * conventional files `soul.md` and `role.md` inside that directory.
   */
  public async load(agentDir: string): Promise<LoadedAgentIdentity> {
    const murmurationSoulPath = join(this.#rootDir, this.#murmurationSoulPath);
    const agentSoulPath = join(this.#rootDir, this.#agentsDir, agentDir, "soul.md");
    const agentRolePath = join(this.#rootDir, this.#agentsDir, agentDir, "role.md");

    const murmurationSoul = await readRequired(murmurationSoulPath);
    const agentSoul = await readRequired(agentSoulPath);
    const agentRole = await readRequired(agentRolePath);

    const { frontmatter: roleFrontmatterText, body: roleBody } = splitFrontmatter(agentRole);

    if (!roleFrontmatterText) {
      throw new FrontmatterInvalidError(agentRolePath, [
        "role.md must begin with a YAML frontmatter block (between `---` fences)",
      ]);
    }

    let frontmatterRaw: unknown;
    try {
      frontmatterRaw = parseYaml(roleFrontmatterText);
    } catch (cause) {
      throw new FrontmatterInvalidError(
        agentRolePath,
        ["YAML parse failed; see `cause` for details"],
        { cause },
      );
    }

    const parsed = roleFrontmatterSchema.safeParse(frontmatterRaw);
    if (!parsed.success) {
      const issues = parsed.error.issues.map(
        (issue) => `${issue.path.map((p) => String(p)).join(".")}: ${issue.message}`,
      );
      throw new FrontmatterInvalidError(agentRolePath, issues);
    }

    const frontmatter = parsed.data;
    const agentId = makeAgentId(frontmatter.agent_id);
    const circleMemberships: readonly CircleId[] = frontmatter.circle_memberships.map((c) =>
      makeCircleId(c),
    );

    // Load circle contexts. Missing circle files are a hard error —
    // the role declared the membership and we cannot silently ignore it.
    const circleLayers: IdentityLayer[] = [];
    for (const circleId of circleMemberships) {
      const circlePath = join(this.#rootDir, this.#circlesDir, `${circleId.value}.md`);
      const circleContent = await readRequired(circlePath);
      const { body: circleBody } = splitFrontmatter(circleContent);
      circleLayers.push({
        kind: "circle-context",
        circleId,
        content: circleBody,
        sourcePath: circlePath,
      });
    }

    const layers: IdentityLayer[] = [
      {
        kind: "murmuration-soul",
        content: murmurationSoul,
        sourcePath: murmurationSoulPath,
      },
      {
        kind: "agent-soul",
        agentId,
        content: agentSoul,
        sourcePath: agentSoulPath,
      },
      {
        kind: "agent-role",
        agentId,
        content: roleBody,
        sourcePath: agentRolePath,
      },
      ...circleLayers,
    ];

    const runtimeFrontmatter: AgentRoleFrontmatter = {
      agentId,
      name: frontmatter.name,
      modelTier: frontmatter.model_tier as ModelTier,
      circleMemberships,
    };

    const chain: IdentityChain = {
      agentId,
      frontmatter: runtimeFrontmatter,
      layers,
    };

    return { agentId, chain, frontmatter };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const readRequired = async (path: string): Promise<string> => {
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    if (isNotFoundError(cause)) {
      throw new IdentityFileMissingError(path, { cause });
    }
    throw new IdentityLoaderError(`failed to read ${path}`, { cause });
  }
};

const isNotFoundError = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) return false;
  const code = (value as { code?: unknown }).code;
  return code === "ENOENT";
};
