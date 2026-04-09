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
  registeredAgentFromLoadedIdentity,
  type DaemonConfig,
  type RegisteredAgent,
  type SignalAggregator,
  type SubprocessCommand,
  type WakeTrigger,
} from "@murmuration/core";
import { createGithubClient, type GithubClient } from "@murmuration/github";
import { DotenvSecretsProvider } from "@murmuration/secrets-dotenv";
import { DefaultSignalAggregator } from "@murmuration/signals";

const GITHUB_TOKEN = makeSecretKey("GITHUB_TOKEN");

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

  const secretsBlock: DaemonConfig["secrets"] | undefined = provider
    ? {
        provider,
        declaration: {
          required: [],
          // GITHUB_TOKEN is optional — if absent the github signal source
          // is skipped. This keeps the gate test runnable on any machine.
          optional: [GITHUB_TOKEN],
        },
      }
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
