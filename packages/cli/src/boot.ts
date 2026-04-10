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

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Daemon,
  IdentityLoader,
  SubprocessExecutor,
  makeSecretKey,
  makeUSDMicros,
  registeredAgentFromLoadedIdentity,
  type BudgetCeiling,
  type DaemonConfig,
  type RegisteredAgent,
  type SecretDeclaration,
  type SecretKey,
  type SignalAggregator,
  type SubprocessCommand,
  type WakeCostBuilder,
  type WakeTrigger,
} from "@murmuration/core";
import { createGithubClient, type GithubClient, type GithubWriteScopes } from "@murmuration/github";
import { createLLMClient, type LLMClient, type LLMCostHook } from "@murmuration/llm";
import { resolveLLMCost } from "@murmuration/llm/pricing";
import { DotenvSecretsProvider } from "@murmuration/secrets-dotenv";
import { DefaultSignalAggregator } from "@murmuration/signals";

const GITHUB_TOKEN = makeSecretKey("GITHUB_TOKEN");

/**
 * Map each LLM provider to the dotenv key expected for its API token.
 * Ollama needs no key (`null`). These are used by the boot path to
 * union the correct optional keys into the daemon's SecretDeclaration
 * based on the registered agents' `llm` pins per ADR-0016.
 */
const PROVIDER_SECRET_KEY: Record<"gemini" | "anthropic" | "openai" | "ollama", string | null> = {
  gemini: "GEMINI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  ollama: null,
};

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
 * Map `RegisteredAgent.githubWriteScopes` (ADR-0016 camelCase) to the
 * `@murmuration/github` `GithubWriteScopes` shape (ADR-0017 §4). The
 * `issues` field doesn't exist yet in ADR-0016 — tracked as CF-github-I;
 * for now we always pass an empty `issues: []` which makes
 * `createIssue` default-deny until ADR-0016 is amended.
 */
const toClientWriteScopes = (agent: RegisteredAgent): GithubWriteScopes => ({
  issueComments: agent.githubWriteScopes.issueComments,
  branchCommits: agent.githubWriteScopes.branchCommits.map((b) => ({
    repo: b.repo,
    paths: b.paths,
  })),
  labels: agent.githubWriteScopes.labels,
  issues: [], // CF-github-I
});

/**
 * True if the agent declares any write surface at all. Used to decide
 * whether to construct a per-agent GithubClient with writeScopes set,
 * or fall back to the daemon-global read-only client.
 */
const hasAnyWriteScope = (agent: RegisteredAgent): boolean => {
  const s = agent.githubWriteScopes;
  return s.issueComments.length > 0 || s.branchCommits.length > 0 || s.labels.length > 0;
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
const buildSecretDeclaration = (agents: readonly RegisteredAgent[]): SecretDeclaration => {
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
      const keyName = PROVIDER_SECRET_KEY[agent.llm.provider];
      if (keyName !== null && !required.has(keyName)) {
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
 * Boot the daemon, run until SIGINT/SIGTERM, then shut down cleanly.
 */
export const bootHelloWorldDaemon = async (): Promise<void> => {
  const exampleRoot = resolveExampleRoot();
  const agentScriptPath = resolve(exampleRoot, "agent.mjs");

  const loader = new IdentityLoader({ rootDir: exampleRoot });
  const loaded = await loader.load("hello-world");

  // Phase 1B default trigger: delay-once. The identity loader already
  // parses `wake_schedule.delayMs` from frontmatter but does not yet own
  // trigger construction; that's Phase 2 scope.
  const trigger: WakeTrigger = { kind: "delay-once", delayMs: 2000 };

  const registered: RegisteredAgent = registeredAgentFromLoadedIdentity(loaded, trigger);

  const executor = new SubprocessExecutor({
    resolveCommand: (context): SubprocessCommand => {
      if (context.agentId.value !== "hello-world") {
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

  // Unioned declaration across every registered agent, per ADR-0010 /
  // ADR-0016. For hello-world this collapses to `{ required: [],
  // optional: [GITHUB_TOKEN] }` — identical to the pre-2D behavior.
  const agents: readonly RegisteredAgent[] = [registered];
  const declaration = buildSecretDeclaration(agents);

  const secretsBlock: DaemonConfig["secrets"] | undefined = provider
    ? { provider, declaration }
    : undefined;

  // First pass: construct a daemon with the filesystem-only aggregator
  // and load secrets. If GITHUB_TOKEN is present after load, rebuild
  // with an upgraded aggregator that includes the github client.
  const filesystemOnlyAggregator: SignalAggregator = new DefaultSignalAggregator({
    rootDir: exampleRoot,
  });

  const firstPassDaemon = new Daemon({
    executor,
    agents: [registered],
    signalAggregator: filesystemOnlyAggregator,
    ...(secretsBlock ? { secrets: secretsBlock } : {}),
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
  for (const agent of agents) {
    let llmClient: LLMClient | undefined;
    if (agent.llm) {
      const keyName = PROVIDER_SECRET_KEY[agent.llm.provider];
      if (agent.llm.provider === "ollama") {
        llmClient = createLLMClient({
          provider: "ollama",
          token: null,
          ...(agent.llm.model !== undefined ? { model: agent.llm.model } : {}),
          ...(ollamaBaseUrl !== undefined ? { baseUrl: ollamaBaseUrl } : {}),
        });
      } else if (keyName !== null && provider?.has(makeSecretKey(keyName)) === true) {
        const token = provider.get(makeSecretKey(keyName));
        llmClient = createLLMClient({
          provider: agent.llm.provider,
          token,
          ...(agent.llm.model !== undefined ? { model: agent.llm.model } : {}),
        });
      } else {
        process.stdout.write(
          `${JSON.stringify({
            ts: new Date().toISOString(),
            level: "warn",
            event: "daemon.compose.llm.skipped",
            agentId: agent.agentId,
            provider: agent.llm.provider,
            reason: "provider api key missing from secrets",
          })}\n`,
        );
      }
    }

    let agentGithub: GithubClient | undefined;
    if (hasAnyWriteScope(agent)) {
      if (provider?.has(GITHUB_TOKEN) === true) {
        agentGithub = createGithubClient({
          token: provider.get(GITHUB_TOKEN),
          writeScopes: toClientWriteScopes(agent),
        });
      } else {
        process.stdout.write(
          `${JSON.stringify({
            ts: new Date().toISOString(),
            level: "warn",
            event: "daemon.compose.github.skipped",
            agentId: agent.agentId,
            reason: "GITHUB_TOKEN absent; write-scoped client not constructed",
          })}\n`,
        );
      }
    }

    const budgetCeiling = toBudgetCeiling(agent);

    compositions.push({
      agentId: agent.agentId,
      ...(llmClient ? { llm: llmClient } : {}),
      ...(agentGithub ? { github: agentGithub } : {}),
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
              instantiated: llmClient !== undefined,
            }
          : null,
        githubWriteScoped: agentGithub !== undefined,
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
  }

  // Second pass: if we got a github client, rebuild the daemon with
  // an upgraded aggregator. DaemonConfig fields are readonly by
  // design (preventing mid-run mutation), so rebuilding is cheap
  // and honest.
  const effectiveDaemon: Daemon = githubClient
    ? new Daemon({
        executor,
        agents: [registered],
        signalAggregator: new DefaultSignalAggregator({
          rootDir: exampleRoot,
          github: githubClient,
          // No scopes configured by default — adopters set this via
          // real murmuration config. Hello-world leaves it empty so
          // the aggregator exercises filesystem sources only.
          githubScopes: [],
        }),
        ...(secretsBlock ? { secrets: secretsBlock } : {}),
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

  effectiveDaemon.start();

  await shutdownPromise;

  process.stdout.write(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      event: "daemon.exit",
    })}\n`,
  );
};

/**
 * Resolve the absolute path to `<repo-root>/examples/hello-world-agent/`.
 */
const resolveExampleRoot = (): string => {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "..", "..", "..");
  return resolve(repoRoot, "examples", "hello-world-agent");
};
