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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  AgentStateStore,
  Daemon,
  DispatchExecutor,
  GovernanceGitHubSync,
  DaemonHttp,
  DaemonSocket,
  HARNESS_VERSION,
  DispatchRunArtifactWriter,
  IdentityLoader,
  InProcessExecutor,
  RunArtifactWriter,
  SubprocessExecutor,
  makeSecretKey,
  makeUSDMicros,
  registeredAgentFromLoadedIdentity,
  type AgentExecutor,
  type AgentRunner,
  type BudgetCeiling,
  type DaemonConfig,
  type RegisteredAgent,
  type SecretDeclaration,
  type SecretKey,
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
  ProviderRegistry,
  type LLMClient,
  type LLMCostHook,
} from "@murmurations-ai/llm";
import { resolveLLMCost } from "@murmurations-ai/llm/pricing";
import { DotenvSecretsProvider } from "@murmurations-ai/secrets-dotenv";
import { DefaultSignalAggregator } from "@murmurations-ai/signals";

import { buildMemoryToolsForAgent } from "./memory/index.js";

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
 */
export const makeDaemonHook = (builder: WakeCostBuilder): LLMCostHook => ({
  onLlmCall: (call) => {
    const priced = resolveLLMCost({
      provider: call.provider,
      model: call.model,
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      ...(call.cacheReadTokens !== undefined ? { cacheReadTokens: call.cacheReadTokens } : {}),
      ...(call.cacheWriteTokens !== undefined ? { cacheWriteTokens: call.cacheWriteTokens } : {}),
    });
    // Pricing errors (unknown model, negative tokens) degrade to a
    // zero-cost record — the token counts still post to the builder,
    // the observability event still fires, and the boot-time warn
    // catches misconfiguration before a real wake. Hard-failing here
    // would swallow a successful LLM call on a pricing catalog gap.
    const costMicros = priced.ok ? priced.value : makeUSDMicros(0);
    builder.addLlmTokens({
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      ...(call.cacheReadTokens !== undefined ? { cacheReadTokens: call.cacheReadTokens } : {}),
      ...(call.cacheWriteTokens !== undefined ? { cacheWriteTokens: call.cacheWriteTokens } : {}),
      modelProvider: call.provider,
      modelName: call.model,
      costMicros,
    });
  },
});

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
  agent,
  provider,
  providerRegistry,
  costBuilder,
  dryRun,
  ollamaBaseUrl,
}: BuildAgentClientsArgs): BuildAgentClientsResult => {
  const result: {
    llm?: LLMClient;
    github?: GithubClient;
    llmSkipReason?: string;
    githubSkipReason?: string;
  } = {};

  if (agent.llm) {
    const providerDef = providerRegistry.get(agent.llm.provider);
    if (!providerDef) {
      result.llmSkipReason = `provider "${agent.llm.provider}" is not registered`;
    } else {
      const resolvedModel =
        agent.llm.model ?? providerRegistry.resolveModelForTier(agent.llm.provider, "balanced");
      if (!resolvedModel) {
        result.llmSkipReason = `no model for provider "${agent.llm.provider}" (pin role.md llm.model)`;
      } else {
        const costHook = costBuilder ? makeDaemonHook(costBuilder) : undefined;
        if (providerDef.envKeyName === null) {
          // Keyless provider (e.g. local Ollama).
          result.llm = createLLMClient({
            registry: providerRegistry,
            provider: agent.llm.provider,
            model: resolvedModel,
            token: null,
            ...(ollamaBaseUrl !== undefined ? { baseUrl: ollamaBaseUrl } : {}),
            ...(costHook !== undefined ? { defaultCostHook: costHook } : {}),
          });
        } else if (provider?.has(makeSecretKey(providerDef.envKeyName)) === true) {
          const token = provider.get(makeSecretKey(providerDef.envKeyName));
          result.llm = createLLMClient({
            registry: providerRegistry,
            provider: agent.llm.provider,
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

  if (hasAnyWriteScope(agent)) {
    if (dryRun) {
      if (provider?.has(GITHUB_TOKEN) === true) {
        result.github = createGithubClient({
          token: provider.get(GITHUB_TOKEN),
          ...(githubCostHook ? { defaultCostHook: githubCostHook } : {}),
        });
      }
      // dry-run never sets githubSkipReason; the caller logs the dryRun event.
    } else if (provider?.has(GITHUB_TOKEN) === true) {
      result.github = createGithubClient({
        token: provider.get(GITHUB_TOKEN),
        writeScopes: toClientWriteScopes(agent),
        ...(githubCostHook ? { defaultCostHook: githubCostHook } : {}),
      });
    } else {
      result.githubSkipReason = "GITHUB_TOKEN absent; write-scoped client not constructed";
    }
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

  // Load governance plugin — from merged config (CLI > harness.yaml > default)
  const governancePath = config.governance.plugin;
  let governancePlugin: import("@murmurations-ai/core").GovernancePlugin | undefined;
  if (governancePath) {
    // Try as npm package first (e.g. "@murmurations-ai/governance-s3"),
    // then as file path relative to murmuration root, then cwd.
    let mod: { default?: unknown };
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
    const candidate: unknown = mod.default;
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      typeof (candidate as { name?: unknown }).name !== "string" ||
      typeof (candidate as { onEventsEmitted?: unknown }).onEventsEmitted !== "function"
    ) {
      process.stderr.write(
        `murmuration: governance module at ${governancePath} must export a GovernancePlugin as default\n`,
      );
      process.exit(78);
    }
    governancePlugin = candidate as import("@murmurations-ai/core").GovernancePlugin;
    process.stdout.write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        event: "daemon.governance.loaded",
        plugin: governancePlugin.name,
        version: governancePlugin.version,
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
      logger.warn("daemon.agent.fallback", {
        agentDir,
        reason: reason.reason,
        missingFiles: reason.missingFiles,
        ...(reason.detail !== undefined ? { detail: reason.detail } : {}),
      });
    },
  });

  // -------------------------------------------------------------------
  // Agent discovery: when --agent is set, boot one; when omitted, boot
  // every agent found in <root>/agents/*/role.md.
  // -------------------------------------------------------------------

  let agentDirs: readonly string[];
  if (options.agentDir !== undefined) {
    agentDirs = [options.agentDir];
  } else if (options.rootDir !== undefined) {
    // Explicit --root without --agent → discover all agents.
    agentDirs = await loader.discover();
    if (agentDirs.length === 0) {
      process.stderr.write(
        `murmuration: no agents found in ${resolve(exampleRoot, "agents")}/*/ (looking for role.md)\n`,
      );
      process.exit(78);
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

  // Load identities + build triggers for every agent.
  const allRegistered: RegisteredAgent[] = [];
  for (const agentDir of agentDirs) {
    const loaded = await loader.load(agentDir);
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

  // Per-agent run artifact writers (2D5). Each agent gets its own
  // writer at `<rootDir>/.murmuration/runs/<agentId>/`.
  const writerMap = new Map<string, RunArtifactWriter>();
  for (const agent of allRegistered) {
    writerMap.set(
      agent.agentId,
      new RunArtifactWriter({
        rootDir: resolve(exampleRoot, ".murmuration", "runs", agent.agentId),
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
      process.exit(78);
    }
    if (provider.has(GITHUB_TOKEN)) {
      githubClient = createGithubClient({ token: provider.get(GITHUB_TOKEN) });
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
   * Local-governance auto-include: when the murmuration uses the local
   * `CollaborationProvider`, agents need file access to record
   * governance artifacts (proposals, decisions, tensions). Without
   * file-writes they can't participate in governance. So we auto-grant
   * the built-in `files` plugin to every agent that has declared any
   * plugins at all — the agent still sees their other declared plugins
   * explicitly; we just add `files` on top. Empty declaration still
   * gets everything via the backward-compat path.
   */
  const selectExtensionToolsFor = (
    agent: RegisteredAgent,
    agentDir: string,
  ): readonly (typeof extensionTools)[number][] => {
    // ADR-0029: memory is agent-scoped — tools are built per-agent,
    // not shared across agents. Emit them whenever the agent declared
    // memory explicitly OR when local-gov auto-includes them.
    const buildAgentBoundMemory = (): readonly (typeof extensionTools)[number][] =>
      buildMemoryToolsForAgent({
        rootDir: exampleRoot,
        agentDir,
      }) as readonly (typeof extensionTools)[number][];

    if (agent.plugins.length === 0) {
      // Backward compat: agents with no explicit declaration see the
      // shared extension tools. Memory is agent-bound so we add
      // per-agent tools on top only when local-gov makes it
      // automatic.
      if (config.collaboration.provider === "local") {
        return [...extensionTools, ...buildAgentBoundMemory()];
      }
      return extensionTools;
    }

    const declared = new Set<string>();
    for (const p of agent.plugins) {
      declared.add(p.provider);
      const parts = p.provider.split("/");
      const last = parts[parts.length - 1];
      if (last !== undefined && parts.length > 1) declared.add(last);
    }
    if (config.collaboration.provider === "local") {
      declared.add("files");
      declared.add("@murmurations-ai/files");
      declared.add("memory");
      declared.add("@murmurations-ai/memory");
    }

    const sharedTools = loadedExtensions
      .filter((ext) => declared.has(ext.id))
      .flatMap((ext) => ext.tools);

    // Attach per-agent memory tools if the memory plugin is declared
    // (either explicitly or via the local-gov auto-include above).
    if (declared.has("memory") || declared.has("@murmurations-ai/memory")) {
      return [...sharedTools, ...buildAgentBoundMemory()];
    }
    return sharedTools;
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
                agentTools.length > 0 ? { extensionTools: agentTools } : {},
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
            });
            const firstBranchScope = capturedAgent.githubWriteScopes.branchCommits[0];
            const targetRepo = firstBranchScope ? parseRepoKey(firstBranchScope.repo) : undefined;
            return {
              ...(wakeClients.llm ? { llm: wakeClients.llm } : {}),
              ...(wakeClients.github ? { github: wakeClients.github } : {}),
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
  // config. Duplicate repos are OK — the aggregator deduplicates at
  // the fetch level (same URL = same cache entry).
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
      })) ?? [],
  );

  // Construct governance sync — prefer CollaborationProvider (ADR-0021), fall back to GitHub
  const governanceSync = localCollaborationProvider
    ? new GovernanceGitHubSync({
        provider: localCollaborationProvider,
        ...(allRegistered[0]?.groupMemberships[0]
          ? { defaultGroup: allRegistered[0].groupMemberships[0] }
          : {}),
      })
    : githubClient
      ? new GovernanceGitHubSync({
          github: {
            createIssue: async (input) => {
              const result = await githubClient.createIssue(
                makeRepoCoordinate(
                  allRegistered[0]?.signalScopes?.githubScopes?.[0]?.owner ?? "unknown",
                  allRegistered[0]?.signalScopes?.githubScopes?.[0]?.repo ?? "unknown",
                ),
                { title: input.title, body: input.body, labels: [...input.labels] },
              );
              if (!result.ok) return { ok: false, error: result.error.message };
              return {
                ok: true,
                issueNumber: result.value.number.value,
                htmlUrl: result.value.htmlUrl,
              };
            },
            createIssueComment: async (issueNumber, body) => {
              const result = await githubClient.createIssueComment(
                makeRepoCoordinate(
                  allRegistered[0]?.signalScopes?.githubScopes?.[0]?.owner ?? "unknown",
                  allRegistered[0]?.signalScopes?.githubScopes?.[0]?.repo ?? "unknown",
                ),
                makeIssueNumber(issueNumber),
                { body },
              );
              if (!result.ok) return { ok: false, error: result.error.message };
              return { ok: true };
            },
            addLabels: async (issueNumber, labels) => {
              const repo = makeRepoCoordinate(
                allRegistered[0]?.signalScopes?.githubScopes?.[0]?.owner ?? "unknown",
                allRegistered[0]?.signalScopes?.githubScopes?.[0]?.repo ?? "unknown",
              );
              const result = await githubClient.addLabels(repo, makeIssueNumber(issueNumber), [
                ...labels,
              ]);
              if (!result.ok) return { ok: false, error: result.error.message };
              return { ok: true };
            },
            removeLabels: async (issueNumber, labels) => {
              const repo = makeRepoCoordinate(
                allRegistered[0]?.signalScopes?.githubScopes?.[0]?.owner ?? "unknown",
                allRegistered[0]?.signalScopes?.githubScopes?.[0]?.repo ?? "unknown",
              );
              for (const label of labels) {
                await githubClient.removeLabel(repo, makeIssueNumber(issueNumber), label);
              }
              return { ok: true };
            },
            closeIssue: async (issueNumber) => {
              const repo = makeRepoCoordinate(
                allRegistered[0]?.signalScopes?.githubScopes?.[0]?.owner ?? "unknown",
                allRegistered[0]?.signalScopes?.githubScopes?.[0]?.repo ?? "unknown",
              );
              const result = await githubClient.updateIssueState(
                repo,
                makeIssueNumber(issueNumber),
                "closed",
              );
              if (!result.ok) return { ok: false, error: result.error.message };
              return { ok: true };
            },
          },
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
            if (action.removeLabel) {
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
  await mkdir(resolve(exampleRoot, ".murmuration"), { recursive: true });
  if (!once) {
    await writeFile(pidfilePath, String(process.pid), "utf8");
  }

  // Start daemon control socket
  const socketPath = resolve(exampleRoot, ".murmuration", "daemon.sock");
  const govPersistDir = resolve(exampleRoot, ".murmuration", "governance");

  // Command executor — owns command dispatch, status building, and detail handlers
  // (extracted from boot.ts per Engineering Standard #8)
  const { DaemonCommandExecutor } = await import("./command-executor.js");
  const firstScope = allRegistered[0]?.signalScopes?.githubScopes?.[0];
  const repoCoord = firstScope ? { owner: firstScope.owner, repo: firstScope.repo } : undefined;
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
    ...(localCollaborationProvider ? { collaborationProvider: localCollaborationProvider } : {}),
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
      const { openSync: openF } = await import("node:fs");
      const binPath = resolve(dirname(import.meta.url.replace("file://", "")), "bin.js");
      const logPath = join(rootDir, ".murmuration", `wake-${agentId}.log`);
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

  // Start HTTP server for web dashboard (SSE events + REST API)
  const httpPort = parseInt(process.env.MURMURATION_HTTP_PORT ?? "0", 10);
  const daemonHttp =
    httpPort > 0 && !once
      ? new DaemonHttp({
          port: httpPort,
          statusHandler: () => executor.buildStatus(),
          agentDetailHandler: (agentId) => executor.agentDetail(agentId),
          groupDetailHandler: (groupId) => executor.groupDetail(groupId),
          commandHandler: (method, params) => executor.execute(method, params),
          eventBus,
        })
      : null;
  // All handlers are now in DaemonCommandExecutor (command-executor.ts).
  if (daemonHttp) {
    daemonHttp.start();
    process.stdout.write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        event: "daemon.http.started",
        port: httpPort,
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
    // --once mode: wait for ANY agent's first wake to produce a run
    // artifact, then stop the daemon and exit. We detect completion by
    // polling each agent's index.jsonl.
    const indexPaths = allRegistered.map((a) =>
      resolve(exampleRoot, ".murmuration", "runs", a.agentId, "index.jsonl"),
    );
    const pollIntervalMs = 2000;
    const maxWaitMs = 300_000; // 5 minutes hard ceiling
    const startedAt = Date.now();
    while (Date.now() - startedAt < maxWaitMs) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      let anyArtifact = false;
      for (const p of indexPaths) {
        try {
          const contents = await readFile(p, "utf8");
          if (contents.trim().length > 0) {
            anyArtifact = true;
            break;
          }
        } catch {
          // file not written yet
        }
      }
      if (anyArtifact) break;
    }
    process.stdout.write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        event: "daemon.once.stopping",
        reason: "first wake artifact detected (or 5-minute ceiling reached)",
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
};

/**
 * Phase 1A / 1B entry point — preserved as a thin alias over
 * {@link bootDaemon} so existing call sites and docs keep working.
 */
export const bootHelloWorldDaemon = async (): Promise<void> => {
  await bootDaemon();
};
