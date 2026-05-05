/**
 * Identity loader — reads agent identity files from disk and assembles
 * them into the {@link IdentityChain} the executor receives.
 *
 * Spec §5 (identity model): inheritance is
 *
 *   murmuration/soul.md → agents/NN-name/soul.md → agents/NN-name/role.md
 *   + governance/groups/<id>.md (one per group membership)
 *
 * The `role.md` file carries YAML frontmatter with operational config
 * (spec §5.3); this module parses and validates it via Zod, then reads
 * the narrative bodies of all four layer kinds into strings the
 * executor can hand to a subprocess.
 *
 * Closes CF-1 from the Engineering Lead #22 Phase 1A gate review
 * (https://github.com/murmurations-ai/murmurations-harness/issues/6).
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import cronParser from "cron-parser";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { accountabilitiesSchema } from "../done-criteria/index.js";
import {
  makeAgentId,
  makeGroupId,
  type AgentId,
  type AgentRoleFrontmatter,
  type GroupId,
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

/**
 * Convert a kebab-case directory slug into a human-readable name.
 * `engineering-lead-agent` → `"Engineering Lead Agent"`.
 * Used by {@link enrichRoleFrontmatter} when role.md doesn't declare
 * a `name` — per Engineering Standard #11 (Reasonable defaults).
 */
export const humanizeSlug = (slug: string): string =>
  slug
    .split(/[-_]/)
    .filter((s) => s.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

/**
 * Enrich a parsed role.md frontmatter with directory-derived and
 * harness-level defaults per Engineering Standard #11.
 *
 * Cascade rules (operator explicit > directory context > harness
 * default > schema default):
 *   - `agent_id` — defaults to the agent directory slug
 *   - `name` — defaults to the humanized directory slug
 *   - `model_tier` — defaults to `"balanced"`
 *   - `soul_file` — defaults to `"soul.md"` (relative to the agent dir)
 *   - `llm` — inherits from `harness.yaml`'s `llm:` when role.md
 *     omits it; preserves role.md's value when present.
 *
 * The returned value is intentionally pre-validation so the schema
 * still enforces type correctness on everything (including the
 * defaults). Exported for unit tests.
 */
export const enrichRoleFrontmatter = (
  raw: unknown,
  agentDir: string,
  roleDefaults?: {
    readonly llm?: {
      readonly provider: LLMProvider;
      readonly model?: string;
      readonly cli?: "claude" | "gemini" | "codex";
      readonly timeoutMs?: number;
      readonly permissionMode?: "restricted" | "operator-approved" | "trusted";
    };
  },
): Record<string, unknown> => {
  const base =
    typeof raw === "object" && raw !== null ? { ...(raw as Record<string, unknown>) } : {};

  // Coerce numeric values to strings before deciding whether to default.
  // A legacy `agent_id: 22` parses as a number; operators clearly meant
  // that as a string ID, so stringify rather than blocking or replacing.
  if (typeof base.agent_id === "number") base.agent_id = String(base.agent_id);
  if (typeof base.name === "number") base.name = String(base.name);

  if (typeof base.agent_id !== "string" || base.agent_id.length === 0) {
    base.agent_id = agentDir;
  }
  if (typeof base.name !== "string" || base.name.length === 0) {
    base.name = humanizeSlug(agentDir);
  }
  if (typeof base.model_tier !== "string" || base.model_tier.length === 0) {
    base.model_tier = "balanced";
  }
  if (typeof base.soul_file !== "string" || base.soul_file.length === 0) {
    base.soul_file = "soul.md";
  }
  // `llm` cascade: inherit harness-level default only when role.md
  // declared nothing. Explicit operator override always wins.
  if ((base.llm === undefined || base.llm === null) && roleDefaults?.llm !== undefined) {
    base.llm = {
      provider: roleDefaults.llm.provider,
      ...(roleDefaults.llm.model !== undefined ? { model: roleDefaults.llm.model } : {}),
      ...(roleDefaults.llm.cli !== undefined ? { cli: roleDefaults.llm.cli } : {}),
      ...(roleDefaults.llm.timeoutMs !== undefined
        ? { timeoutMs: roleDefaults.llm.timeoutMs }
        : {}),
      ...(roleDefaults.llm.permissionMode !== undefined
        ? { permissionMode: roleDefaults.llm.permissionMode }
        : {}),
    };
  }
  return base;
};

/**
 * Render a Zod issue with a remediation hint when the failure matches
 * a well-known pattern a new operator is likely to hit (numeric
 * `agent_id`, wrong `model_tier` spelling, etc.). Unknown patterns fall
 * back to Zod's default message — which is already reasonable.
 *
 * v0.5.0 Milestone 1 — error legibility. The goal is that a tester who
 * sees the error can fix it without opening Stack Overflow.
 */
const annotateZodIssue = (
  issue: z.core.$ZodIssue,
  agentDir: string,
  frontmatterRaw: unknown,
): string => {
  const fieldPath = issue.path.map((p) => String(p)).join(".");
  const base = `${fieldPath}: ${issue.message}`;

  const rawFm =
    typeof frontmatterRaw === "object" && frontmatterRaw !== null
      ? (frontmatterRaw as Record<string, unknown>)
      : {};

  // Pattern: agent_id is not a string (e.g. operators with a pre-v0.5
  // repo used `agent_id: 22` which YAML parses as a number).
  if (fieldPath === "agent_id" && issue.code === "invalid_type") {
    const rawAgentId = rawFm.agent_id;
    const displayValue =
      typeof rawAgentId === "string" || typeof rawAgentId === "number"
        ? String(rawAgentId)
        : "<value>";
    return `${base} — change \`agent_id: ${displayValue}\` to \`agent_id: "${agentDir}"\` (quoted string matching this agent's directory name)`;
  }

  // Pattern: model_tier misspelled (common: "medium", "small", "large").
  if (fieldPath === "model_tier" && issue.code === "invalid_value") {
    return `${base} — valid values: "fast", "balanced", "deep"`;
  }

  // Pattern: llm.provider misspelled or capitalized.
  if (fieldPath === "llm.provider" && issue.code === "invalid_value") {
    return `${base} — valid providers: "gemini", "anthropic", "openai", "ollama"`;
  }

  // Pattern: missing required top-level field.
  if (issue.code === "invalid_type" && "received" in issue && issue.received === "undefined") {
    return `${base} — add this field to ${agentDir}/role.md frontmatter`;
  }

  return base;
};

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
 * Valid shape for an agent or group identifier. Must not contain
 * path-separators or traversal sequences — these values are joined
 * into filesystem paths (`runs/<id>/`, `.murmuration/logs/wake-<id>.log`,
 * governance persist dirs) and would otherwise enable an attacker-
 * controlled `role.md` to escape the murmuration root. Matches the
 * regex the HTTP handler already uses at its boundary (http.ts:136).
 *
 * Rules:
 *   - Must start with a letter or digit
 *   - Subsequent chars: letters, digits, `.`, `_`, `-`
 *   - Length 1..64
 */
export const IDENTIFIER_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const IDENTIFIER_MAX_LENGTH = 64;
const identifierSchema = z.string().min(1).max(IDENTIFIER_MAX_LENGTH).regex(IDENTIFIER_RE, {
  message:
    "identifier must start with a letter or digit and contain only letters, digits, `.`, `_`, or `-` (max 64 chars)",
});

/**
 * LLM provider enum — kept in sync with `@murmurations-ai/llm`'s
 * `ProviderId`. Extended in ADR-0016 (Phase 2C role template).
 */
// ADR-0034 added "subscription-cli" — routes to the subprocess provider family
// (claude -p / gemini -p / codex exec) instead of the registry's API providers.
const llmProviderSchema = z.enum(["gemini", "anthropic", "openai", "ollama", "subscription-cli"]);

/** LLM provider enum surface used by harness-level defaults. Kept in
 *  sync with `llmProviderSchema` above. */
export type LLMProvider = z.infer<typeof llmProviderSchema>;

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
  // ADR-0034: subscription-CLI provider family. Required when
  // provider: "subscription-cli"; ignored otherwise. Schema admits
  // the field as optional so other providers don't have to know about it.
  cli: z.enum(["claude", "gemini", "codex"]).optional(),
  timeoutMs: z.number().int().positive().optional(),
  // ADR-0036: vendor-native CLI execution authority. Defaults are applied
  // by the subscription-cli factory; schema only admits the explicit field.
  permissionMode: z.enum(["restricted", "operator-approved", "trusted"]).optional(),
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

// ADR-0020 Phase 3: MCP tool declarations
const mcpServerSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
});

const toolsSchema = z
  .object({
    mcp: z.array(mcpServerSchema).default([]),
    cli: z.array(z.string().min(1)).default([]),
  })
  .default({ mcp: [], cli: [] });

/** Plugin declarations — ADR-0023 extensions the agent wants to pull from.
 *  Today these are loaded daemon-wide; this field is declarative so each
 *  agent's plugin dependencies are visible in its role.md. Per-agent
 *  plugin gating is a future enhancement. */
const pluginsSchema = z
  .array(
    z
      .object({
        provider: z.string().min(1),
      })
      .strict(),
  )
  .default([]);

/** Shape expected from `role.md` YAML frontmatter. Spec §5.3 + ADR-0016. */
export const roleFrontmatterSchema = z.object({
  agent_id: identifierSchema,
  name: z.string().min(1),
  soul_file: z.string().min(1).optional(),

  // legacy compat (Phase 1B)
  model_tier: modelTierSchema,
  wake_schedule: wakeScheduleSchema.optional(),
  group_memberships: z.array(identifierSchema).default([]),
  // Default 2 minutes. A single LLM wake with a few tool calls takes
  // 30–90s on Sonnet/GPT-class models; the prior 15s default killed
  // realistic wakes mid-thought. Agents that need longer (research
  // wakes that walk a full repo, multi-step reasoning) override
  // explicitly — see examples/research-agent (10 min).
  max_wall_clock_ms: z.number().int().positive().default(120_000),

  // new in ADR-0016 (Phase 2C)
  llm: llmSchema.optional(), // schema-optional; daemon enforces for LLM agents
  signals: signalsSchema,
  github: githubSchema,
  prompt: promptSchema,
  budget: budgetSchema,
  secrets: secretsSchema,

  // ADR-0020 Phase 3: tool declarations (per-agent MCP + CLI)
  tools: toolsSchema,

  // ADR-0023: plugin declarations — which OpenClaw-compatible plugins
  // the agent relies on. Declarative today (plugins load daemon-wide);
  // per-agent gating is a future enhancement.
  plugins: pluginsSchema,

  // ADR-0042: accountabilities with done_when blocks (v0.7.0). Optional
  // so existing role.md files validate unchanged; agents that don't
  // declare accountabilities fall back to legacy self-reported
  // EFFECTIVENESS reflection without machine-checked done conditions.
  accountabilities: accountabilitiesSchema,
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
 *   <rootDir>/governance/groups/<groupId>.md
 */
export interface IdentityLoaderConfig {
  /** Repository root (absolute or relative to process.cwd()). */
  readonly rootDir: string;
  /** Path to `murmuration/soul.md` relative to `rootDir`. Defaults to `"murmuration/soul.md"`. */
  readonly murmurationSoulPath?: string;
  /** Path to the agents directory relative to `rootDir`. Defaults to `"agents"`. */
  readonly agentsDir?: string;
  /** Path to the groups directory relative to `rootDir`. Defaults to `"governance/groups"`. */
  readonly groupsDir?: string;
  /**
   * When true (ADR-0027), {@link IdentityLoader.load} will synthesize a
   * generic fallback identity when `role.md` or `soul.md` are missing
   * or `role.md` lacks YAML frontmatter. Use during iterative
   * scaffolding so operators can create empty agent folders and fill
   * them in later without crashing boot.
   *
   * Defaults to `false` — production boot paths (daemon, CLI) set it
   * to `true` and pass an `onFallback` callback to surface warnings.
   */
  readonly fallbackOnMissing?: boolean;
  /**
   * Called when {@link load} returns a fallback identity. The callback
   * receives the agent dir and the reason for falling back so the
   * host process can log a visible warning (`daemon.agent.fallback`).
   */
  readonly onFallback?: (agentDir: string, reason: IdentityFallbackReason) => void;
  /**
   * Harness-level defaults that cascade into each agent's role.md
   * frontmatter when the agent didn't declare them locally. Per
   * Engineering Standard #11 (Reasonable defaults), any field absent
   * from role.md should inherit from this block rather than blocking
   * boot. Today the only cascading field is `llm` — if role.md has no
   * `llm:` block, the agent inherits the harness-level provider.
   *
   * Callers (boot.ts, group-wake.ts) load `harness.yaml` and pass its
   * `llm:` block here. Undefined means "no cascade" (legacy behavior).
   */
  readonly roleDefaults?: {
    readonly llm?: {
      readonly provider: LLMProvider;
      readonly model?: string;
      readonly cli?: "claude" | "gemini" | "codex";
      readonly timeoutMs?: number;
      readonly permissionMode?: "restricted" | "operator-approved" | "trusted";
    };
  };
}

/** Why a fallback identity was synthesized for an agent directory. */
export interface IdentityFallbackReason {
  readonly missingFiles: readonly string[];
  readonly reason: "missing-files" | "missing-frontmatter" | "invalid-frontmatter";
  readonly detail?: string;
}

// ---------------------------------------------------------------------------
// IdentityLoader
// ---------------------------------------------------------------------------

/** Result of loading one agent's full identity chain. */
export interface LoadedAgentIdentity {
  readonly agentId: AgentId;
  readonly chain: IdentityChain;
  readonly frontmatter: RoleFrontmatterParsed;
  /**
   * Populated when the loader synthesized a generic identity because
   * the agent's on-disk files were missing or malformed (ADR-0027).
   * `undefined` for fully-defined agents.
   */
  readonly fallback?: IdentityFallbackReason;
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
  readonly #groupsDir: string;
  readonly #fallbackOnMissing: boolean;
  readonly #onFallback: ((agentDir: string, reason: IdentityFallbackReason) => void) | undefined;
  readonly #roleDefaults: IdentityLoaderConfig["roleDefaults"];

  public constructor(config: IdentityLoaderConfig) {
    this.#rootDir = resolve(config.rootDir);
    this.#murmurationSoulPath = config.murmurationSoulPath ?? "murmuration/soul.md";
    this.#agentsDir = config.agentsDir ?? "agents";
    this.#groupsDir = config.groupsDir ?? "governance/groups";
    this.#fallbackOnMissing = config.fallbackOnMissing ?? false;
    this.#onFallback = config.onFallback;
    this.#roleDefaults = config.roleDefaults;
  }

  /**
   * Discover all agent directories under `<rootDir>/agents/` that
   * contain a `role.md` file. Returns the directory names sorted
   * lexicographically (so `01-research` comes before `02-content`).
   * Directories without a `role.md` are silently skipped — they may
   * be scaffolding, templates, or WIP that isn't ready to load.
   */
  public async discover(): Promise<readonly string[]> {
    const agentsRoot = join(this.#rootDir, this.#agentsDir);
    let entries: string[];
    try {
      entries = await readdir(agentsRoot);
    } catch {
      return [];
    }
    const results: string[] = [];
    for (const entry of entries.sort()) {
      try {
        const entryPath = join(agentsRoot, entry);
        const info = await stat(entryPath);
        if (!info.isDirectory()) continue;
        const rolePath = join(entryPath, "role.md");
        await stat(rolePath); // throws ENOENT if missing
        results.push(entry);
      } catch {
        // not a valid agent directory — skip
      }
    }
    return results;
  }

  /**
   * Resolve the default `soul.md` content for an agent that doesn't
   * have one on disk. Prefers the operator-provided template at
   * `<root>/murmuration/default-agent/soul.md`; falls back to the
   * built-in when absent.
   */
  async #resolveDefaultAgentSoul(agentDir: string): Promise<string> {
    const templatePath = join(this.#rootDir, DEFAULT_AGENT_SOUL_TEMPLATE);
    try {
      const raw = await readFile(templatePath, "utf8");
      return interpolateTemplate(raw, agentDir);
    } catch {
      return interpolateTemplate(BUILTIN_AGENT_SOUL, agentDir);
    }
  }

  /**
   * Resolve the default `role.md` content for an agent that doesn't
   * have one on disk. Prefers the operator-provided template at
   * `<root>/murmuration/default-agent/role.md`; falls back to the
   * built-in when absent.
   */
  async #resolveDefaultAgentRole(agentDir: string): Promise<string> {
    const templatePath = join(this.#rootDir, DEFAULT_AGENT_ROLE_TEMPLATE);
    try {
      const raw = await readFile(templatePath, "utf8");
      return interpolateTemplate(raw, agentDir);
    } catch {
      return buildBuiltinRoleDocument(agentDir);
    }
  }

  /**
   * Load one agent's identity. `agentDir` is the subdirectory name
   * under `agents/` (e.g. `"01-research"`, `"my-agent"`). The loader expects the
   * conventional files `soul.md` and `role.md` inside that directory.
   *
   * When the loader is constructed with `fallbackOnMissing: true`
   * (ADR-0027), a generic fallback identity is synthesized in place of
   * throwing when `role.md` / `soul.md` are missing or `role.md`
   * lacks YAML frontmatter. The returned `LoadedAgentIdentity.fallback`
   * field is populated so callers can surface a visible warning.
   */
  public async load(agentDir: string): Promise<LoadedAgentIdentity> {
    const murmurationSoulPath = join(this.#rootDir, this.#murmurationSoulPath);
    const agentSoulPath = join(this.#rootDir, this.#agentsDir, agentDir, "soul.md");
    const agentRolePath = join(this.#rootDir, this.#agentsDir, agentDir, "role.md");

    // Murmuration soul is a hard requirement — the fallback path is
    // per-agent, not murmuration-wide.
    const murmurationSoul = await readRequired(murmurationSoulPath);

    const missingFiles: string[] = [];
    let agentSoul: string;
    let agentRole: string;

    try {
      agentSoul = await readRequired(agentSoulPath);
    } catch (err) {
      if (!(err instanceof IdentityFileMissingError) || !this.#fallbackOnMissing) throw err;
      missingFiles.push("soul.md");
      agentSoul = await this.#resolveDefaultAgentSoul(agentDir);
    }

    try {
      agentRole = await readRequired(agentRolePath);
    } catch (err) {
      if (!(err instanceof IdentityFileMissingError) || !this.#fallbackOnMissing) throw err;
      missingFiles.push("role.md");
      agentRole = await this.#resolveDefaultAgentRole(agentDir);
    }

    const { frontmatter: roleFrontmatterText } = splitFrontmatter(agentRole);

    let fallbackReason: IdentityFallbackReason | undefined;

    if (!roleFrontmatterText) {
      if (!this.#fallbackOnMissing) {
        throw new FrontmatterInvalidError(agentRolePath, [
          "role.md must begin with a YAML frontmatter block (between `---` fences)",
        ]);
      }
      fallbackReason = {
        reason: "missing-frontmatter",
        missingFiles,
      };
      agentRole = await this.#resolveDefaultAgentRole(agentDir);
    }

    const parsedRole = splitFrontmatter(agentRole);
    const effectiveFrontmatterText = parsedRole.frontmatter ?? "";
    const effectiveRoleBody = parsedRole.body;

    let frontmatterRaw: unknown;
    try {
      frontmatterRaw = parseYaml(effectiveFrontmatterText);
    } catch (cause) {
      if (!this.#fallbackOnMissing) {
        throw new FrontmatterInvalidError(
          agentRolePath,
          ["YAML parse failed; see `cause` for details"],
          { cause },
        );
      }
      fallbackReason = {
        reason: "invalid-frontmatter",
        missingFiles,
        detail: "YAML parse failed",
      };
      frontmatterRaw = parseYaml(
        splitFrontmatter(await this.#resolveDefaultAgentRole(agentDir)).frontmatter ?? "",
      );
    }

    // Engineering Standard #11 — fill in reasonable defaults BEFORE
    // schema validation. Explicit operator values always win; missing
    // fields get directory-derived (agent_id, name) or harness-level
    // (llm) fallbacks.
    frontmatterRaw = enrichRoleFrontmatter(frontmatterRaw, agentDir, this.#roleDefaults);

    const parsed = roleFrontmatterSchema.safeParse(frontmatterRaw);
    if (!parsed.success) {
      if (!this.#fallbackOnMissing) {
        const issues = parsed.error.issues.map((issue) =>
          annotateZodIssue(issue, agentDir, frontmatterRaw),
        );
        throw new FrontmatterInvalidError(agentRolePath, issues);
      }
      fallbackReason = {
        reason: "invalid-frontmatter",
        missingFiles,
        detail: parsed.error.issues.map((i) => i.message).join("; "),
      };
      frontmatterRaw = enrichRoleFrontmatter(
        parseYaml(
          splitFrontmatter(await this.#resolveDefaultAgentRole(agentDir)).frontmatter ?? "",
        ),
        agentDir,
        this.#roleDefaults,
      );
    }

    if (missingFiles.length > 0 && !fallbackReason) {
      fallbackReason = {
        reason: "missing-files",
        missingFiles: [...missingFiles],
      };
    }

    // Re-parse after any fallback substitution so downstream types are
    // consistent whether we fell back or not.
    const finalParsed = roleFrontmatterSchema.parse(frontmatterRaw);
    const frontmatter = finalParsed;
    const effectiveRole = fallbackReason
      ? await this.#resolveDefaultAgentRole(agentDir)
      : agentRole;
    const finalRoleBody = fallbackReason ? splitFrontmatter(effectiveRole).body : effectiveRoleBody;

    // Emit the warning callback so the host process can log a visible
    // WARN (ADR-0027 §Warnings).
    if (fallbackReason && this.#onFallback) {
      this.#onFallback(agentDir, fallbackReason);
    }
    const agentId = makeAgentId(frontmatter.agent_id);
    const groupMemberships: readonly GroupId[] = frontmatter.group_memberships.map((c) =>
      makeGroupId(c),
    );

    // Load group contexts. Missing group files are a hard error —
    // the role declared the membership and we cannot silently ignore it.
    const groupLayers: IdentityLayer[] = [];
    for (const groupId of groupMemberships) {
      const groupPath = join(this.#rootDir, this.#groupsDir, `${groupId.value}.md`);
      const groupContent = await readRequired(groupPath);
      const { body: groupBody } = splitFrontmatter(groupContent);
      groupLayers.push({
        kind: "group-context",
        groupId,
        content: groupBody,
        sourcePath: groupPath,
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
        content: finalRoleBody,
        sourcePath: agentRolePath,
      },
      ...groupLayers,
    ];

    const runtimeFrontmatter: AgentRoleFrontmatter = {
      agentId,
      name: frontmatter.name,
      modelTier: frontmatter.model_tier as ModelTier,
      groupMemberships,
    };

    const chain: IdentityChain = {
      agentId,
      frontmatter: runtimeFrontmatter,
      layers,
    };

    return {
      agentId,
      chain,
      frontmatter,
      ...(fallbackReason ? { fallback: fallbackReason } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// Fallback identity templates (ADR-0027)
//
// Two layers:
//   1. Operator-provided templates at
//      `<rootDir>/murmuration/default-agent/{soul.md,role.md}` — read at
//      load time so operators can edit the defaults without forking.
//      Any token `{{agent_id}}` in the template is replaced with the
//      actual agent directory name.
//   2. Built-in defaults (below) — used when the operator hasn't
//      provided templates. Designed to be *functional* rather than
//      inert: the agent can participate in governance (via the per-agent
//      plugin auto-include for local collaboration, v0.4.3) and acts
//      conservatively when given a wake.
// ---------------------------------------------------------------------------

const BUILTIN_AGENT_SOUL = `# Generic Helper — Soul

I am a generic helper agent. My specific character has not yet been
defined by Source. Until it is, I act with these principles:

- I surface ambiguity rather than invent intent. When a directive or
  signal is unclear, I say so and ask what Source actually wants.
- I prefer small, reversible actions to bold moves. Source has not
  yet told me what is and isn't safe; I err toward cautious.
- I acknowledge my limits. If I lack a tool, a skill, or context to do
  a task well, I report that honestly rather than fabricate output.

Source can replace this soul by editing \`agents/{{agent_id}}/soul.md\`
directly, or by editing the shared template at
\`murmuration/default-agent/soul.md\`.
`;

/** Minimal but functional `role.md`. Declares no plugins (empty
 *  `plugins: []` still gets backward-compat full tools; local-gov
 *  auto-includes the files plugin per v0.4.3). Budget is modest so a
 *  fallback agent cannot spend unboundedly. */
const buildBuiltinRoleDocument = (agentDir: string): string =>
  [
    "---",
    `agent_id: "${agentDir}"`,
    `name: "Generic Helper (${agentDir})"`,
    `model_tier: "balanced"`,
    `max_wall_clock_ms: 120000`,
    "",
    "group_memberships: []",
    "",
    "signals:",
    "  sources:",
    '    - "github-issue"',
    '    - "private-note"',
    "",
    "github:",
    "  write_scopes:",
    "    issue_comments: []",
    "    branch_commits: []",
    "    labels: []",
    "    issues: []",
    "",
    "budget:",
    "  max_cost_micros: 50000",
    "  max_github_api_calls: 5",
    '  on_breach: "warn"',
    "",
    "secrets:",
    "  required: []",
    '  optional: ["GITHUB_TOKEN"]',
    "",
    "plugins: []",
    "---",
    "",
    `# Generic Helper — Role`,
    "",
    "## Accountabilities",
    "",
    "I respond to Source directives and signals. When a directive arrives,",
    "I acknowledge it, identify what I have the tools to do, and either",
    "attempt the task or report honestly why I can't.",
    "",
    "## Decision tiers",
    "",
    "- **Autonomous:** read files, query signals, post reports, close",
    "  tensions I've filed myself.",
    "- **Notify:** anything that edits shared state (agent souls, governance",
    "  items, other agents' files) — I describe what I'd do and wait.",
    "- **Consent:** changes to the murmuration soul, bright lines, or",
    "  governance model require a consent round.",
    "",
    "Source can replace this role by editing `agents/" + agentDir + "/role.md`",
    "directly, or by editing the shared template at",
    "`murmuration/default-agent/role.md`.",
    "",
  ].join("\n");

/** Interpolate the agent-dir name into any `{{agent_id}}` tokens the
 *  operator left in their template. Keeps the template reusable across
 *  agent directories. */
const interpolateTemplate = (template: string, agentDir: string): string =>
  template.replace(/\{\{\s*agent_id\s*\}\}/g, agentDir);

/** Operator-provided template path for the shared default agent. Used
 *  ahead of the built-in default when it exists. */
const DEFAULT_AGENT_SOUL_TEMPLATE = "murmuration/default-agent/soul.md";
const DEFAULT_AGENT_ROLE_TEMPLATE = "murmuration/default-agent/role.md";

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
