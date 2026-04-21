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

export type LLMProvider = "gemini" | "anthropic" | "openai" | "ollama";

/** Harness-level default LLM config (ADR-0024). Individual agents may
 *  override via their `role.md` `llm:` frontmatter. The Spirit of the
 *  Murmuration inherits this default unless a Phase 2 `spirit.md` file
 *  overrides it. */
export interface HarnessLLMConfig {
  readonly provider: LLMProvider;
  readonly model: string | undefined;
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
     * round-trip to the LLM + any tool calls it emits. Larger
     * murmurations (many agents) need a bigger budget or the Spirit
     * runs out of steps before producing a final answer. Default 32.
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
  spirit: { maxSteps: 32 },
};

const isLLMProvider = (v: unknown): v is LLMProvider =>
  v === "gemini" || v === "anthropic" || v === "openai" || v === "ollama";

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

  const collabProvider = collab?.provider;
  const logLevel = logging?.level;
  const rawMaxSteps = spirit?.maxSteps;
  const maxSteps =
    typeof rawMaxSteps === "number" && Number.isFinite(rawMaxSteps) && rawMaxSteps >= 1
      ? Math.floor(rawMaxSteps)
      : DEFAULTS.spirit.maxSteps;

  return {
    llm: {
      provider: isLLMProvider(llm?.provider) ? llm.provider : DEFAULTS.llm.provider,
      model: typeof llm?.model === "string" ? llm.model : undefined,
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
    spirit: { maxSteps },
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
  };
}
