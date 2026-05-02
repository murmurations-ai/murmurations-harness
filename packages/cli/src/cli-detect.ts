/**
 * CLI auto-detection for `murmuration init`.
 *
 * Probes the operator's PATH for the three subscription-CLI tools
 * (claude, codex, gemini) and reports presence + version. The detected
 * set drives the init interview's recommended-default LLM choice:
 * a subscription CLI lets a new operator skip API-key capture entirely
 * and start their first murmuration on $0 marginal cost.
 *
 * Detection is presence-only — it does NOT confirm the CLI is logged in.
 * Auth state surfaces at first wake via the subprocess adapter's stderr
 * scan (see ADR-0034 BU-2). False positives at boot are cheap; false
 * negatives would block a working operator.
 */

import { spawnSync } from "node:child_process";

export type SubscriptionCli = "claude" | "codex" | "gemini";

export interface CliPresence {
  readonly cli: SubscriptionCli;
  readonly available: boolean;
  /** Trimmed first-line of `<cli> --version` stdout, or null if unavailable. */
  readonly version: string | null;
  /** Default model to suggest when this CLI is selected. */
  readonly defaultModel: string;
  /**
   * Provider-id surfaced in the harness for cost attribution and the
   * subprocess adapter routing key.
   */
  readonly providerId: "claude-cli" | "codex-cli" | "gemini-cli";
}

export interface CliDetectionResult {
  readonly clis: readonly CliPresence[];
  /** True iff at least one subscription CLI is installed. */
  readonly anyAvailable: boolean;
  /**
   * Recommended default CLI: the first available one in preference order
   * (claude → codex → gemini). Null when nothing is installed.
   */
  readonly recommended: CliPresence | null;
}

interface CliConfig {
  readonly cli: SubscriptionCli;
  readonly providerId: CliPresence["providerId"];
  readonly defaultModel: string;
}

/**
 * Default models per CLI. Picked to give a sensible "just works" start:
 *
 * - claude → balanced Sonnet (Opus is heavier; Haiku is cheaper but
 *   weaker; Sonnet is the documented daily-driver default).
 * - codex → gpt-5.5 (the current deep-thinking default; codex CLI's
 *   own config UI nudges users to it).
 * - gemini → flash (the fast tier; flash-lite is cheaper but weaker on
 *   the kind of multi-step tool use the harness drives).
 *
 * Operators override via role.md `llm.model`.
 */
const CLI_CONFIGS: readonly CliConfig[] = [
  { cli: "claude", providerId: "claude-cli", defaultModel: "claude-sonnet-4-6" },
  { cli: "codex", providerId: "codex-cli", defaultModel: "gpt-5.5" },
  { cli: "gemini", providerId: "gemini-cli", defaultModel: "gemini-2.5-flash" },
];

const probe = (cli: SubscriptionCli): { available: boolean; version: string | null } => {
  try {
    const result = spawnSync(cli, ["--version"], { encoding: "utf8", timeout: 5000 });
    if (result.error || result.status !== 0) {
      return { available: false, version: null };
    }
    const firstLine = result.stdout.split("\n")[0]?.trim() ?? "";
    return { available: true, version: firstLine.length > 0 ? firstLine : null };
  } catch {
    return { available: false, version: null };
  }
};

export const detectInstalledClis = (): CliDetectionResult => {
  const clis: CliPresence[] = CLI_CONFIGS.map((cfg) => {
    const { available, version } = probe(cfg.cli);
    return {
      cli: cfg.cli,
      available,
      version,
      defaultModel: cfg.defaultModel,
      providerId: cfg.providerId,
    };
  });

  const recommended = clis.find((c) => c.available) ?? null;
  return {
    clis,
    anyAvailable: clis.some((c) => c.available),
    recommended,
  };
};

/**
 * Format the detection result as a one-liner suitable for the init
 * banner. Examples:
 *   "claude (2.0.31), codex (codex-cli 0.128.0)"
 *   "claude (2.0.31)" (when only claude is present)
 *   "(none detected)"
 */
export const formatDetectionSummary = (result: CliDetectionResult): string => {
  const installed = result.clis.filter((c) => c.available);
  if (installed.length === 0) return "(none detected)";
  return installed.map((c) => `${c.cli} (${c.version ?? "version unknown"})`).join(", ");
};
