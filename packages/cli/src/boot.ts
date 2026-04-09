/**
 * Phase 1A daemon boot — wires SubprocessExecutor + TimerScheduler +
 * Daemon around a single hardcoded hello-world agent, fires one wake,
 * waits for SIGINT, shuts down cleanly.
 *
 * This is the concrete integration of the Phase 1A gate. Everything
 * past this is Phase 1B (agent registry from disk, signal aggregator,
 * secrets, GitHub client, real cron).
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  Daemon,
  SubprocessExecutor,
  type RegisteredAgent,
  type SubprocessCommand,
} from "@murmuration/core";

const HELLO_WORLD_AGENT: RegisteredAgent = {
  agentId: "hello-world",
  displayName: "Hello World Agent",
  trigger: { kind: "delay-once", delayMs: 2000 },
  circleMemberships: ["engineering"],
  modelTier: "fast",
  maxWallClockMs: 10_000,
  identityContent: {
    murmurationSoul:
      "[phase-1a placeholder] The murmuration is a test instance. The one agent in it is hello-world, and its only job is to prove the wake loop works.",
    agentSoul:
      "[phase-1a placeholder] I am the hello-world agent. I have no purpose beyond proving the daemon can spawn me and reap my result.",
    agentRole:
      "[phase-1a placeholder] My role is to print a wake summary and exit cleanly.",
    circleContexts: [
      {
        circleId: "engineering",
        content:
          "[phase-1a placeholder] The Engineering Circle is building the harness I am running inside.",
      },
    ],
  },
};

/**
 * Boot the daemon, run until SIGINT/SIGTERM, then shut down cleanly.
 */
export const bootHelloWorldDaemon = async (): Promise<void> => {
  const helloWorldAgentPath = resolveHelloWorldAgentPath();

  const executor = new SubprocessExecutor({
    resolveCommand: (context): SubprocessCommand => {
      if (context.agentId.value !== "hello-world") {
        // Phase 1A has exactly one agent. Anything else is a bug.
        throw new Error(
          `resolveCommand: unknown agent ${context.agentId.value}`,
        );
      }
      return {
        command: process.execPath,
        args: [helloWorldAgentPath],
      };
    },
  });

  const daemon = new Daemon({
    executor,
    agents: [HELLO_WORLD_AGENT],
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
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
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
 * Resolve the absolute path to `examples/hello-world-agent/agent.mjs`.
 *
 * The CLI is built to `packages/cli/dist/boot.js`; the example lives at
 * `<repo-root>/examples/hello-world-agent/agent.mjs`. We walk up from
 * the compiled file location to the repo root.
 */
const resolveHelloWorldAgentPath = (): string => {
  const here = dirname(fileURLToPath(import.meta.url));
  // here = <repo>/packages/cli/dist
  // repo root = ../../..
  const repoRoot = resolve(here, "..", "..", "..");
  return resolve(repoRoot, "examples", "hello-world-agent", "agent.mjs");
};
