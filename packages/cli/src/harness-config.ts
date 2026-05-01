/**
 * Harness configuration file loader — murmuration/harness.yaml
 *
 * Settings that rarely change live in the config file. CLI flags
 * override config file values when set. Load order:
 *   defaults → config file → CLI flags → environment variables
 *
 * ADR-0021: collaboration provider config.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

// ---------------------------------------------------------------------------
// Config shape
// ---------------------------------------------------------------------------

export type LLMProvider = "gemini" | "anthropic" | "openai" | "ollama" | "subscription-cli";

export type SubscriptionCli = "claude" | "codex" | "gemini";

/** Harness-level default LLM config (ADR-0024). Individual agents may
 *  override via their `role.md` `llm:` frontmatter. The Spirit of the
 *  Murmuration inherits this default unless a Phase 2 `spirit.md` file
 *  overrides it. */
export interface HarnessLLMConfig {
  readonly provider: LLMProvider;
  readonly model: string | undefined;
  /** Set when provider === "subscription-cli". */
  readonly cli?: SubscriptionCli;
}

export interface HarnessConfig {
  readonly llm: HarnessLLMConfig;
  readonly governance: {
    readonly plugin: string | undefined;
  };
  readonly collaboration: {
    readonly provider: "github" | "local";
    readonly repo: string | undefined;
  };
  readonly products: readonly {
    readonly name: string;
    readonly repo: string;
  }[];
  readonly logging: {
    readonly level: "debug" | "info" | "warn" | "error";
  };
  /** Spirit-specific knobs. Defaults apply when omitted. */
  readonly spirit: {
    /**
     * Maximum tool-use steps in a single Spirit turn. Each step is one
     * round-trip to the LLM + any tool calls it emits. Default 256
     * (effectively unlimited; raised from earlier tighter values after
     * tester work showed truncation mid-workflow).
     */
    readonly maxSteps: number;
  };
  /** Agent runtime knobs. Applied to every agent's wake unless overridden
   *  per-agent in role.md. */
  readonly agent: {
    /**
     * Maximum tool-use steps in a single agent wake. Default 256
     * (effectively unlimited). Wall-clock and cost budgets are the
     * real circuit-breakers; step-count is belt-and-suspenders.
     */
    readonly maxSteps: number;
  };
}

const DEFAULTS: HarnessConfig = {
  llm: { provider: "gemini", model: undefined },
  governance: { plugin: undefined },
  collaboration: { provider: "github", repo: undefined },
  products: [],
  logging: { level: "info" },
  spirit: { maxSteps: 256 },
  agent: { maxSteps: 256 },
};

const isLLMProvider = (v: unknown): v is LLMProvider =>
  v === "gemini" ||
  v === "anthropic" ||
  v === "openai" ||
  v === "ollama" ||
  v === "subscription-cli";

const isSubscriptionCli = (v: unknown): v is SubscriptionCli =>
  v === "claude" || v === "codex" || v === "gemini";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load harness config from `{rootDir}/murmuration/harness.yaml`.
 * Returns defaults for any missing fields. Never throws — returns
 * defaults if the file doesn't exist or is unparseable.
 */
export async function loadHarnessConfig(rootDir: string): Promise<HarnessConfig> {
  const filePath = resolve(rootDir, "murmuration", "harness.yaml");

  let raw: Record<string, unknown>;
  try {
    const content = await readFile(filePath, "utf8");
    const parsed: unknown = parseYaml(content);
    if (!parsed || typeof parsed !== "object") return DEFAULTS;
    raw = parsed as Record<string, unknown>;
  } catch {
    return DEFAULTS;
  }

  const llm = raw.llm as Record<string, unknown> | undefined;
  const gov = raw.governance as Record<string, unknown> | undefined;
  const collab = raw.collaboration as Record<string, unknown> | undefined;
  const products = raw.products as { name: string; repo: string }[] | undefined;
  const logging = raw.logging as Record<string, unknown> | undefined;
  const spirit = raw.spirit as Record<string, unknown> | undefined;
  const agent = raw.agent as Record<string, unknown> | undefined;

  const collabProvider = collab?.provider;
  const logLevel = logging?.level;
  const rawSpiritMaxSteps = spirit?.maxSteps;
  const spiritMaxSteps =
    typeof rawSpiritMaxSteps === "number" &&
    Number.isFinite(rawSpiritMaxSteps) &&
    rawSpiritMaxSteps >= 1
      ? Math.floor(rawSpiritMaxSteps)
      : DEFAULTS.spirit.maxSteps;
  const rawAgentMaxSteps = agent?.maxSteps;
  const agentMaxSteps =
    typeof rawAgentMaxSteps === "number" &&
    Number.isFinite(rawAgentMaxSteps) &&
    rawAgentMaxSteps >= 1
      ? Math.floor(rawAgentMaxSteps)
      : DEFAULTS.agent.maxSteps;

  return {
    llm: {
      provider: isLLMProvider(llm?.provider) ? llm.provider : DEFAULTS.llm.provider,
      model: typeof llm?.model === "string" ? llm.model : undefined,
      ...(isSubscriptionCli(llm?.cli) ? { cli: llm.cli } : {}),
    },
    governance: {
      plugin: typeof gov?.plugin === "string" ? gov.plugin : undefined,
    },
    collaboration: {
      provider:
        collabProvider === "local" || collabProvider === "github"
          ? collabProvider
          : DEFAULTS.collaboration.provider,
      repo: typeof collab?.repo === "string" ? collab.repo : undefined,
    },
    products: Array.isArray(products)
      ? products
          .filter(
            (p): p is { name: string; repo: string } =>
              typeof p === "object" &&
              typeof (p as Record<string, unknown>).name === "string" &&
              typeof (p as Record<string, unknown>).repo === "string",
          )
          .map((p) => ({ name: p.name, repo: p.repo }))
      : [],
    logging: {
      level:
        logLevel === "debug" || logLevel === "info" || logLevel === "warn" || logLevel === "error"
          ? logLevel
          : DEFAULTS.logging.level,
    },
    spirit: { maxSteps: spiritMaxSteps },
    agent: { maxSteps: agentMaxSteps },
  };
}

/**
 * Merge CLI flags over config file values. CLI flags take precedence
 * when explicitly set (not undefined).
 */
export function mergeWithCliFlags(
  config: HarnessConfig,
  flags: {
    readonly governancePath?: string;
    readonly collaboration?: "github" | "local";
    readonly logLevel?: "debug" | "info" | "warn" | "error";
  },
): HarnessConfig {
  return {
    llm: config.llm,
    governance: {
      plugin: flags.governancePath ?? config.governance.plugin,
    },
    collaboration: {
      provider: flags.collaboration ?? config.collaboration.provider,
      repo: config.collaboration.repo,
    },
    products: config.products,
    logging: {
      level: flags.logLevel ?? config.logging.level,
    },
    spirit: config.spirit,
    agent: config.agent,
  };
}
