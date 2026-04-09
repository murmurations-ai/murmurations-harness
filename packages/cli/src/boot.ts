/**
 * Phase 1B daemon boot — wires SubprocessExecutor + TimerScheduler +
 * Daemon around the hello-world agent whose identity is read from
 * disk via IdentityLoader.
 *
 * Changed from Phase 1A: the identity chain (murmuration soul, agent
 * soul, agent role, circle contexts) is no longer hardcoded inline.
 * The CLI now resolves the example directory, loads the identity via
 * `@murmuration/core/identity`, and constructs a RegisteredAgent from
 * the result. This closes CF-1 from the Engineering Lead #22 Phase 1A
 * gate review (issue #6).
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Daemon,
  IdentityLoader,
  SubprocessExecutor,
  registeredAgentFromLoadedIdentity,
  type RegisteredAgent,
  type SubprocessCommand,
  type WakeTrigger,
} from "@murmuration/core";

/**
 * Boot the daemon, run until SIGINT/SIGTERM, then shut down cleanly.
 */
export const bootHelloWorldDaemon = async (): Promise<void> => {
  const exampleRoot = resolveExampleRoot();
  const agentScriptPath = resolve(exampleRoot, "agent.mjs");

  const loader = new IdentityLoader({ rootDir: exampleRoot });
  const loaded = await loader.load("hello-world");

  // Phase 1B default trigger: the loader parses `wake_schedule.delayMs`
  // from frontmatter but does not yet own trigger construction
  // (that's Phase 1B-c / B3). For now the CLI converts frontmatter →
  // trigger inline; this moves to a shared helper in Phase 1B-c.
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

  const daemon = new Daemon({
    executor,
    agents: [registered],
  });

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
        await daemon.stop();
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

  daemon.start();

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
 *
 * The CLI is built to `packages/cli/dist/boot.js`; the example lives at
 * `<repo-root>/examples/hello-world-agent/`. Walk up from the compiled
 * file location to the repo root.
 */
const resolveExampleRoot = (): string => {
  const here = dirname(fileURLToPath(import.meta.url));
  // here = <repo>/packages/cli/dist
  const repoRoot = resolve(here, "..", "..", "..");
  return resolve(repoRoot, "examples", "hello-world-agent");
};
