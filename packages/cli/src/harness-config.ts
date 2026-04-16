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

export interface HarnessConfig {
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
}

const DEFAULTS: HarnessConfig = {
  governance: { plugin: undefined },
  collaboration: { provider: "github", repo: undefined },
  products: [],
  logging: { level: "info" },
};

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

  const gov = raw.governance as Record<string, unknown> | undefined;
  const collab = raw.collaboration as Record<string, unknown> | undefined;
  const products = raw.products as { name: string; repo: string }[] | undefined;
  const logging = raw.logging as Record<string, unknown> | undefined;

  const collabProvider = collab?.provider;
  const logLevel = logging?.level;

  return {
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
  };
}
