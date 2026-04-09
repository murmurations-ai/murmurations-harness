import { describe, expect, it } from "vitest";

import { SubprocessExecutor } from "../execution/subprocess.js";
import type { DaemonLogger, RegisteredAgent } from "./index.js";
import { Daemon } from "./index.js";

interface CapturedLog {
  level: "info" | "warn" | "error";
  event: string;
  data: Record<string, unknown>;
}

const makeCapturingLogger = (): { logger: DaemonLogger; logs: CapturedLog[] } => {
  const logs: CapturedLog[] = [];
  const logger: DaemonLogger = {
    info: (event, data) => logs.push({ level: "info", event, data }),
    warn: (event, data) => logs.push({ level: "warn", event, data }),
    error: (event, data) => logs.push({ level: "error", event, data }),
  };
  return { logger, logs };
};

const helloWorld: RegisteredAgent = {
  agentId: "hello-world",
  displayName: "Hello World Agent",
  trigger: { kind: "delay-once", delayMs: 50 },
  circleMemberships: ["engineering"],
  modelTier: "fast",
  maxWallClockMs: 5000,
  identityContent: {
    murmurationSoul: "test soul",
    agentSoul: "test agent soul",
    agentRole: "test role",
    circleContexts: [
      {
        circleId: "engineering",
        content: "engineering ctx",
      },
    ],
  },
};

describe("Daemon", () => {
  it("boots, fires a registered agent's delay-once wake, and logs completion", async () => {
    const executor = new SubprocessExecutor({
      resolveCommand: () => ({
        command: "node",
        args: [
          "-e",
          "process.stdout.write('::wake-summary:: hello from daemon test\\n'); process.exit(0);",
        ],
      }),
    });

    const { logger, logs } = makeCapturingLogger();
    const daemon = new Daemon({
      executor,
      agents: [helloWorld],
      logger,
      heartbeatMs: 60_000,
    });

    daemon.start();
    expect(logs.some((l) => l.event === "daemon.boot")).toBe(true);
    expect(logs.some((l) => l.event === "daemon.agent.registered")).toBe(true);
    expect(logs.some((l) => l.event === "daemon.ready")).toBe(true);

    // Wait for the delay-once wake to fire and complete.
    await waitFor(() => logs.some((l) => l.event === "daemon.wake.completed"), 2000);

    const completed = logs.find((l) => l.event === "daemon.wake.completed");
    expect(completed).toBeDefined();
    expect(completed?.data.outcome).toBe("completed");
    expect(completed?.data.agentId).toBe("hello-world");

    await daemon.stop();
    expect(logs.some((l) => l.event === "daemon.shutdown.complete")).toBe(true);
  });

  it("stop is idempotent and safe to call twice", async () => {
    const executor = new SubprocessExecutor({
      resolveCommand: () => ({
        command: "node",
        args: ["-e", "process.exit(0);"],
      }),
    });

    const { logger } = makeCapturingLogger();
    const daemon = new Daemon({
      executor,
      agents: [],
      logger,
      heartbeatMs: 60_000,
    });

    daemon.start();
    await daemon.stop();
    await daemon.stop();
    // Should not throw.
  });

  it("start is idempotent (double-start does not double-register agents)", async () => {
    const executor = new SubprocessExecutor({
      resolveCommand: () => ({
        command: "node",
        args: ["-e", "process.exit(0);"],
      }),
    });

    const { logger, logs } = makeCapturingLogger();
    const daemon = new Daemon({
      executor,
      agents: [helloWorld],
      logger,
      heartbeatMs: 60_000,
    });

    daemon.start();
    daemon.start();

    const registrations = logs.filter((l) => l.event === "daemon.agent.registered");
    expect(registrations.length).toBe(1);

    await daemon.stop();
  });

  it("logs the capabilities of its executor at ready time", async () => {
    const executor = new SubprocessExecutor({
      resolveCommand: () => ({
        command: "node",
        args: ["-e", "process.exit(0);"],
      }),
    });

    const { logger, logs } = makeCapturingLogger();
    const daemon = new Daemon({
      executor,
      agents: [],
      logger,
      heartbeatMs: 60_000,
    });

    daemon.start();
    const ready = logs.find((l) => l.event === "daemon.ready");
    expect(ready).toBeDefined();
    const caps = ready?.data.capabilities as { id: string } | undefined;
    expect(caps?.id).toBe("subprocess");

    await daemon.stop();
  });

  it("emits heartbeat log at the configured interval", async () => {
    const executor = new SubprocessExecutor({
      resolveCommand: () => ({
        command: "node",
        args: ["-e", "process.exit(0);"],
      }),
    });

    const { logger, logs } = makeCapturingLogger();
    const daemon = new Daemon({
      executor,
      agents: [],
      logger,
      heartbeatMs: 30,
    });

    daemon.start();
    await waitFor(() => logs.filter((l) => l.event === "daemon.heartbeat").length >= 2, 500);
    await daemon.stop();
  });
});

const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${String(timeoutMs)}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
