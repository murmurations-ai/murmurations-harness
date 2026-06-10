/**
 * Phase 1B-e daemon boot — wires the full composition root:
 *
 *   DotenvSecretsProvider (optional, if .env exists)
 *     → GithubClient (optional, if GITHUB_TOKEN is loaded)
 *       → DefaultSignalAggregator (always active for filesystem sources)
 *         → Daemon
 *           → SubprocessExecutor → hello-world agent
 *
 * This is the first session in which the hello-world example exercises
 * all the Phase 1B components end-to-end:
 *
 * - Identity loader (1B-b)
 * - Secrets provider (1B-c)
 * - Cost instrumentation (1B-c)
 * - GitHub client (1B-d)
 * - Signal aggregator (1B-d)
 *
 * The secrets and github pieces are gracefully optional so the
 * gate test still runs without a real GITHUB_TOKEN on the machine.
 */

import { existsSync, unlinkSync } from "node:fs";
import { access, constants, mkdir, open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Replace bytes that can spoof terminal output (or pretend a filename
 * is something it isn't) with `?` before writing operator-visible
 * text to stderr or daemon logs. Used for filesystem entries
 * (directory names from `readdir`) and CLI argv values that an
 * attacker could plant.
 *
 * Strips:
 *   - C0 controls + DEL (`\x00`-`\x1f`, `\x7f`) — ANSI escape building blocks
 *   - C1 controls (`\x80`-`\x9f`) — includes 8-bit CSI `\x9b` which xterm
 *     and Terminal.app render as ESC `[`
 *   - Unicode bidi overrides + isolates (U+202A-U+202E, U+2066-U+2069) —
 *     the "Trojan Source" attack class (CVE-2021-42574): a directory
 *     named `agent-‮drm.elor` renders as `agent-role.md`
 *   - Zero-width / format chars (U+200B-U+200F, U+FEFF) — invisible
 *     padding that hides the real filename
 *   - Line/paragraph separators (U+2028-U+2029) — break terminal line
 *     accounting
 */
export const sanitizeForTerminal = (s: string): string =>
  s.replace(
    // eslint-disable-next-line no-control-regex
    /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g,
    "?",
  );

/**
 * Typed boot-time error. Thrown instead of `process.exit` so the
 * composition root stays library-like — `bin.ts` is the only place
 * that turns errors into exit codes (Engineering Standard #6).
 *
 * `kind` is a stable discriminator for testing and structured logging.
 * `exitCode` is the conventional sysexits value the bin entrypoint
 * should propagate (78 = configuration error per `sysexits.h`).
 */
export class BootError extends Error {
  public readonly kind:
    | "incomplete-agent-single"
    | "agent-missing-role"
    | "no-agents-found"
    | "governance-plugin-invalid"
    | "secrets-load-failed";
  public readonly exitCode: number;
  public constructor(kind: BootError["kind"], message: string, exitCode = 78) {
    super(message);
    this.name = "BootError";
    this.kind = kind;
    this.exitCode = exitCode;
  }
}

import {
  AgentStateStore,
  Daemon,
  DispatchExecutor,
  findReservedLabels,
  GitHubCollaborationProvider,
  GovernanceGitHubSync,
  DaemonHttp,
  DaemonSocket,
  HARNESS_VERSION,
  DispatchRunArtifactWriter,
  IdentityLoader,
  InProcessExecutor,
  isOrphanedSchedule,
  PluginInitError,
  RunArtifactWriter,
  SubprocessExecutor,
  makeSecretKey,
  makeUSDMicros,
  registeredAgentFromLoadedIdentity,
  satisfiesCoreVersionRange,
  type AgentExecutor,
  type AgentRunner,
  type BudgetCeiling,
  type CollaborationProvider,
  type DaemonConfig,
  type RegisteredAgent,
  type SecretDeclaration,
  type SecretKey,
  type SubscriptionCliAuditContext,
  type USDMicros,
  type SignalAggregator,
  type SubprocessCommand,
  type WakeCostBuilder,
  type WakeTrigger,
} from "@murmurations-ai/core";
import {
  createGithubClient,
  makeIssueNumber,
  makeRepoCoordinate,
  type GithubClient,
  type GithubWriteScopes,
  type RepoCoordinate,
} from "@murmurations-ai/github";
import {
  createLLMClient,
  createSubscriptionCliClient,
  ProviderRegistry,
  type LLMClient,
  type LLMCostHook,
} from "@murmurations-ai/llm";
import {
  isSubscriptionCliProvider,
  resolveLLMCost,
  resolveShadowApiCost,
} from "@murmurations-ai/llm/pricing";
import { McpToolLoader } from "@murmurations-ai/mcp";
import { DotenvSecretsProvider } from "@murmurations-ai/secrets-dotenv";
import { DefaultSignalAggregator } from "@murmurations-ai/signals";

import {
  buildGithubReadToolsForAgent,
  buildGithubWriteToolsForAgent,
} from "./github-tools/index.js";
import type { HarnessLLMConfig } from "./harness-config.js";
import { validateHarnessYaml } from "./harness-config.js";
import { resolveBundledGovernancePlugin } from "./governance-plugin-resolver.js";
import { buildMemoryToolsForAgent } from "./memory/index.js";
import { registerRunningSocket, unregisterRunningSocket } from "./running-sessions.js";
import { sweepOrphanedSpiritMcpConfigs, writeAgentMcpConfig } from "./spirit/mcp-config.js";

// ---------------------------------------------------------------------------
// CLI binary resolution — launchd / cron safe (harness#XXX)
//
// macOS launchd and Linux systemd/cron start processes with a minimal PATH
// that doesn't include user-specific install directories (e.g. ~/.local/bin,
// ~/.npm/bin). When the daemon runs via launchd (io.murmurations.*), a plain
// `spawn("claude")` fails with ENOENT even though `claude` is installed.
//
// Fix: resolve to an absolute path at daemon boot time. Try PATH first (works
// in interactive sessions), then fall back to the common install locations
// each CLI vendor uses on macOS/Linux. The resolved path is immune to PATH
// changes after boot.
// ---------------------------------------------------------------------------

/** Common install locations per CLI binary, most-likely first. */
const CLI_FALLBACK_PATHS: Record<string, readonly string[]> = {
  claude: [
    join(homedir(), ".local", "bin", "claude"),
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
    join(homedir(), ".npm", "bin", "claude"),
    join(homedir(), "node_modules", ".bin", "claude"),
  ],
  gemini: [
    join(homedir(), ".local", "bin", "gemini"),
    "/usr/local/bin/gemini",
    "/opt/homebrew/bin/gemini",
    join(homedir(), ".npm", "bin", "gemini"),
  ],
  codex: [
    join(homedir(), ".local", "bin", "codex"),
    "/usr/local/bin/codex",
    "/opt/homebrew/bin/codex",
    join(homedir(), ".npm", "bin", "codex"),
    join(homedir(), ".openai", "bin", "codex"),
  ],
};

/**
 * Resolve the absolute path for a CLI binary.
 *
 * Returns the first reachable executable found, or null if nothing is found.
 * Tries `which` first (inherits current PATH), then probes common install
 * locations so launchd / cron environments can still locate the binary.
 */
const resolveCliBinaryPath = async (cli: string): Promise<string | null> => {
  // Try PATH resolution via `which` first.
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync("which", [cli], { timeout: 5000 });
    const p = stdout.trim();
    if (p.length > 0) return p;
  } catch {
    // which failed — PATH doesn't include the binary; try fallback paths.
  }
  // Probe well-known install locations.
  const candidates = CLI_FALLBACK_PATHS[cli] ?? [];
  for (const p of candidates) {
    try {
      await access(p, constants.X_OK);
      return p;
    } catch {
      // not found or not executable
    }
  }
  return null;
};

const GITHUB_TOKEN = makeSecretKey("GITHUB_TOKEN");

// Per ADR-0025, the provider → env-key mapping lives on the
// ProviderRegistry. Boot builds its registry via
// `buildBuiltinProviderRegistry()` and threads it into both
// `buildSecretDeclaration` and `buildAgentClients`.

/**
 * Per-wake adapter: turn the LLM client's token-count-only cost hook
 * into a `WakeCostBuilder.addLlmTokens` feed that prices via the
 * ADR-0015 catalog at emit time. Exported so future per-wake executors
 * can build one hook per `WakeCostBuilder` without re-implementing the
 * catalog lookup. See ADR-0014 §Cost hook contract.
 *
 * When the (provider, model) pair isn't in the catalog the call still
 * lands as `costMicros: 0` — hard-failing here would swallow a
 * successful LLM call on a catalog gap. But silent zeros let stale
 * catalog entries hide for weeks (harness#251). The optional `logger`
 * argument fires a one-shot `daemon.cost.pricing.unknown` warn the
 * first time each pair is seen, with dedupe state held on the hook
 * instance so test wakes don't bleed into each other.
 */
/**
 * Resolve the effective subscription-CLI permission mode for an agent
 * (harness#392). The operator's explicit setting wins; otherwise, when
 * the agent declares non-empty `branch_commits` paths, auto-elevate to
 * `"trusted"` so headless `-p` wakes can actually write the files the
 * operator declared intent to commit to. Returning `undefined` lets the
 * subscription-cli adapter fall back to its own default (`"restricted"`).
 *
 * The original silent failure (EP#896): agents declared `branch_commits`
 * for `drafts/**` and `pipeline/**` but never set `permissionMode`,
 * so file writes silently no-op'd in headless mode. Six+ consecutive
 * wakes filed TENSION issues before the cause surfaced. This helper
 * makes the declaration surface itself enough to grant the permission.
 *
 * Why a small exported helper instead of inlining the logic in
 * `buildAgentClients`: pure predicate over the two inputs — testable in
 * isolation without scaffolding a full agent + client harness.
 */
export const deriveSubscriptionCliPermissionMode = (
  agent: RegisteredAgent,
  declaredMode: "restricted" | "operator-approved" | "trusted" | undefined,
): "restricted" | "operator-approved" | "trusted" | undefined => {
  // Operator's explicit setting always wins — never silently override a
  // decision the operator made, even when it might be tighter than the
  // auto-derivation would have chosen.
  if (declaredMode !== undefined) return declaredMode;
  // Auto-elevate when the agent declares write intent via branch_commits.
  const hasBranchCommits = agent.githubWriteScopes.branchCommits.some((b) => b.paths.length > 0);
  return hasBranchCommits ? "trusted" : undefined;
};

export const makeDaemonHook = (
  builder: WakeCostBuilder,
  logger?: { warn: (event: string, fields?: Record<string, unknown>) => void },
): LLMCostHook => {
  const warned = new Set<string>();
  return {
    onLlmCall: (call) => {
      const pricingInput = {
        provider: call.provider,
        model: call.model,
        inputTokens: call.inputTokens,
        outputTokens: call.outputTokens,
        ...(call.cacheReadTokens !== undefined ? { cacheReadTokens: call.cacheReadTokens } : {}),
        ...(call.cacheWriteTokens !== undefined ? { cacheWriteTokens: call.cacheWriteTokens } : {}),
      };
      const priced = resolveLLMCost(pricingInput);
      let costMicros: USDMicros;
      if (priced.ok) {
        costMicros = priced.value;
      } else {
        costMicros = makeUSDMicros(0);
        const key = `${call.provider}:${call.model}`;
        if (logger && !warned.has(key)) {
          warned.add(key);
          logger.warn("daemon.cost.pricing.unknown", {
            provider: call.provider,
            model: call.model,
            code: priced.error.code,
            message: priced.error.message,
            impact:
              "wake cost reports as $0 until this model is added to packages/llm/src/pricing/catalog.ts",
          });
        }
      }

      // Subscription-CLI wakes are $0 marginal at the operator (paid via
      // Pro/Max/ChatGPT/Google subscription). Compute shadow API cost so
      // operators see "what this would have cost on the API" — useful for
      // budgeting before scaling and for the "you saved $X" headline.
      let shadowCostMicros: USDMicros | undefined;
      if (isSubscriptionCliProvider(call.provider)) {
        const shadow = resolveShadowApiCost(pricingInput);
        if (shadow.ok) {
          shadowCostMicros = shadow.value;
        } else {
          shadowCostMicros = makeUSDMicros(0);
          const shadowKey = `shadow:${call.provider}:${call.model}`;
          if (logger && !warned.has(shadowKey)) {
            warned.add(shadowKey);
            logger.warn("daemon.cost.shadow.unknown", {
              provider: call.provider,
              model: call.model,
              code: shadow.error.code,
              message: shadow.error.message,
              impact:
                "shadow API cost reports as $0; add the model to the API provider's catalog entry",
            });
          }
        }
      }

      builder.addLlmTokens({
        inputTokens: call.inputTokens,
        outputTokens: call.outputTokens,
        ...(call.cacheReadTokens !== undefined ? { cacheReadTokens: call.cacheReadTokens } : {}),
        ...(call.cacheWriteTokens !== undefined ? { cacheWriteTokens: call.cacheWriteTokens } : {}),
        modelProvider: call.provider,
        modelName: call.model,
        costMicros,
        ...(shadowCostMicros !== undefined ? { shadowCostMicros } : {}),
        ...(call.cliPath !== undefined ? { cliPath: call.cliPath } : {}),
        ...(call.spawnMs !== undefined ? { spawnMs: call.spawnMs } : {}),
        ...(call.timeoutMs !== undefined ? { timeoutMs: call.timeoutMs } : {}),
      });
    },
  };
};

/**
 * Parse an `"owner/repo"` write-scope key into a typed
 * `RepoCoordinate`. Used by the InProcessExecutor's resolveClients
 * to derive the target repo for the Research Agent's digest commit.
 * Returns `undefined` on malformed input rather than throwing so a
 * single bad scope doesn't take down the whole boot.
 */
const parseRepoKey = (key: string): RepoCoordinate | undefined => {
  const [owner, name] = key.split("/");
  if (!owner || !name) return undefined;
  try {
    return makeRepoCoordinate(owner, name);
  } catch {
    return undefined;
  }
};

/**
 * Map `RegisteredAgent.githubWriteScopes` (ADR-0016 camelCase) to the
 * `@murmurations-ai/github` `GithubWriteScopes` shape (ADR-0017 §4).
 * CF-github-I closed: `issues` now flows through from role.md.
 */
const toClientWriteScopes = (agent: RegisteredAgent): GithubWriteScopes => ({
  issueComments: agent.githubWriteScopes.issueComments,
  branchCommits: agent.githubWriteScopes.branchCommits.map((b) => ({
    repo: b.repo,
    paths: b.paths,
  })),
  labels: agent.githubWriteScopes.labels,
  issues: agent.githubWriteScopes.issues,
});

/**
 * True if the agent declares any write surface at all. Used to decide
 * whether to construct a per-agent GithubClient with writeScopes set,
 * or fall back to the daemon-global read-only client.
 */
const hasAnyWriteScope = (agent: RegisteredAgent): boolean => {
  const s = agent.githubWriteScopes;
  return (
    s.issueComments.length > 0 ||
    s.branchCommits.length > 0 ||
    s.labels.length > 0 ||
    s.issues.length > 0
  );
};

/**
 * True if any budget field is non-zero. Zero values mean "fall back to
 * daemon-level ceiling" per ADR-0016 §budget gates.
 */
const hasBudget = (agent: RegisteredAgent): boolean => {
  return agent.budget.maxCostMicros > 0 || agent.budget.maxGithubApiCalls > 0;
};

/**
 * Build a `BudgetCeiling` from the registered agent's role frontmatter
 * budget block. Returns `null` when every field is zero — signaling
 * "no per-agent ceiling, use daemon default".
 */
const toBudgetCeiling = (agent: RegisteredAgent): BudgetCeiling | null => {
  if (!hasBudget(agent)) return null;
  const ceiling: {
    -readonly [K in keyof BudgetCeiling]: BudgetCeiling[K];
  } = { onBreach: agent.budget.onBreach };
  if (agent.budget.maxCostMicros > 0) {
    ceiling.maxCostMicros = makeUSDMicros(agent.budget.maxCostMicros);
  }
  if (agent.budget.maxGithubApiCalls > 0) {
    ceiling.maxGithubApiCalls = agent.budget.maxGithubApiCalls;
  }
  return ceiling;
};

/**
 * Compute the daemon-level `SecretDeclaration` by unioning:
 *   - `GITHUB_TOKEN` (always optional — read path works without it)
 *   - Per-agent `secrets.required` and `secrets.optional` from role.md
 *   - Provider API keys implied by each agent's `llm.provider` (optional)
 *
 * LLM provider keys land as *optional* rather than required so that
 * `hello-world` (no llm) and partial dotenv setups still boot. The
 * per-agent LLM client construction downstream checks `provider.has(...)`
 * and skips gracefully if the key is absent.
 */
const buildSecretDeclaration = (
  agents: readonly RegisteredAgent[],
  providerRegistry: ProviderRegistry,
): SecretDeclaration => {
  const required = new Map<string, SecretKey>();
  const optional = new Map<string, SecretKey>();
  optional.set(GITHUB_TOKEN.value, GITHUB_TOKEN);

  for (const agent of agents) {
    for (const name of agent.secrets.required) {
      required.set(name, makeSecretKey(name));
    }
    for (const name of agent.secrets.optional) {
      if (!required.has(name)) optional.set(name, makeSecretKey(name));
    }
    if (agent.llm) {
      const keyName = providerRegistry.envKeyName(agent.llm.provider);
      // `null` = keyless provider (e.g. Ollama); `undefined` = provider
      // not registered. Both mean "no secret to declare".
      if (typeof keyName === "string" && !required.has(keyName)) {
        optional.set(keyName, makeSecretKey(keyName));
      }
    }
  }
  return {
    required: [...required.values()],
    optional: [...optional.values()],
  };
};

/** Per-agent composition result, logged at boot for operator visibility. */
interface AgentComposition {
  readonly agentId: string;
  readonly llm?: LLMClient;
  readonly github?: GithubClient;
  readonly budgetCeiling: BudgetCeiling | null;
}

/**
 * Generic shape the in-process runner receives in its `clients` bag.
 * The LLM and GitHub fields are optional because an agent may not
 * have an LLM pin, or its writeScopes may have been denied (dry-run
 * or missing token). The runner must handle the `undefined` case.
 *
 * `targetRepo` and `targetBranch` are convenience fields derived from
 * the agent's `branchCommits` write scopes at boot time. They save
 * the runner from needing to import `@murmurations-ai/github` (which
 * doesn't resolve outside the monorepo). Operators whose runners
 * don't commit to GitHub can ignore them.
 */
export interface InProcessRunnerClients {
  readonly llm?: LLMClient;
  readonly github?: GithubClient;
  readonly targetRepo?: RepoCoordinate;
  readonly targetBranch?: string;
  /** Operator-defined extension fields. The harness passes these
   *  through without interpretation — runners cast them at the call
   *  site based on their own type knowledge. */
  readonly [key: string]: unknown;
}

/**
 * Options passed to {@link buildAgentClients}. The `costBuilder`
 * field is the per-wake seam: when present, the LLM client is
 * constructed with `defaultCostHook` bound to that builder via
 * {@link makeDaemonHook}, so every `llm.complete()` call inside the
 * wake automatically fires into THIS wake's cost record per
 * ADR-0014 §Cost hook contract. When absent, the LLM client is
 * constructed without a cost hook — used by the boot-time
 * composition loop purely for validation + logging.
 */
interface BuildAgentClientsArgs {
  readonly agent: RegisteredAgent;
  readonly provider: DotenvSecretsProvider | undefined;
  readonly providerRegistry: ProviderRegistry;
  readonly costBuilder?: WakeCostBuilder;
  readonly dryRun: boolean;
  readonly ollamaBaseUrl: string | undefined;
  /** Harness-level LLM defaults (harness.yaml `llm:`). Used as fallback
   *  when an agent's role.md doesn't pin a value — e.g. the harness sets
   *  `llm.cli: claude` and individual agents inherit unless they override.
   *  Closes harness#271 (agent compose silently fell back to a placeholder
   *  stub when `cli` was set only at harness.yaml level). */
  readonly harnessLlm: HarnessLLMConfig;
  /** Murmuration root directory (the operator's `<root>` containing
   *  `murmuration/`, `agents/`, etc.). Required for subscription-CLI
   *  agents on the claude-cli path because the Spirit MCP config gets
   *  written under `<rootDir>/.murmuration/spirit-mcp.json` and the
   *  spawned `mcp-bin.js` reads `MURMURATION_ROOT` from this path to
   *  attach to the daemon socket. Closes harness#291 — without this
   *  wiring, daemon-spawned subscription-CLI wakes ran text-only with
   *  no tool surface, while the Spirit interactive REPL had it. */
  readonly rootDir: string;
  /** Optional logger so the cost hook can emit `daemon.cost.pricing.unknown`
   *  warns when a model isn't in the pricing catalog (harness#251). */
  readonly logger?: { warn: (event: string, fields?: Record<string, unknown>) => void };
  /**
   * Absolute path to the subscription-CLI binary, pre-resolved at boot by
   * `resolveCliBinaryPath()`. When set, passed to `createSubscriptionCliClient`
   * so `spawn()` uses the absolute path rather than relying on PATH resolution.
   * Fixes ENOENT failures in launchd / cron environments (harness#XXX).
   */
  readonly resolvedCliPath?: string;
}

interface BuildAgentClientsResult {
  readonly llm?: LLMClient;
  readonly github?: GithubClient;
  readonly llmSkipReason?: string;
  readonly githubSkipReason?: string;
}

/**
 * Construct the per-agent client bag from the composition inputs.
 * Used twice: once at boot for the validation + logging pass (with
 * no cost builder), and once per wake inside
 * `InProcessExecutor.resolveClients` (with the wake's own cost
 * builder) so the cost hook lands on the right record.
 */
const buildAgentClients = ({
  resolvedCliPath,
  agent,
  provider,
  providerRegistry,
  costBuilder,
  dryRun,
  ollamaBaseUrl,
  harnessLlm,
  rootDir,
  logger,
}: BuildAgentClientsArgs): BuildAgentClientsResult => {
  const result: {
    llm?: LLMClient;
    github?: GithubClient;
    llmSkipReason?: string;
    githubSkipReason?: string;
  } = {};

  // Note: harness-level LLM inheritance is already wired in
  // packages/core/src/identity/index.ts (the loader injects
  // roleDefaults.llm into base.llm when role.md omits the `llm:`
  // block). So `agent.llm` here reflects the merged value. We
  // alias to `effectiveLlm` for readability; both refer to the
  // same already-merged config.
  const effectiveLlm = agent.llm;

  if (effectiveLlm) {
    // ADR-0034: subscription-CLI provider family bypasses the registry
    // because it spawns a subprocess, not a Vercel LanguageModel.
    if (effectiveLlm.provider === "subscription-cli") {
      // harness#271: agent's role.md cli takes precedence; fall back to
      // harness.yaml's llm.cli when the agent doesn't pin one. Without
      // this fallback, an operator who sets `llm.cli: claude` at the
      // harness level and inherits it across all agents would see every
      // agent silently downgrade to the placeholder stub.
      const cli = effectiveLlm.cli ?? harnessLlm.cli;
      if (cli !== "claude" && cli !== "gemini" && cli !== "codex") {
        result.llmSkipReason = `provider "subscription-cli" requires llm.cli: claude | gemini | codex (set on agent role.md llm.cli, or fall back via harness.yaml llm.cli)`;
      } else {
        const costHook = costBuilder ? makeDaemonHook(costBuilder, logger) : undefined;
        // Same fallback shape for model: agent override → harness default → empty
        const model = effectiveLlm.model ?? harnessLlm.model ?? "";
        // harness#291: wire Spirit MCP config so daemon-spawned claude-cli
        // agents can call harness-internal tools (status, agents, wake, ...)
        // through the same MCP bridge the interactive REPL uses (ADR-0038
        // Phase A). Without this, daemon wakes ran text-only — every EP
        // engineering wake on May 1 staged inline analysis instead of
        // posting to GitHub. Codex/gemini fall through (no `--mcp-config`
        // analogue today) and remain text-only until per-CLI MCP support
        // lands.
        // harness#355: use writeAgentMcpConfig (instead of writeSpiritMcpConfig)
        // so that MCP servers declared in role.md `tools.mcp` are merged into
        // the per-agent config file alongside the Spirit bridge. Agents without
        // `tools.mcp` entries get a config identical to the Spirit-only file.
        // Escape hatch: setting MURMURATION_DISABLE_AGENT_MCP=1 falls back
        // to text-only wakes (no `--mcp-config`). Useful if a future CLI
        // version regresses MCP startup or to isolate provider-side bugs.
        const mcpConfigPath =
          cli === "claude" && process.env.MURMURATION_DISABLE_AGENT_MCP !== "1"
            ? writeAgentMcpConfig(rootDir, agent.agentId, agent.tools.mcp)
            : undefined;
        // harness#357: pre-authorise declared MCP servers so the claude
        // subprocess can invoke their tools without interactive prompts in
        // headless -p mode. Each tools.mcp entry maps to an
        // `--allowedTools mcp__<name>__*` flag on the claude CLI call.
        const allowedMcpServerNames =
          mcpConfigPath !== undefined ? agent.tools.mcp.map((s) => s.name) : undefined;
        // harness#392: auto-derive permissionMode from branch_commits
        // declarations. Operator's explicit setting still wins; we honour
        // it at BOTH levels of precedence: the agent's role.md, then the
        // harness.yaml `llm.permissionMode`. The role-defaults cascade is
        // all-or-nothing (identity/index.ts only merges roleDefaults.llm
        // when the agent has NO llm block at all), so an agent that pins
        // its own llm block to set e.g. a model would otherwise never see
        // the operator's harness-wide permissionMode — and auto-elevation
        // would silently override a murmuration-level `restricted` policy.
        // Consulting harnessLlm here keeps "operator's explicit setting
        // always wins" true at harness.yaml granularity, not just role.md.
        const declaredPermissionMode = effectiveLlm.permissionMode ?? harnessLlm.permissionMode;
        const resolvedPermissionMode = deriveSubscriptionCliPermissionMode(
          agent,
          declaredPermissionMode,
        );
        if (declaredPermissionMode === undefined && resolvedPermissionMode === "trusted") {
          // Surface the auto-elevation so an operator scanning daemon
          // logs can see when their declared write intent triggered a
          // permission change they didn't explicitly configure.
          logger?.warn("daemon.agent.permission-mode.auto-elevated", {
            agentId: agent.agentId,
            from: "restricted",
            to: "trusted",
            reason: "branch_commits-declared",
            branchCommitsRepoCount: agent.githubWriteScopes.branchCommits.length,
            branchCommitsPathCount: agent.githubWriteScopes.branchCommits.reduce(
              (sum, b) => sum + b.paths.length,
              0,
            ),
          });
        }
        result.llm = createSubscriptionCliClient({
          cli,
          model,
          ...(effectiveLlm.timeoutMs !== undefined ? { timeoutMs: effectiveLlm.timeoutMs } : {}),
          ...(resolvedPermissionMode !== undefined
            ? { permissionMode: resolvedPermissionMode }
            : {}),
          ...(mcpConfigPath !== undefined ? { mcpConfigPath } : {}),
          ...(allowedMcpServerNames !== undefined ? { allowedMcpServerNames } : {}),
          ...(costHook !== undefined ? { defaultCostHook: costHook } : {}),
          ...(resolvedCliPath !== undefined ? { cliPath: resolvedCliPath } : {}),
        });
      }
    } else {
      const providerDef = providerRegistry.get(effectiveLlm.provider);
      if (!providerDef) {
        result.llmSkipReason = `provider "${effectiveLlm.provider}" is not registered`;
      } else {
        const resolvedModel =
          effectiveLlm.model ??
          providerRegistry.resolveModelForTier(effectiveLlm.provider, "balanced");
        if (!resolvedModel) {
          result.llmSkipReason = `no model for provider "${effectiveLlm.provider}" (pin role.md llm.model)`;
        } else {
          const costHook = costBuilder ? makeDaemonHook(costBuilder, logger) : undefined;
          if (providerDef.envKeyName === null) {
            // Keyless provider (e.g. local Ollama).
            result.llm = createLLMClient({
              registry: providerRegistry,
              provider: effectiveLlm.provider,
              model: resolvedModel,
              token: null,
              ...(ollamaBaseUrl !== undefined ? { baseUrl: ollamaBaseUrl } : {}),
              ...(costHook !== undefined ? { defaultCostHook: costHook } : {}),
            });
          } else if (provider?.has(makeSecretKey(providerDef.envKeyName)) === true) {
            const token = provider.get(makeSecretKey(providerDef.envKeyName));
            result.llm = createLLMClient({
              registry: providerRegistry,
              provider: effectiveLlm.provider,
              model: resolvedModel,
              token,
              ...(costHook !== undefined ? { defaultCostHook: costHook } : {}),
            });
          } else {
            result.llmSkipReason = "provider api key missing from secrets";
          }
        }
      }
    }
  }

  // GitHub cost hook: same shape as the LLM cost hook — routes
  // every getRef / createCommitOnBranch / createIssueComment call
  // into the per-wake WakeCostBuilder so index.jsonl carries
  // accurate github.restCalls / graphqlCalls counts. Closes #25.
  const githubCostHook = costBuilder
    ? {
        onGithubCall: (call: Parameters<typeof costBuilder.addGithubCall>[0]): void =>
          costBuilder.addGithubCall(call),
      }
    : undefined;

  // Construct a GithubClient when GITHUB_TOKEN is present, regardless
  // of whether the agent has declared write scopes. Agents without
  // write scopes get a read-only client (any write attempt fails with
  // "no write scopes configured" — see github/src/client.ts §scope check).
  // This is what powers the github read tools (formerly harness#256):
  // agents need GitHub-aware tools at all, not bundled bodies.
  if (provider?.has(GITHUB_TOKEN) === true) {
    if (hasAnyWriteScope(agent)) {
      if (dryRun) {
        result.github = createGithubClient({
          token: provider.get(GITHUB_TOKEN),
          ...(githubCostHook ? { defaultCostHook: githubCostHook } : {}),
        });
      } else {
        result.github = createGithubClient({
          token: provider.get(GITHUB_TOKEN),
          writeScopes: toClientWriteScopes(agent),
          ...(githubCostHook ? { defaultCostHook: githubCostHook } : {}),
        });
      }
    } else {
      // Read-only agent: omit writeScopes entirely so any accidental
      // write attempt fails-closed with a clear error.
      result.github = createGithubClient({
        token: provider.get(GITHUB_TOKEN),
        ...(githubCostHook ? { defaultCostHook: githubCostHook } : {}),
      });
    }
  } else if (hasAnyWriteScope(agent)) {
    result.githubSkipReason = "GITHUB_TOKEN absent; write-scoped client not constructed";
  }

  return result;
};

/** Fallback delay used when a role declares only an event trigger — the
 *  event bus isn't wired yet, so the boot path falls back to a single
 *  delayed wake so the operator can still smoke-boot. */
const EVENT_FALLBACK_DELAY_MS = 2000;

/**
 * Build a {@link WakeTrigger} from a role.md `wake_schedule` block. The
 * identity loader already validates the schema (Zod) and the cron
 * expression (via cron-parser), so this helper only chooses a shape
 * based on which field is present.
 *
 * Precedence when multiple fields are set: `cron` > `intervalMs` >
 * `delayMs` > `events`. In practice a role should set exactly one,
 * but the precedence is deterministic and documented here so it
 * can't silently change.
 */

/**
 * Discover group configs from governance/groups/*.md files.
 * Parses group name, members, facilitator, and governance cron.
 */
const discoverGroupConfigs = async (
  rootDir: string,
): Promise<import("@murmurations-ai/core").GroupConfig[]> => {
  const { readdir, readFile: rf } = await import("node:fs/promises");
  const groupsDir = resolve(rootDir, "governance", "groups");
  let entries: string[];
  try {
    entries = await readdir(groupsDir);
  } catch {
    return [];
  }
  const configs: import("@murmurations-ai/core").GroupConfig[] = [];
  for (const entry of entries.filter((e) => e.endsWith(".md")).sort()) {
    try {
      const content = await rf(resolve(groupsDir, entry), "utf8");
      const groupId = entry.replace(/\.md$/, "");

      // Extract members from "- agent-id" lines under "## Members"
      const membersMatch = /## Members\n([\s\S]*?)(?=\n##|\n---|\n$)/i.exec(content);
      const members: string[] = [];
      if (membersMatch?.[1]) {
        for (const line of membersMatch[1].split("\n")) {
          const m = /^\s*-\s*(.+)/.exec(line);
          if (m?.[1]) members.push(m[1].trim());
        }
      }

      const facMatch = /facilitator:\s*"?([^"\n]+)"?/i.exec(content);
      const facilitator = facMatch?.[1]?.trim() ?? members[0] ?? groupId;

      const nameMatch = /^#\s+(.+)/m.exec(content);
      const name = nameMatch?.[1]?.trim() ?? groupId;

      const govCronMatch = /governance_cron:\s*"?([^"\n]+)"?/i.exec(content);
      const governanceCron = govCronMatch?.[1]?.trim();

      configs.push({
        groupId,
        name,
        members,
        facilitator,
        ...(governanceCron ? { governanceCron } : {}),
      });
    } catch {
      // skip unparseable group files
    }
  }
  return configs;
};

const triggerFromFrontmatter = (
  wakeSchedule: {
    readonly cron?: string | undefined;
    readonly delayMs?: number | undefined;
    readonly intervalMs?: number | undefined;
    readonly events?: readonly string[] | undefined;
    readonly tz?: string | undefined;
  },
  agentId: string,
): WakeTrigger => {
  if (wakeSchedule.cron !== undefined) {
    return {
      kind: "cron",
      expression: wakeSchedule.cron,
      ...(wakeSchedule.tz !== undefined ? { tz: wakeSchedule.tz } : {}),
    };
  }
  if (wakeSchedule.intervalMs !== undefined) {
    return { kind: "interval", intervalMs: wakeSchedule.intervalMs };
  }
  if (wakeSchedule.delayMs !== undefined) {
    return { kind: "delay-once", delayMs: wakeSchedule.delayMs };
  }
  if (wakeSchedule.events && wakeSchedule.events.length > 0) {
    process.stdout.write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        event: "daemon.boot.events.fallback",
        agentId,
        events: wakeSchedule.events,
        reason:
          "event triggers are not yet wired to a dispatch bus; falling back to single delay-once wake for this session",
        fallbackDelayMs: EVENT_FALLBACK_DELAY_MS,
      })}\n`,
    );
    return { kind: "delay-once", delayMs: EVENT_FALLBACK_DELAY_MS };
  }
  // Schema would have caught this, but be explicit.
  throw new Error(`role ${agentId} declares no valid wake_schedule trigger`);
};

/** Options for {@link bootDaemon}. Both are optional and default to the
 *  shipped hello-world example so `murmuration start` with no args
 *  retains its Phase 1A behavior. */
export interface BootDaemonOptions {
  /** Absolute or relative path to the identity root (the directory that
   *  contains `murmuration/`, `agents/`, and `governance/groups/`). */
  readonly rootDir?: string;
  /** Subdirectory under `<rootDir>/agents/` containing the agent to boot. */
  readonly agentDir?: string;
  /** If true, the GithubClient is constructed without writeScopes, so
   *  every mutation attempt defaults-denies at the client layer. Used by
   *  Phase 2C6's Gemini dry-run gate. */
  readonly dryRun?: boolean;
  /**
   * If true, the daemon exits cleanly after the first wake completes
   * (regardless of outcome). Designed for cron-triggered single-shot
   * wakes — macOS launchd (or system cron) starts the daemon before
   * the wake window, the wake fires via delayMs, and the daemon
   * exits without an operator needing to SIGINT. Phase 2E uses this
   * for the weekly dual-run cadence.
   */
  readonly once?: boolean;
  /**
   * Path to a governance plugin module. The module must export a
   * `GovernancePlugin` as its default export. If omitted,
   * `NoOpGovernancePlugin` is used (allows everything, discards
   * all events).
   */
  readonly governancePath?: string;
  /**
   * If true, override each agent's wake schedule with an immediate
   * delay-once trigger (100ms). Used for testing and Source-initiated
   * off-cycle wakes without editing identity files.
   */
  readonly now?: boolean;
  /** Log level filter. Default: "info". */
  readonly logLevel?: "debug" | "info" | "warn" | "error";
  /**
   * Collaboration provider: "github" (default) or "local".
   * "local" uses filesystem-based coordination — no GitHub token needed.
   * ADR-0021.
   */
  readonly collaboration?: "github" | "local";
}

/**
 * Boot the daemon against an arbitrary identity root, run until
 * SIGINT/SIGTERM, then shut down cleanly. Defaults to the bundled
 * hello-world example so `murmuration start` with no args behaves
 * identically to the Phase 1A entry point.
 */
export const bootDaemon = async (options: BootDaemonOptions = {}): Promise<void> => {
  const exampleRoot = options.rootDir ? resolve(options.rootDir) : process.cwd();
  const dryRun = options.dryRun === true;
  const once = options.once === true;

  // Load harness.yaml config, then overlay CLI flags
  const { loadHarnessConfig, mergeWithCliFlags } = await import("./harness-config.js");
  const fileConfig = await loadHarnessConfig(exampleRoot);
  const cliOverrides: Parameters<typeof mergeWithCliFlags>[1] = {};
  if (options.governancePath)
    (cliOverrides as Record<string, unknown>).governancePath = options.governancePath;
  if (options.collaboration)
    (cliOverrides as Record<string, unknown>).collaboration = options.collaboration;
  if (options.logLevel) (cliOverrides as Record<string, unknown>).logLevel = options.logLevel;
  const config = mergeWithCliFlags(fileConfig, cliOverrides);

  // Construct event bus + structured logger (Engineering Standards #4 + #9)
  const { DaemonEventBus, DaemonLoggerImpl } = await import("@murmurations-ai/core");
  const eventBus = new DaemonEventBus();
  const logger = new DaemonLoggerImpl({ level: config.logging.level, eventBus });

  // Emit daemon.config.warn for every harness.yaml field that silently
  // fell back to a default (#323). This surfaces mis-spellings and invalid
  // enum values that loadHarnessConfig swallows without feedback.
  for (const w of await validateHarnessYaml(exampleRoot)) {
    logger.warn("daemon.config.warn", {
      field: w.field,
      message: w.message,
      received: w.received,
      ...(w.accepted !== undefined ? { accepted: w.accepted } : {}),
    });
  }

  // Load governance plugin — from merged config (CLI > harness.yaml > default)
  const governancePath = config.governance.plugin;
  let governancePlugin: import("@murmurations-ai/core").GovernancePlugin | undefined;
  if (governancePath) {
    // v0.5.0: short-name aliases for bundled plugins. `plugin: s3` or
    // `plugin: self-organizing` in harness.yaml resolves to the plugin
    // shipped inside the CLI package, not a file or npm package the
    // operator has to install themselves.
    const bundledAlias = resolveBundledGovernancePlugin(governancePath);

    // Try as npm package first (e.g. "@murmurations-ai/governance-s3"),
    // then as file path relative to murmuration root, then cwd.
    let mod: { default?: unknown };
    if (bundledAlias) {
      mod = (await import(pathToFileURL(bundledAlias).href)) as { default?: unknown };
    } else {
      try {
        // Try as npm package — resolve from the murmuration's node_modules first,
        // then from the CLI's node_modules (global install).
        const { createRequire } = await import("node:module");
        const localRequire = createRequire(join(exampleRoot, "package.json"));
        const resolved = localRequire.resolve(governancePath);
        mod = (await import(pathToFileURL(resolved).href)) as { default?: unknown };
      } catch {
        try {
          // Try direct import (works if plugin is globally installed or in CLI's node_modules)
          mod = (await import(governancePath)) as { default?: unknown };
        } catch {
          // Last resort: file path relative to murmuration root, then cwd
          const resolved = resolve(exampleRoot, governancePath);
          const pluginUrl = pathToFileURL(
            existsSync(resolved) ? resolved : resolve(governancePath),
          ).href;
          mod = (await import(pluginUrl)) as { default?: unknown };
        }
      }
    }
    const candidate: unknown = mod.default;
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      typeof (candidate as { name?: unknown }).name !== "string" ||
      typeof (candidate as { onEventsEmitted?: unknown }).onEventsEmitted !== "function"
    ) {
      throw new BootError(
        "governance-plugin-invalid",
        `murmuration: governance module at ${governancePath} must export a GovernancePlugin as default`,
      );
    }
    governancePlugin = candidate as import("@murmurations-ai/core").GovernancePlugin;
    const range = governancePlugin.compatibleCoreVersionRange;
    if (range !== undefined && range !== "") {
      if (!satisfiesCoreVersionRange(HARNESS_VERSION, range)) {
        throw new PluginInitError(
          `Governance plugin "${governancePlugin.name}" v${governancePlugin.version} requires core ${range} but harness core is v${HARNESS_VERSION}`,
        );
      }
    }
    const pluginVocabulary = governancePlugin.labelVocabulary?.() ?? [];
    process.stdout.write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        event: "daemon.governance.loaded",
        plugin: governancePlugin.name,
        version: governancePlugin.version,
        ...(pluginVocabulary.length > 0 ? { labelVocabulary: pluginVocabulary } : {}),
      })}\n`,
    );
  }

  // ADR-0027: fallback identity for incomplete agent directories.
  // Operators can scaffold empty dirs during iteration; the loader
  // synthesizes a generic identity with a visible daemon WARN instead
  // of crashing boot.
  const loader = new IdentityLoader({
    rootDir: exampleRoot,
    fallbackOnMissing: true,
    onFallback: (agentDir, reason) => {
      // harness#380: when role.md is missing, the call site will emit
      // a strictly more informative `daemon.warn.orphaned-schedule` event
      // (with the schedule-skip / hard-fail outcome). Suppress the
      // lower-level `daemon.agent.fallback` here so operators don't see
      // two warnings for the same condition.
      if (reason.missingFiles.includes("role.md")) return;
      logger.warn("daemon.agent.fallback", {
        agentDir,
        reason: reason.reason,
        missingFiles: reason.missingFiles,
        ...(reason.detail !== undefined ? { detail: reason.detail } : {}),
      });
    },
    // Engineering Standard #11: cascade harness.yaml `llm:` into each
    // agent's role.md when the agent omits it.
    roleDefaults: {
      llm: {
        provider: config.llm.provider,
        ...(config.llm.model !== undefined ? { model: config.llm.model } : {}),
        ...(config.llm.cli !== undefined ? { cli: config.llm.cli } : {}),
        ...(config.llm.permissionMode !== undefined
          ? { permissionMode: config.llm.permissionMode }
          : {}),
      },
    },
  });

  // -------------------------------------------------------------------
  // Agent discovery: when --agent is set, boot one; when omitted, boot
  // every agent found in <root>/agents/*/role.md.
  // -------------------------------------------------------------------

  let agentDirs: readonly string[];
  if (options.agentDir !== undefined) {
    // Single-agent path (`--agent <id>`). Validate that the requested
    // agent directory has BOTH identity files — refuse to boot otherwise
    // rather than fall back to silent synthesis.
    const incompleteAgents = await loader.findIncompleteAgents();
    const incompleteSingle = incompleteAgents.find((i) => i.dir === options.agentDir);
    if (incompleteSingle !== undefined) {
      throw new BootError(
        "incomplete-agent-single",
        `murmuration: agent "${sanitizeForTerminal(options.agentDir)}" is incomplete — missing ${incompleteSingle.missing.join(", ")}. ` +
          `Add the missing file before booting this agent.`,
      );
    }
    agentDirs = [options.agentDir];
  } else if (options.rootDir !== undefined) {
    // Explicit --root without --agent → discover all agents.
    // Half-configured agent dirs (have role.md OR soul.md but not both)
    // are surfaced to the operator and skipped — the daemon proceeds
    // with the agents that ARE fully configured. Silent fallback
    // synthesis is the wrong behavior: a missing role.md or soul.md
    // means the operator hasn't finished wiring that agent, and waking
    // it with a generated default produces phantom activity in the
    // murmuration's audit trail.
    const incompleteAgents = await loader.findIncompleteAgents();
    if (incompleteAgents.length > 0) {
      const lines = incompleteAgents.map(
        ({ dir, missing }) =>
          `  - agents/${sanitizeForTerminal(dir)}/  (missing: ${missing.join(", ")})`,
      );
      process.stderr.write(
        `murmuration: skipping ${String(incompleteAgents.length)} incomplete agent(s) — ` +
          `each directory has one identity file but not the other:\n\n` +
          `${lines.join("\n")}\n\n` +
          `Add the missing file or remove the directory. Boot continues with the ` +
          `agents that are fully configured.\n\n`,
      );
    }
    const incompleteSet = new Set(incompleteAgents.map((i) => i.dir));
    agentDirs = (await loader.discover()).filter((d) => !incompleteSet.has(d));
    if (agentDirs.length === 0) {
      const hint =
        incompleteAgents.length > 0
          ? ` — ${String(incompleteAgents.length)} directory(s) skipped as incomplete (see warnings above)`
          : "";
      throw new BootError(
        "no-agents-found",
        `murmuration: no agents found in ${resolve(exampleRoot, "agents")}/*/ (looking for role.md + soul.md)${hint}`,
      );
    }
  } else {
    // No --root, no --agent → default hello-world example.
    agentDirs = ["hello-world"];
  }

  process.stdout.write(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      event: "daemon.boot.config",
      version: HARNESS_VERSION,
      rootDir: exampleRoot,
      agentDirs,
      dryRun,
    })}\n`,
  );

  // Load identities + build triggers for every agent. harness#380:
  // when `role.md` is missing entirely, IdentityLoader falls back to
  // the default-agent template — that's intentional for fresh scaffolding,
  // but a daemon-startup *schedule* derived from a synthesized identity
  // means the agent would wake on cron with template behaviour (drift).
  //
  // The orphan check is intentionally defensive. In multi-agent mode,
  // `loader.discover()` (line 1018) already filters out dirs lacking
  // `role.md`, so the check here is belt-and-suspenders against future
  // call sites that build agentDirs differently (e.g. an operator-supplied
  // list, a state-store-driven re-registration, etc.). In single-agent
  // mode (`--agent <id>`) the check IS reachable: `findIncompleteAgents`
  // (line 1000) only flags dirs with EXACTLY ONE of role.md/soul.md, so a
  // dir with NEITHER file slips past that gate and lands here. We throw
  // rather than warn-and-skip because the operator named the agent
  // explicitly; silently dropping the only requested agent is worse than
  // failing fast.
  const allRegistered: RegisteredAgent[] = [];
  for (const agentDir of agentDirs) {
    const loaded = await loader.load(agentDir);
    if (isOrphanedSchedule(loaded)) {
      if (options.agentDir !== undefined) {
        throw new BootError(
          "agent-missing-role",
          `murmuration: agent "${sanitizeForTerminal(agentDir)}" has no role.md — refusing to wake via the default-agent template. Add a role.md or remove the agent directory.`,
        );
      }
      // `isOrphanedSchedule` is a type guard — `loaded.fallback` is
      // narrowed to defined here, no optional-chain noise needed.
      logger.warn("daemon.warn.orphaned-schedule", {
        agentDir,
        missingFiles: loaded.fallback.missingFiles,
        reason: loaded.fallback.reason,
      });
      continue;
    }
    const wakeSchedule = loaded.frontmatter.wake_schedule ?? { delayMs: EVENT_FALLBACK_DELAY_MS };
    const trigger: WakeTrigger = options.now
      ? { kind: "delay-once", delayMs: 100 }
      : triggerFromFrontmatter(wakeSchedule, loaded.agentId.value);
    allRegistered.push(registeredAgentFromLoadedIdentity(loaded, trigger));
  }

  // A provisional subprocess executor is used for the first-pass daemon
  // (which only calls loadSecrets() before being discarded) and as the
  // ADR-0028 opt-in escape hatch for non-LLM agents when the operator
  // has dropped an `agent.mjs` at the murmuration root. Standard agents
  // never trigger this path — they route through InProcessExecutor with
  // the default runner (see the per-agent block below).
  const agentScriptPath = resolve(exampleRoot, "agent.mjs");
  const registeredIds = new Set(allRegistered.map((a) => a.agentId));
  const provisionalExecutor = new SubprocessExecutor({
    resolveCommand: (context): SubprocessCommand => {
      if (!registeredIds.has(context.agentId.value)) {
        throw new Error(`resolveCommand: unknown agent ${context.agentId.value}`);
      }
      return {
        command: process.execPath,
        args: [agentScriptPath],
      };
    },
  });

  // -------------------------------------------------------------------
  // Optional secrets + github wiring
  // -------------------------------------------------------------------

  const envPath = resolve(exampleRoot, ".env");
  const provider: DotenvSecretsProvider | undefined = existsSync(envPath)
    ? new DotenvSecretsProvider({ envPath })
    : undefined;

  // -------------------------------------------------------------------
  // Provider registry (ADR-0025) — seed with CLI-bundled built-ins
  // before extensions load (done further below) or secret declaration
  // is computed. Extension-registered providers are added to the same
  // instance when `loadExtensions` runs.
  // -------------------------------------------------------------------

  const { buildBuiltinProviderRegistry } = await import("./builtin-providers/index.js");
  const providerRegistry = buildBuiltinProviderRegistry();

  // Unioned declaration across ALL registered agents, per ADR-0010 /
  // ADR-0016. For hello-world this collapses to `{ required: [],
  // optional: [GITHUB_TOKEN] }` — identical to the pre-2D behavior.
  const declaration = buildSecretDeclaration(allRegistered, providerRegistry);

  const secretsBlock: DaemonConfig["secrets"] | undefined = provider
    ? { provider, declaration }
    : undefined;

  // Resolve subscription-CLI binary path once at boot (T-CLI-9 / harness#301).
  // launchd / cron / systemd start daemons with a minimal PATH that may omit
  // user-install locations (e.g. ~/.local/bin). Resolving here — before the
  // writer map and agent loop — lets both use the cached absolute path rather
  // than re-running PATH lookups per wake. Uses `which` first (works in
  // interactive shells), then probes common install locations as a fallback.
  const harnessCliName = config.llm.provider === "subscription-cli" ? config.llm.cli : undefined;
  const resolvedCliPath: string | undefined = harnessCliName
    ? ((await resolveCliBinaryPath(harnessCliName)) ?? undefined)
    : undefined;
  if (harnessCliName && resolvedCliPath) {
    logger.info("daemon.cli.resolved", { cli: harnessCliName, path: resolvedCliPath });
  } else if (harnessCliName && !resolvedCliPath) {
    logger.warn("daemon.cli.not-found", {
      cli: harnessCliName,
      message: `"${harnessCliName}" not found via PATH or common install locations; wakes will fail with ENOENT`,
    });
  }

  // Per-agent run artifact writers. Each agent gets its own writer
  // at `<rootDir>/runs/<agentId>/`.
  const writerMap = new Map<string, RunArtifactWriter>();
  for (const agent of allRegistered) {
    const agentCli =
      agent.llm?.provider === "subscription-cli" ? (agent.llm.cli ?? harnessCliName) : undefined;
    const subscriptionCliContext: SubscriptionCliAuditContext | undefined =
      agentCli === "claude" || agentCli === "gemini" || agentCli === "codex"
        ? {
            cliName: agentCli,
            resolvedPath: resolvedCliPath ?? agentCli,
            // harness#392: record the EFFECTIVE permission mode, not the
            // raw declaration. When branch_commits auto-elevates an agent
            // to "trusted", the subprocess runs with --dangerously-skip-
            // permissions, so the audit record under runs/<agentId>/ must
            // say "trusted" too — otherwise a security review of the run
            // artifacts concludes the wake ran sandboxed when it had full
            // write access. Mirrors the buildAgentClients derivation
            // (role.md → harness.yaml → branch_commits auto-elevation).
            permissionMode:
              deriveSubscriptionCliPermissionMode(
                agent,
                agent.llm?.permissionMode ?? config.llm.permissionMode,
              ) ?? "restricted",
            allowedTools:
              agentCli === "claude" ? agent.tools.mcp.map((s) => `mcp__${s.name}__*`) : [],
            envAllowlistApplied: true,
          }
        : undefined;
    writerMap.set(
      agent.agentId,
      new RunArtifactWriter({
        rootDir: resolve(exampleRoot, "runs", agent.agentId),
        ...(subscriptionCliContext !== undefined
          ? { subscriptionCli: subscriptionCliContext }
          : {}),
      }),
    );
  }
  const runArtifactWriter =
    writerMap.size === 1 ? [...writerMap.values()][0]! : new DispatchRunArtifactWriter(writerMap);

  // -------------------------------------------------------------------
  // Collaboration provider (ADR-0021)
  //
  // "local" creates a filesystem provider immediately.
  // "github" (default) is wired later after agent registration, since
  // the target repo comes from agent signal scopes. The legacy GitHub
  // client path continues to work alongside the provider.
  // -------------------------------------------------------------------

  const collaborationMode = config.collaboration.provider;

  const localCollaborationProvider =
    collaborationMode === "local"
      ? new (await import("@murmurations-ai/core")).LocalCollaborationProvider({
          itemsDir: join(exampleRoot, ".murmuration", "items"),
          artifactsDir: exampleRoot,
        })
      : undefined;

  // First pass: construct a daemon with the filesystem-only aggregator
  // (+ local collaboration provider if in local mode) and load secrets.
  // If GITHUB_TOKEN is present after load, rebuild with an upgraded
  // aggregator that includes the github client.
  const filesystemOnlyAggregator: SignalAggregator = new DefaultSignalAggregator({
    rootDir: exampleRoot,
    ...(localCollaborationProvider ? { collaborationProvider: localCollaborationProvider } : {}),
    // v0.7.0 (ADR-0042): tier wakes by priority for filesystem-only
    // aggregator too — non-github signals still benefit from the
    // tiered ordering.
    priorityBundle: true,
    // harness#394: structured-log line when a wake's signal bundle exceeds
    // count or byte thresholds — gives operators a way to see context-burn
    // trends without parsing per-wake bundles by hand.
    onBundleMetrics: (m) => {
      logger.info("daemon.signal-bundle.large", {
        agentId: m.agentId,
        wakeId: m.wakeId,
        issueCount: m.issueCount,
        totalBytes: m.totalBytes,
        issueThreshold: m.thresholds.issues,
        byteThreshold: m.thresholds.bytes,
      });
    },
  });

  const firstPassDaemon = new Daemon({
    executor: provisionalExecutor,
    agents: allRegistered,
    signalAggregator: filesystemOnlyAggregator,
    runArtifactWriter,
    logger,
    ...(secretsBlock ? { secrets: secretsBlock } : {}),
    ...(governancePlugin ? { governance: governancePlugin } : {}),
    governancePersistDir: resolve(exampleRoot, ".murmuration", "governance"),
    agentStateStore: new AgentStateStore({
      persistDir: resolve(exampleRoot, ".murmuration", "agents"),
    }),
  });

  let githubClient: GithubClient | undefined;
  if (provider) {
    const loaded = await firstPassDaemon.loadSecrets();
    if (!loaded) {
      process.stdout.write(
        `${JSON.stringify({
          ts: new Date().toISOString(),
          level: "error",
          event: "daemon.boot.aborted",
          reason: "secrets load failed",
        })}\n`,
      );
      throw new BootError("secrets-load-failed", "murmuration: secrets load failed");
    }
    if (provider.has(GITHUB_TOKEN)) {
      // Resolve the target repo once, so the shared githubClient has
      // writeScopes set for it. Without this, every write path through
      // the daemon (Source directive close/delete, governance meeting
      // minutes post) hits `no write scopes configured`. Same
      // resolution order as collaboration-factory.ts: first-agent
      // scope → harness.yaml → any-agent scope.
      let bootRepoCoord: { owner: string; repo: string } | undefined;
      const firstAgentScope = allRegistered[0]?.signalScopes?.githubScopes?.[0];
      if (firstAgentScope) {
        bootRepoCoord = { owner: firstAgentScope.owner, repo: firstAgentScope.repo };
      }
      if (!bootRepoCoord && config.collaboration.repo) {
        const parts = config.collaboration.repo.split("/");
        if (parts.length === 2 && parts[0] && parts[1]) {
          bootRepoCoord = { owner: parts[0], repo: parts[1] };
        }
      }
      if (!bootRepoCoord) {
        for (const agent of allRegistered) {
          const scope = agent.signalScopes?.githubScopes?.[0];
          if (scope) {
            bootRepoCoord = { owner: scope.owner, repo: scope.repo };
            break;
          }
        }
      }
      const writeScopesRepos = bootRepoCoord
        ? [`${bootRepoCoord.owner}/${bootRepoCoord.repo}`]
        : [];
      githubClient = createGithubClient({
        token: provider.get(GITHUB_TOKEN),
        ...(writeScopesRepos.length > 0
          ? {
              writeScopes: {
                issueComments: writeScopesRepos,
                branchCommits: [],
                labels: writeScopesRepos,
                issues: writeScopesRepos,
              },
            }
          : {}),
      });
    }
  }

  if (localCollaborationProvider) {
    logger.info("daemon.collaboration.provider", { provider: "local" });
  }

  // -------------------------------------------------------------------
  // Extension loading (ADR-0023 + ADR-0025 Phase 2) — extensions may
  // contribute providers that land on the same `providerRegistry`
  // instance constructed earlier in boot.
  // -------------------------------------------------------------------

  const { validateProviderDefinition } = await import("@murmurations-ai/llm");

  const { loadExtensions } = await import("@murmurations-ai/core");

  // Per-provider-registration callback — shared by built-in and
  // operator extension loads so a contributed provider from either
  // source lands on the same `providerRegistry`.
  const onRegisterProvider = (definition: unknown, extensionId: string): void => {
    try {
      const def = validateProviderDefinition(definition, extensionId);
      providerRegistry.register(def);
      logger.info("daemon.providers.registered", {
        extensionId,
        providerId: def.id,
        displayName: def.displayName,
      });
    } catch (err) {
      logger.warn("daemon.providers.invalid", {
        extensionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // Built-in extensions shipped with the CLI binary. These live in
  // `packages/cli/dist/builtin-extensions/` at runtime (copied from
  // `src/builtin-extensions/` by the build script) and are loaded
  // first so operator extensions can override them by id if desired.
  const cliDistDir = dirname(fileURLToPath(import.meta.url));
  const builtinExtensionsDir = resolve(cliDistDir, "builtin-extensions");
  const builtinExtensions = existsSync(builtinExtensionsDir)
    ? await loadExtensions(builtinExtensionsDir, exampleRoot, { onRegisterProvider })
    : [];
  if (builtinExtensions.length > 0) {
    logger.info("daemon.extensions.builtin.loaded", {
      count: builtinExtensions.length,
      ids: builtinExtensions.map((e) => e.id),
    });
  }

  const extensionsDir = join(exampleRoot, "extensions");
  const operatorExtensions = await loadExtensions(extensionsDir, exampleRoot, {
    onRegisterProvider,
  });
  // Operator extensions win on id collision — built-ins are shadowed.
  const builtinIdsSeen = new Set(operatorExtensions.map((e) => e.id));
  const loadedExtensions = [
    ...builtinExtensions.filter((e) => !builtinIdsSeen.has(e.id)),
    ...operatorExtensions,
  ];
  if (loadedExtensions.length > 0) {
    const toolCount = loadedExtensions.reduce((n, ext) => n + ext.tools.length, 0);
    logger.info("daemon.extensions.loaded", {
      count: loadedExtensions.length,
      tools: toolCount,
      ids: loadedExtensions.map((e) => e.id),
    });
  }

  // Log the resolved provider roster — operator can see at a glance
  // which providers are available for `llm.provider` config fields.
  logger.info("daemon.providers.roster", {
    providers: providerRegistry.list().map((p) => p.id),
  });

  // Collect all extension tools into a flat array — used by group
  // meetings (where any member may invoke any plugin) and as the
  // fallback for agents whose role.md declares no `plugins:`.
  const extensionTools = loadedExtensions.flatMap((ext) => ext.tools);

  /**
   * Filter the loaded extensions by an agent's declared `plugins:`
   * (ADR-0023). Returns a flat tool array ready to hand to the runner.
   *
   * Matching rule: an agent's `provider` string matches an extension
   * id directly (e.g. `"web-search"`) OR via its last path segment
   * (e.g. `"@murmurations-ai/web-search"` → `"web-search"`). This lets
   * role.md declarations use either the bare plugin id or the
   * scoped-npm-style form.
   *
   * Backward compat: when `agent.plugins` is empty, return all loaded
   * extension tools (matches pre-gating behavior).
   *
   * Built-in tool auto-include: every agent gets `files` + `memory` on
   * top of any plugins they declare. These two are floor capabilities
   * — agents need file access to read repo docs / write artifacts, and
   * memory access to persist state across wakes (ADR-0029). Without
   * them an agent reaches the LLM with an empty tool catalog and can
   * only narrate (Boundary 5 hallucination shape).
   *
   * History: this auto-include used to fire only for the local
   * collaboration provider, on the (incorrect) reasoning that github
   * agents posted everything to GitHub and didn't need filesystem.
   * Live discovery 2026-04-30: every wake of every EP engineering
   * agent (github collab) produced `tool_calls: 0` because their
   * declared plugin (`github-extras` — phantom, not actually loaded)
   * filtered the tool set down to nothing. The runner reached the LLM
   * with `tools=undefined`, which collapses the agent into pure
   * narrative output — exactly the ARCHITECTURE.md §12 anti-pattern
   * the harness exists to detect.
   *
   * Empty plugins declaration still gets the full extension tool set
   * via the backward-compat path below.
   */
  const selectExtensionToolsFor = (
    agent: RegisteredAgent,
    agentDir: string,
  ): readonly (typeof extensionTools)[number][] => {
    // ADR-0029: memory is agent-scoped — tools are built per-agent,
    // not shared across agents.
    const buildAgentBoundMemory = (): readonly (typeof extensionTools)[number][] =>
      buildMemoryToolsForAgent({
        rootDir: exampleRoot,
        agentDir,
      }) as readonly (typeof extensionTools)[number][];

    // GitHub read tools (replacement for harness#256). Construct a
    // boot-time client when GITHUB_TOKEN is available; the agent's
    // declared write_scopes (if any) gate write paths separately
    // through the WakeAction pipeline. Read calls don't yet land in
    // a per-wake cost builder — that's a known v1 limitation; total
    // call counts still surface via the daemon-level token's
    // GitHub-side rate-limit headers.
    const buildAgentBoundGithub = (): readonly (typeof extensionTools)[number][] => {
      if (provider?.has(GITHUB_TOKEN) !== true) return [];
      const readClient = createGithubClient({
        token: provider.get(GITHUB_TOKEN),
      });
      const readTools = buildGithubReadToolsForAgent(readClient);
      // Add write tools for agents that declare issue_comments write scopes (#274).
      // The write client enforces ADR-0017 scope at the GitHub layer.
      const hasCommentScope = agent.githubWriteScopes.issueComments.length > 0;
      const writeTools =
        hasCommentScope && !dryRun
          ? buildGithubWriteToolsForAgent(
              createGithubClient({
                token: provider.get(GITHUB_TOKEN),
                writeScopes: toClientWriteScopes(agent),
              }),
            )
          : [];
      return [...readTools, ...writeTools] as readonly (typeof extensionTools)[number][];
    };

    if (agent.plugins.length === 0) {
      // Backward compat: agents with no explicit declaration see all
      // shared extension tools + per-agent memory + github tools.
      return [...extensionTools, ...buildAgentBoundMemory(), ...buildAgentBoundGithub()];
    }

    const declared = new Set<string>();
    for (const p of agent.plugins) {
      declared.add(p.provider);
      const parts = p.provider.split("/");
      const last = parts[parts.length - 1];
      if (last !== undefined && parts.length > 1) declared.add(last);
    }
    // Auto-include floor capabilities for every agent regardless of
    // collaboration provider. There is no legitimate scenario today
    // for waking an agent with zero tools; an opt-out mechanism can
    // be added if a use case emerges.
    declared.add("files");
    declared.add("@murmurations-ai/files");
    declared.add("memory");
    declared.add("@murmurations-ai/memory");
    // Auto-include github read tools when GITHUB_TOKEN is present.
    // Operators can opt out by removing the token from .env. If we
    // ever add a true read-scope mechanism this auto-include should
    // gate on declaration instead.
    declared.add("github");
    declared.add("@murmurations-ai/github");

    const sharedTools = loadedExtensions
      .filter((ext) => declared.has(ext.id))
      .flatMap((ext) => ext.tools);

    // Attach per-agent memory + github tools.
    return [...sharedTools, ...buildAgentBoundMemory(), ...buildAgentBoundGithub()];
  };

  // -------------------------------------------------------------------
  // Per-agent composition (Phase 2D3)
  //
  // For each registered agent: instantiate the LLM client pinned by
  // role frontmatter, build a per-agent GithubClient with writeScopes
  // if any are declared, and compute a BudgetCeiling. Nothing here is
  // dispatched to the executor yet — the subprocess runner doesn't
  // have a seam for it. Phase 2E+ lands that wiring. For now, boot
  // validates the composition and logs the outcome so operator and
  // gate test can confirm every piece is wired.
  // -------------------------------------------------------------------

  const compositions: AgentComposition[] = [];
  const ollamaBaseUrl = process.env.OLLAMA_BASE_URL;
  const executorMap = new Map<string, AgentExecutor>();

  for (const agent of allRegistered) {
    // Boot-time validation pass: build a throw-away client bag with
    // NO cost builder so we just verify everything can be wired.
    const validation = buildAgentClients({
      agent,
      provider,
      providerRegistry,
      dryRun,
      ollamaBaseUrl,
      harnessLlm: config.llm,
      rootDir: exampleRoot,
      ...(resolvedCliPath !== undefined ? { resolvedCliPath } : {}),
    });

    if (agent.llm && validation.llmSkipReason) {
      process.stdout.write(
        `${JSON.stringify({
          ts: new Date().toISOString(),
          level: "warn",
          event: "daemon.compose.llm.skipped",
          agentId: agent.agentId,
          provider: agent.llm.provider,
          reason: validation.llmSkipReason,
        })}\n`,
      );
    }

    if (hasAnyWriteScope(agent)) {
      if (dryRun) {
        process.stdout.write(
          `${JSON.stringify({
            ts: new Date().toISOString(),
            level: "info",
            event: "daemon.compose.github.dryRun",
            agentId: agent.agentId,
            declared: {
              issueComments: agent.githubWriteScopes.issueComments,
              branchCommits: agent.githubWriteScopes.branchCommits,
              labels: agent.githubWriteScopes.labels,
            },
            enforced: "default-deny (dry-run)",
          })}\n`,
        );
      } else if (validation.githubSkipReason) {
        process.stdout.write(
          `${JSON.stringify({
            ts: new Date().toISOString(),
            level: "warn",
            event: "daemon.compose.github.skipped",
            agentId: agent.agentId,
            reason: validation.githubSkipReason,
          })}\n`,
        );
      }
    }

    const budgetCeiling = toBudgetCeiling(agent);

    compositions.push({
      agentId: agent.agentId,
      ...(validation.llm ? { llm: validation.llm } : {}),
      ...(validation.github ? { github: validation.github } : {}),
      budgetCeiling,
    });

    process.stdout.write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        event: "daemon.compose.agent",
        agentId: agent.agentId,
        llm: agent.llm
          ? {
              provider: agent.llm.provider,
              model: agent.llm.model ?? null,
              instantiated: validation.llm !== undefined,
            }
          : null,
        githubWriteScoped: validation.github !== undefined,
        budgetCeiling:
          budgetCeiling === null
            ? null
            : {
                maxCostMicros: budgetCeiling.maxCostMicros?.value ?? null,
                maxGithubApiCalls: budgetCeiling.maxGithubApiCalls ?? null,
                onBreach: budgetCeiling.onBreach,
              },
      })}\n`,
    );

    // -------------------------------------------------------------------
    // Per-agent executor selection (ADR-0028)
    //
    // Every agent runs through InProcessExecutor + the default runner
    // unless the operator has dropped an `agent.mjs` at the murmuration
    // root, in which case that opt-in subprocess escape hatch still
    // works. Source never has to author JavaScript to stand up a
    // standard LLM or governance-only agent.
    //
    // Non-LLM agents route through the default runner too: it returns
    // a "skipped — no LLM client" wake summary so the daemon keeps
    // running and the operator can add an `llm:` block to role.md
    // whenever they're ready.
    //
    // When multiple agents exist, DispatchExecutor routes
    // spawn/waitForCompletion/kill by agentId.
    // -------------------------------------------------------------------

    const useSubprocessEscapeHatch = !agent.llm && existsSync(agentScriptPath);
    if (useSubprocessEscapeHatch) {
      executorMap.set(agent.agentId, provisionalExecutor);
    } else {
      // Capture the agent reference for the closure — the loop
      // variable `agent` would be stale by the time resolveRunner runs.
      const capturedAgent = agent;
      const capturedAgentDir = agentDirs[allRegistered.indexOf(agent)]!;
      executorMap.set(
        agent.agentId,
        new InProcessExecutor<InProcessRunnerClients>({
          instanceId: `in-process-${capturedAgent.agentId}`,
          resolveRunner: async ({ agentId }) => {
            if (agentId !== capturedAgent.agentId) {
              throw new Error(`resolveRunner: unknown agent ${agentId}`);
            }
            const runnerPath = resolve(exampleRoot, "agents", capturedAgentDir, "runner.mjs");
            // Try custom runner.mjs first; fall back to default runner
            try {
              const { statSync: statF } = await import("node:fs");
              statF(runnerPath); // throws if missing
              const mod = (await import(pathToFileURL(runnerPath).href)) as {
                default?: unknown;
                runWake?: unknown;
              };
              const candidate: unknown = mod.default ?? mod.runWake;
              if (typeof candidate !== "function") {
                throw new Error(
                  `runner at ${runnerPath} must export a default function or a named \`runWake\` function`,
                );
              }
              return candidate as AgentRunner<InProcessRunnerClients>;
            } catch {
              // No custom runner — use the built-in default runner.
              // Per-agent plugin gating: filter extension tools by the
              // agent's declared plugins (role.md `plugins:`).
              const { createDefaultRunner } = await import("@murmurations-ai/core");
              const agentTools = selectExtensionToolsFor(capturedAgent, capturedAgentDir);
              return createDefaultRunner(
                capturedAgentDir,
                [],
                {
                  maxSteps: config.agent.maxSteps,
                  ...(agentTools.length > 0 ? { extensionTools: agentTools } : {}),
                },
                exampleRoot,
              ) as unknown as AgentRunner<InProcessRunnerClients>;
            }
          },
          resolveClients: ({ costBuilder }) => {
            const wakeClients = buildAgentClients({
              agent: capturedAgent,
              provider,
              providerRegistry,
              costBuilder,
              dryRun,
              ollamaBaseUrl,
              harnessLlm: config.llm,
              rootDir: exampleRoot,
              logger,
              ...(resolvedCliPath !== undefined ? { resolvedCliPath } : {}),
            });
            const firstBranchScope = capturedAgent.githubWriteScopes.branchCommits[0];
            const targetRepo = firstBranchScope ? parseRepoKey(firstBranchScope.repo) : undefined;
            // Agents that declare `tools.mcp` in role.md get an MCP tool
            // loader so the runner can spawn their declared MCP servers at
            // wake time and inject the tools into the LLM call. Agents
            // without tools.mcp pay no overhead — loader is lazy per-wake.
            const mcpToolLoader =
              capturedAgent.tools.mcp.length > 0 ? new McpToolLoader() : undefined;
            return {
              ...(wakeClients.llm ? { llm: wakeClients.llm } : {}),
              ...(wakeClients.github ? { github: wakeClients.github } : {}),
              ...(mcpToolLoader ? { mcpToolLoader } : {}),
              ...(targetRepo ? { targetRepo } : {}),
              targetBranch: "main",
            };
          },
        }),
      );
    }
  }

  // Build the effective executor: single executor if only one agent,
  // DispatchExecutor if multiple.
  const effectiveExecutor: AgentExecutor =
    executorMap.size === 1 ? [...executorMap.values()][0]! : new DispatchExecutor(executorMap);

  // Second pass: if we got a github client, rebuild the daemon with
  // an upgraded aggregator. DaemonConfig fields are readonly by
  // design (preventing mid-run mutation), so rebuilding is cheap
  // and honest.
  // Always rebuild the effective daemon when the executor changes
  // (LLM agents) or when a github client becomes available. Only
  // keep the first-pass daemon if neither condition applies — which
  // is the hello-world / no-token path.
  // Merge signal scopes from ALL agents into a single aggregator
  // config. Duplicate repos are OK — the aggregator deduplicates by
  // issue id at the fetch level. The membership-aware `anyLabel`
  // routing set is already derived inside `registeredAgentFromLoadedIdentity`
  // (harness#343 — composition root stays thin, Engineering Standard #8),
  // so this site only translates DTO shapes.
  const githubSignalScopes = allRegistered.flatMap(
    (agent) =>
      agent.signalScopes?.githubScopes?.map((scope) => ({
        repo: makeRepoCoordinate(scope.owner, scope.repo),
        filter: {
          state: scope.filter.state,
          ...(scope.filter.labels !== undefined ? { labels: scope.filter.labels } : {}),
          ...(scope.filter.sinceDays !== undefined
            ? { since: new Date(Date.now() - scope.filter.sinceDays * 86_400_000) }
            : {}),
        },
        ...(scope.filter.anyLabel !== undefined ? { anyLabel: scope.filter.anyLabel } : {}),
        ...(scope.scopeAllTrustedAuthors !== undefined
          ? { scopeAllTrustedAuthors: scope.scopeAllTrustedAuthors }
          : {}),
        ...(scope.dropScopeAllFromUntrusted !== undefined
          ? { dropScopeAllFromUntrusted: scope.dropScopeAllFromUntrusted }
          : {}),
      })) ?? [],
  );

  // Construct governance sync via CollaborationProvider (ADR-0021).
  // Local mode uses LocalCollaborationProvider; GitHub mode builds a
  // GitHubCollaborationProvider from the authenticated client.
  const governanceCollaborationProvider: CollaborationProvider | undefined =
    localCollaborationProvider ??
    (githubClient && allRegistered[0]?.signalScopes?.githubScopes?.[0]
      ? new GitHubCollaborationProvider({
          client: githubClient,
          repo: makeRepoCoordinate(
            allRegistered[0].signalScopes.githubScopes[0].owner,
            allRegistered[0].signalScopes.githubScopes[0].repo,
          ),
        })
      : undefined);

  const governanceSync = governanceCollaborationProvider
    ? new GovernanceGitHubSync({
        provider: governanceCollaborationProvider,
        ...(allRegistered[0]?.groupMemberships[0]
          ? { defaultGroup: allRegistered[0].groupMemberships[0] }
          : {}),
      })
    : undefined;

  // Build the onWakeActions callback — executes structured actions
  // from individual agent wakes against GitHub.
  const onWakeActions: DaemonConfig["onWakeActions"] = async (agentId, actions) => {
    const comp = compositions.find((c) => c.agentId === agentId);
    if (!comp?.github) return [];
    const agent = allRegistered.find((a) => a.agentId === agentId);
    const firstScope = agent?.signalScopes?.githubScopes?.[0];
    if (!firstScope) return [];
    const repo = makeRepoCoordinate(firstScope.owner, firstScope.repo);
    const gh = comp.github;
    const receipts: import("@murmurations-ai/core").WakeActionReceipt[] = [];
    for (const action of actions) {
      try {
        switch (action.kind) {
          case "label-issue": {
            if (!action.issueNumber || !action.label) {
              receipts.push({ action, success: false, error: "missing fields" });
              break;
            }
            // Security H1: agents MUST NOT write Source-reserved routing
            // labels (`source-directive`, `kickoff`, `scope:*`). Refusing
            // here closes the lateral-movement channel opened when the
            // aggregator started listening for `scope:*` (harness#331).
            const reservedLabel = findReservedLabels([action.label]);
            if (reservedLabel.length > 0) {
              receipts.push({
                action,
                success: false,
                error: `reserved-label:${reservedLabel.join(",")}`,
              });
              break;
            }
            if (action.removeLabel) {
              const reservedRemove = findReservedLabels([action.removeLabel]);
              if (reservedRemove.length > 0) {
                receipts.push({
                  action,
                  success: false,
                  error: `reserved-label:${reservedRemove.join(",")}`,
                });
                break;
              }
              await gh.removeLabel(repo, makeIssueNumber(action.issueNumber), action.removeLabel);
            }
            const r = await gh.addLabels(repo, makeIssueNumber(action.issueNumber), [action.label]);
            receipts.push({ action, success: r.ok, ...(!r.ok ? { error: r.error.code } : {}) });
            break;
          }
          case "create-issue": {
            if (!action.title) {
              receipts.push({ action, success: false, error: "missing title" });
              break;
            }
            // Security H1: see label-issue case above.
            if (action.labels && action.labels.length > 0) {
              const reserved = findReservedLabels(action.labels);
              if (reserved.length > 0) {
                receipts.push({
                  action,
                  success: false,
                  error: `reserved-label:${reserved.join(",")}`,
                });
                break;
              }
            }
            const input: Record<string, unknown> = { title: action.title };
            if (action.body) input.body = action.body;
            if (action.labels && action.labels.length > 0) input.labels = [...action.labels];
            const r = await gh.createIssue(
              repo,
              input as { title: string; body?: string; labels?: string[] },
            );
            receipts.push({
              action,
              success: r.ok,
              ...(r.ok ? { issueNumber: r.value.number.value } : { error: r.error.code }),
            });
            break;
          }
          case "close-issue": {
            if (!action.issueNumber) {
              receipts.push({ action, success: false, error: "missing issueNumber" });
              break;
            }
            const r = await gh.updateIssueState(
              repo,
              makeIssueNumber(action.issueNumber),
              "closed",
            );
            receipts.push({ action, success: r.ok, ...(!r.ok ? { error: r.error.code } : {}) });
            break;
          }
          case "comment-issue": {
            if (!action.issueNumber || !action.body) {
              receipts.push({ action, success: false, error: "missing fields" });
              break;
            }
            const r = await gh.createIssueComment(repo, makeIssueNumber(action.issueNumber), {
              body: action.body,
            });
            receipts.push({ action, success: r.ok, ...(!r.ok ? { error: r.error.code } : {}) });
            break;
          }
          case "commit-file": {
            // commit-file requires more context (branch OID); skip for now
            receipts.push({ action, success: false, error: "commit-file not yet wired in daemon" });
            break;
          }
        }
      } catch (err: unknown) {
        receipts.push({
          action,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return receipts;
  };

  // Discover group configs for governance meeting scheduling
  const groupConfigs = await discoverGroupConfigs(exampleRoot);

  // Build onGovernanceMeetingDue callback — invokes group-wake runner
  const onGovernanceMeetingDue: DaemonConfig["onGovernanceMeetingDue"] = async (
    groupId,
    _pendingItems,
  ) => {
    process.stdout.write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        event: "daemon.governance.meeting.invoking",
        groupId,
        pendingItems: _pendingItems.length,
      })}\n`,
    );
    // Dynamic import to avoid circular dependency with group-wake
    const { runGroupWakeCommand } = await import("./group-wake.js");
    await runGroupWakeCommand(
      ["--group", groupId, "--governance", "--root", exampleRoot],
      exampleRoot,
    );
  };

  const agentStateStore = new AgentStateStore({
    persistDir: resolve(exampleRoot, ".murmuration", "agents"),
  });

  const needsRebuild = effectiveExecutor !== provisionalExecutor || githubClient !== undefined;
  const effectiveDaemon: Daemon = needsRebuild
    ? new Daemon({
        executor: effectiveExecutor,
        agents: allRegistered,
        signalAggregator: githubClient
          ? new DefaultSignalAggregator({
              rootDir: exampleRoot,
              github: githubClient,
              githubScopes: githubSignalScopes,
              // v0.7.0 (ADR-0042): tier wakes by priority. The daemon
              // owns the integration; agent role.md doesn't need to
              // know.
              priorityBundle: true,
              // harness#394: see comment on filesystemOnlyAggregator above.
              onBundleMetrics: (m) => {
                logger.info("daemon.signal-bundle.large", {
                  agentId: m.agentId,
                  wakeId: m.wakeId,
                  issueCount: m.issueCount,
                  totalBytes: m.totalBytes,
                  issueThreshold: m.thresholds.issues,
                  byteThreshold: m.thresholds.bytes,
                });
              },
            })
          : filesystemOnlyAggregator,
        runArtifactWriter,
        logger,
        ...(secretsBlock ? { secrets: secretsBlock } : {}),
        ...(governancePlugin ? { governance: governancePlugin } : {}),
        governancePersistDir: resolve(exampleRoot, ".murmuration", "governance"),
        ...(governanceSync ? { governanceSync } : {}),
        agentStateStore,
        onWakeActions,
        ...(groupConfigs.length > 0 ? { groups: groupConfigs, onGovernanceMeetingDue } : {}),
      })
    : firstPassDaemon;
  // below so `murmuration list` shows a readable name per tmux-style socket
  // directory. Fall back to the root's basename if nothing better is available.
  const runningSessionName = exampleRoot.split("/").filter(Boolean).pop() ?? "murmuration";

  const shutdownPromise = new Promise<void>((resolveShutdown) => {
    const shutdown = (signal: NodeJS.Signals): void => {
      void (async () => {
        process.stdout.write(
          `${JSON.stringify({
            ts: new Date().toISOString(),
            level: "info",
            event: "daemon.signal.received",
            signal,
          })}\n`,
        );
        await effectiveDaemon.stop();
        if (!once) unregisterRunningSocket(runningSessionName);
        resolveShutdown();
      })();
    };
    process.once("SIGINT", () => {
      shutdown("SIGINT");
    });
    process.once("SIGTERM", () => {
      shutdown("SIGTERM");
    });
  });

  // Write pidfile — skip for --once/--now wakes (child processes shouldn't clobber the daemon's pid)
  const pidfilePath = resolve(exampleRoot, ".murmuration", "daemon.pid");
  const socketPath = resolve(exampleRoot, ".murmuration", "daemon.sock");
  await mkdir(resolve(exampleRoot, ".murmuration"), { recursive: true });
  if (!once) {
    // Guard against same-machine collision (#219): atomically create the pidfile
    // with O_CREAT|O_EXCL ("wx" flag). If another process created it first we get
    // EEXIST — then we read the stored PID and probe liveness.
    //
    // The atomic O_CREAT|O_EXCL create closes the TOCTOU race that the previous
    // read-then-write had: two concurrent `murmuration start` calls could both
    // observe ENOENT and both fall through to write, ending up with two daemons
    // running against the same root (violating Engineering Standard #3).
    const alreadyRunningError = (existingPid: number): Error => {
      const lines = [
        `murmuration: a daemon is already running for this murmuration.`,
        `  root:   ${exampleRoot}`,
        `  pid:    ${String(existingPid)}`,
        `  socket: ${socketPath}`,
        `  attach: murmuration attach ${runningSessionName}`,
        `  stop:   murmuration stop --root ${exampleRoot}`,
        ``,
        `If you believe this is wrong (e.g. the process crashed without`,
        `cleaning up), remove the stale pidfile manually:`,
        `  rm ${pidfilePath}`,
      ];
      return new Error(lines.join("\n"));
    };

    try {
      // Atomic exclusive create: succeeds only if the file does not already exist.
      const fh = await open(pidfilePath, "wx");
      await fh.writeFile(String(process.pid), "utf8");
      await fh.close();
    } catch (createErr) {
      const code = (createErr as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw createErr;

      // Pidfile already exists — check whether the recorded process is still alive.
      const rawPid = await readFile(pidfilePath, "utf8").catch(() => "");
      const existingPid = Number(rawPid.trim());
      if (Number.isFinite(existingPid) && existingPid > 0) {
        try {
          process.kill(existingPid, 0); // signal 0 = probe only, doesn't kill
          // No throw → process is alive.
          throw alreadyRunningError(existingPid);
        } catch (killErr) {
          const killCode = (killErr as NodeJS.ErrnoException).code;
          if (killCode === "ESRCH") {
            // Process is gone — stale pidfile. Overwrite it.
            logger.info("daemon.pidfile.stale", { existingPid, pidfilePath });
            const fh = await open(pidfilePath, "w");
            await fh.writeFile(String(process.pid), "utf8");
            await fh.close();
          } else if (killCode === "EPERM") {
            // Process exists but is owned by a different OS user — treat as alive.
            throw alreadyRunningError(existingPid);
          } else {
            throw killErr;
          }
        }
      }
    }
  }

  // harness#362: sweep orphaned Spirit MCP config files from prior
  // crashed attach sessions. This previously ran on every attach, which
  // races when two attaches start within the same sub-second window —
  // attach C's sweep could delete attach B's still-live ephemeral file.
  //
  // The sweep belongs HERE — after the pidfile guard above has confirmed
  // this process owns the persistent daemon role, and only in `!once`
  // mode. The sweep is not liveness-aware (it deletes by pattern, which
  // is exactly why per-attach sweeping was racy), so it must never run in
  // a context that coexists with a live attach. A `murmuration start
  // --now/--once` immediate wake runs as a SEPARATE short-lived process
  // alongside the real daemon and an operator's interactive attach; if
  // the sweep ran before the `!once` guard it would delete that live
  // attach's config out from under it. By gating on `!once` and placing
  // it after pidfile acquisition, only the one process that legitimately
  // owns the daemon — and at a moment no attach can be in-flight, since
  // attach hard-exits without a bound socket — performs the cleanup.
  // Per-attach code now only WRITES; cleanup is the daemon's job.
  if (!once) {
    sweepOrphanedSpiritMcpConfigs(exampleRoot);
  }

  // Start daemon control socket
  // socketPath declared above alongside pidfilePath (collision check needs it)
  // ~/.murmuration/sockets/ directory so `murmuration list` can find it.
  if (!once) {
    registerRunningSocket(runningSessionName, socketPath);
  }
  const govPersistDir = resolve(exampleRoot, ".murmuration", "governance");

  // Command executor — owns command dispatch, status building, and detail handlers
  // (extracted from boot.ts per Engineering Standard #8)
  const { DaemonCommandExecutor } = await import("@murmurations-ai/core");

  // Resolve the repo coordinate for both GitHub collaboration and the
  // command-executor's status/issue-listing path. Try harness.yaml's
  // `collaboration.repo` first (explicit operator config), then fall
  // back to searching ALL registered agents for github_scopes (not
  // just the first — agents are loaded alphabetically and the first
  // one may not have scopes declared).
  const firstScope = allRegistered[0]?.signalScopes?.githubScopes?.[0];
  let repoCoord: { owner: string; repo: string } | undefined = firstScope
    ? { owner: firstScope.owner, repo: firstScope.repo }
    : undefined;
  if (!repoCoord && config.collaboration.repo) {
    const parts = config.collaboration.repo.split("/");
    if (parts.length === 2 && parts[0] && parts[1]) {
      repoCoord = { owner: parts[0], repo: parts[1] };
    }
  }
  if (!repoCoord) {
    for (const agent of allRegistered) {
      const scope = agent.signalScopes?.githubScopes?.[0];
      if (scope) {
        repoCoord = { owner: scope.owner, repo: scope.repo };
        break;
      }
    }
  }

  // Wire a CollaborationProvider for the daemon's command-executor
  // paths (:directive list, directive.close, etc.). Local mode already
  // constructs `localCollaborationProvider` earlier in boot. GitHub
  // mode needs the same — without it, :directive list fails with
  // "No collaboration provider configured" even though the murmuration
  // is clearly configured for GitHub. v0.5.0 tester feedback.
  let githubCollaborationProvider:
    | import("@murmurations-ai/core").CollaborationProvider
    | undefined;
  if (collaborationMode === "github" && githubClient && repoCoord) {
    const { GitHubCollaborationProvider } = await import("@murmurations-ai/core");
    githubCollaborationProvider = new GitHubCollaborationProvider({
      client: githubClient,
      repo: makeRepoCoordinate(repoCoord.owner, repoCoord.repo),
    });
    logger.info("daemon.collaboration.provider", {
      provider: "github",
      repo: `${repoCoord.owner}/${repoCoord.repo}`,
    });
  } else if (collaborationMode === "github") {
    // Diagnostic: explain why the GitHub collaboration provider didn't
    // wire up so operators aren't staring at "No collaboration provider
    // configured" with no hint of what to fix.
    logger.warn("daemon.collaboration.provider.skipped", {
      reason: !githubClient
        ? "no GITHUB_TOKEN in .env"
        : !repoCoord
          ? "no collaboration.repo in harness.yaml and no agent github_scopes"
          : "unknown",
      collaborationMode,
    });
  }
  const commandCollaborationProvider = localCollaborationProvider ?? githubCollaborationProvider;
  const executor = new DaemonCommandExecutor({
    rootDir: exampleRoot,
    agentStateStore,
    allRegistered,
    governancePlugin,
    governancePersistDir: govPersistDir,
    ...(governancePath ? { governancePath } : {}),
    ...(governanceSync
      ? {
          governanceSync: {
            onCreate: (item) => governanceSync.onCreate(item),
            onTransition: (item, trans, isTerminal) => {
              void governanceSync.onTransition(item, trans, isTerminal);
            },
          },
        }
      : {}),
    eventBus,
    ...(commandCollaborationProvider
      ? { collaborationProvider: commandCollaborationProvider }
      : {}),
    ...(githubClient && repoCoord
      ? {
          repoCoordinate: repoCoord,
          githubClient: {
            listIssues: async (repo, filter) => {
              const result = await githubClient.listIssues(
                makeRepoCoordinate(repo.owner, repo.repo),
                {
                  ...(filter?.state ? { state: filter.state } : {}),
                  ...(filter?.labels ? { labels: [...filter.labels] } : {}),
                  ...(filter?.perPage ? { perPage: filter.perPage } : {}),
                },
              );
              if (!result.ok) return { ok: false as const };
              return {
                ok: true as const,
                value: result.value.map((i) => ({
                  number: i.number.value,
                  title: i.title,
                  htmlUrl: i.htmlUrl,
                  state: i.state,
                  labels: i.labels,
                  createdAt: i.createdAt,
                })),
              };
            },
          },
        }
      : {}),
    // Inject CLI command handlers (keeps core free of CLI imports)
    onDirective: async (args, rootDir) => {
      const { runDirective } = await import("./directive.js");
      await runDirective(args, rootDir);
    },
    onGroupWake: async (args, rootDir) => {
      const { runGroupWakeCommand } = await import("./group-wake.js");
      return runGroupWakeCommand(args, rootDir);
    },
    onWakeNow: async (rootDir, agentId) => {
      const { spawn: cpSpawn } = await import("node:child_process");
      const { openSync: openF, mkdirSync } = await import("node:fs");
      const { wakeLogPath } = await import("@murmurations-ai/core");
      const binPath = resolve(dirname(import.meta.url.replace("file://", "")), "bin.js");
      const logPath = wakeLogPath(rootDir, agentId);
      mkdirSync(dirname(logPath), { recursive: true });
      const child = cpSpawn(
        process.execPath,
        [binPath, "start", "--root", rootDir, "--agent", agentId, "--now"],
        { detached: true, stdio: ["ignore", openF(logPath, "a"), openF(logPath, "a")] },
      );
      child.on("exit", (code) => {
        eventBus.emit({
          kind: "wake.completed",
          agentId,
          wakeId: `now-${agentId}`,
          outcome: code === 0 ? "completed" : "failed",
          artifactCount: 0,
        });
      });
      child.unref();
      return { pid: child.pid ?? 0 };
    },
  });

  // readGovernanceStatus, buildStatus, agentDetailHandler, groupDetailHandler,
  // and commandHandler are now in DaemonCommandExecutor.

  // Shared status builder for socket + HTTP
  // buildStatus is now in DaemonCommandExecutor

  const daemonSocket = new DaemonSocket(socketPath, (method, params) => {
    if (method === "status") return executor.buildStatus();
    return executor.execute(method, params);
  });
  if (!once) {
    daemonSocket.start();
  }

  // Start HTTP server for web dashboard (SSE events + REST API).
  // Mint a per-daemon auth token and persist to .murmuration/dashboard.token
  // (0600) so only the operator account can read it. API clients present
  // it via `?token=<value>` or `X-Murmuration-Token` header.
  const httpPort = parseInt(process.env.MURMURATION_HTTP_PORT ?? "0", 10);
  let dashboardToken: string | undefined;
  if (httpPort > 0 && !once) {
    const { randomBytes, writeFileSync } = await import("node:fs").then(async (fs) => ({
      randomBytes: (await import("node:crypto")).randomBytes,
      writeFileSync: fs.writeFileSync,
    }));
    dashboardToken = randomBytes(24).toString("base64url");
    const tokenPath = resolve(exampleRoot, ".murmuration", "dashboard.token");
    writeFileSync(tokenPath, dashboardToken + "\n", { mode: 0o600 });
  }
  const daemonHttp =
    httpPort > 0 && !once && dashboardToken !== undefined
      ? new DaemonHttp({
          port: httpPort,
          statusHandler: () => executor.buildStatus(),
          agentDetailHandler: (agentId) => executor.agentDetail(agentId),
          groupDetailHandler: (groupId) => executor.groupDetail(groupId),
          commandHandler: (method, params) => executor.execute(method, params),
          eventBus,
          authToken: dashboardToken,
        })
      : null;
  if (daemonHttp) {
    daemonHttp.start();
    process.stdout.write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        event: "daemon.http.started",
        port: httpPort,
        dashboard_url: `http://127.0.0.1:${String(httpPort)}/dashboard?token=${dashboardToken ?? ""}`,
      })}\n`,
    );
  }

  // Clean up pidfile + socket + http on exit
  const cleanupPid = (): void => {
    try {
      unlinkSync(pidfilePath);
    } catch {
      /* best effort */
    }
    daemonSocket.stop();
    daemonHttp?.stop();
  };
  process.on("exit", cleanupPid);

  effectiveDaemon.start();

  // Session heartbeat — update registry so `list` can detect alive daemons
  if (!once) {
    const { heartbeatSession } = await import("./sessions.js");
    heartbeatSession(exampleRoot); // initial heartbeat
    const heartbeatInterval = setInterval(() => {
      heartbeatSession(exampleRoot);
    }, 60_000);
    heartbeatInterval.unref(); // don't prevent process exit
  }

  if (once) {
    // --once mode: wait for ANY agent to produce a NEW run artifact
    // since the daemon started, then stop the daemon and exit.
    //
    // Bug fix 2026-05-04: previously this checked "any agent's
    // index.jsonl has any content" — which fired immediately when
    // prior wakes had already populated the file, shutting the
    // daemon down 2s into the new wake. The in-flight subscription-
    // CLI subprocess (claude) needed the daemon's MCP socket; the
    // daemon shutdown closed the socket; claude hung waiting for
    // tool responses that never came; wake timed out at 120s with
    // empty content. We now snapshot each file's byte count at
    // start and wait for growth.
    const indexPaths = allRegistered.map((a) =>
      resolve(exampleRoot, "runs", a.agentId, "index.jsonl"),
    );
    const baselineBytes = new Map<string, number>();
    for (const p of indexPaths) {
      try {
        const contents = await readFile(p, "utf8");
        baselineBytes.set(p, contents.length);
      } catch {
        baselineBytes.set(p, 0);
      }
    }
    const pollIntervalMs = 2000;
    const maxWaitMs = 300_000; // 5 minutes hard ceiling
    const startedAt = Date.now();
    while (Date.now() - startedAt < maxWaitMs) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      let anyNewArtifact = false;
      for (const p of indexPaths) {
        try {
          const contents = await readFile(p, "utf8");
          const baseline = baselineBytes.get(p) ?? 0;
          if (contents.length > baseline) {
            anyNewArtifact = true;
            break;
          }
        } catch {
          // file not written yet — also counts as no new artifact
        }
      }
      if (anyNewArtifact) break;
    }
    process.stdout.write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        event: "daemon.once.stopping",
        reason: "new wake artifact detected since daemon start (or 5-minute ceiling reached)",
      })}\n`,
    );
    await effectiveDaemon.stop();
  } else {
    await shutdownPromise;
  }

  process.stdout.write(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      event: "daemon.exit",
    })}\n`,
  );
  // Force the process to exit. Without this, open servers (Unix
  // domain socket, HTTP dashboard) keep the event loop alive and
  // the daemon logs "exit" but never actually terminates — SIGTERM
  // appears not to kill it. v0.5.0 tester feedback: "SIGTERM never
  // completely shuts down a murmuration."
  process.exit(0);
};

/**
 * Phase 1A / 1B entry point — preserved as a thin alias over
 * {@link bootDaemon} so existing call sites and docs keep working.
 */
export const bootHelloWorldDaemon = async (): Promise<void> => {
  await bootDaemon();
};
