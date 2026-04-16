import { describe, expect, it } from "vitest";

import { SubprocessExecutor } from "../execution/subprocess.js";
import { makeSecretKey, makeSecretValue } from "../secrets/index.js";
import type {
  SecretDeclaration,
  SecretKey,
  SecretValue,
  SecretsLoadResult,
  SecretsProvider,
  SecretsProviderCapabilities,
} from "../secrets/index.js";
import type {
  SignalAggregationContext,
  SignalAggregationResult,
  SignalAggregator,
  SignalAggregatorCapabilities,
} from "../signals/index.js";
import type { DaemonLogger, RegisteredAgent } from "./index.js";
import { Daemon } from "./index.js";

interface CapturedLog {
  level: "debug" | "info" | "warn" | "error";
  event: string;
  data: Record<string, unknown>;
}

const makeCapturingLogger = (): { logger: DaemonLogger; logs: CapturedLog[] } => {
  const logs: CapturedLog[] = [];
  const logger: DaemonLogger = {
    debug: (event, data) => logs.push({ level: "debug", event, data: data ?? {} }),
    info: (event, data) => logs.push({ level: "info", event, data: data ?? {} }),
    warn: (event, data) => logs.push({ level: "warn", event, data: data ?? {} }),
    error: (event, data) => logs.push({ level: "error", event, data: data ?? {} }),
  };
  return { logger, logs };
};

const helloWorld: RegisteredAgent = {
  agentId: "hello-world",
  displayName: "Hello World Agent",
  trigger: { kind: "delay-once", delayMs: 50 },
  groupMemberships: ["engineering"],
  modelTier: "fast",
  maxWallClockMs: 5000,
  identityContent: {
    murmurationSoul: "test soul",
    agentSoul: "test agent soul",
    agentRole: "test role",
    groupContexts: [
      {
        groupId: "engineering",
        content: "engineering ctx",
      },
    ],
  },
  githubWriteScopes: {
    issueComments: [],
    branchCommits: [],
    labels: [],
    issues: [],
  },
  budget: {
    maxCostMicros: 0,
    maxGithubApiCalls: 0,
    onBreach: "warn",
  },
  secrets: {
    required: [],
    optional: [],
  },
  tools: { mcp: [], cli: [] },
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

  // -------------------------------------------------------------------
  // 1B-d integration: Daemon × SignalAggregator
  // -------------------------------------------------------------------

  it("threads aggregator results through to daemon.wake.fire with signalCount", async () => {
    const fakeAggregator: SignalAggregator = {
      capabilities: (): SignalAggregatorCapabilities => ({
        id: "test-fake",
        displayName: "Test Aggregator",
        version: "0.0.0-test",
        activeSources: ["private-note"],
        totalCap: 50,
      }),
      // eslint-disable-next-line @typescript-eslint/require-await -- async to match the interface
      aggregate: async (ctx: SignalAggregationContext): Promise<SignalAggregationResult> => ({
        ok: true,
        bundle: {
          wakeId: ctx.wakeId,
          assembledAt: ctx.now,
          signals: [
            {
              kind: "private-note",
              id: "private-note:fake-1.md",
              trust: "trusted",
              fetchedAt: ctx.now,
              path: "/fake/1.md",
              summary: "fake summary one",
            },
            {
              kind: "private-note",
              id: "private-note:fake-2.md",
              trust: "trusted",
              fetchedAt: ctx.now,
              path: "/fake/2.md",
              summary: "fake summary two",
            },
          ],
          actionItems: [],
          warnings: [],
        },
      }),
    };

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
      signalAggregator: fakeAggregator,
    });

    daemon.start();
    await waitFor(() => logs.some((l) => l.event === "daemon.wake.fire"), 2000);
    const fireEvent = logs.find((l) => l.event === "daemon.wake.fire");
    expect(fireEvent).toBeDefined();
    expect(fireEvent?.data.signalCount).toBe(2);
    expect(fireEvent?.data.signalWarnings).toBe(0);
    await daemon.stop();
  });

  it("aggregator error degrades to empty bundle and logs daemon.wake.aggregator.error", async () => {
    const failingAggregator: SignalAggregator = {
      capabilities: (): SignalAggregatorCapabilities => ({
        id: "failing-fake",
        displayName: "Failing Aggregator",
        version: "0.0.0-test",
        activeSources: [],
        totalCap: 0,
      }),
      // eslint-disable-next-line @typescript-eslint/require-await -- async to match the interface
      aggregate: async (): Promise<SignalAggregationResult> => ({
        ok: false,
        error: new (class extends Error {
          public readonly code = "internal" as const;
          public readonly wakeId = undefined;
          public override readonly cause = undefined;
        })("simulated failure"),
      }),
    };

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
      signalAggregator: failingAggregator,
    });

    daemon.start();
    await waitFor(() => logs.some((l) => l.event === "daemon.wake.fire"), 2000);
    const errorLog = logs.find((l) => l.event === "daemon.wake.aggregator.error");
    expect(errorLog).toBeDefined();
    expect(errorLog?.data.code).toBe("internal");
    // Wake still fires with an empty bundle.
    const fireEvent = logs.find((l) => l.event === "daemon.wake.fire");
    expect(fireEvent?.data.signalCount).toBe(0);
    await daemon.stop();
  });

  // -------------------------------------------------------------------
  // 1B-c integration: Daemon × Secrets
  // -------------------------------------------------------------------

  it("loadSecrets returns true with an in-memory provider; exposes loaded keys", async () => {
    const GITHUB_TOKEN = makeSecretKey("GITHUB_TOKEN");
    const provider = makeInMemoryProvider({
      values: { GITHUB_TOKEN: "ghp_test_value_abcdefghij" },
    });
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
      secrets: {
        provider,
        declaration: { required: [GITHUB_TOKEN], optional: [] },
      },
    });

    const loaded = await daemon.loadSecrets();
    expect(loaded).toBe(true);
    const okLog = logs.find((l) => l.event === "daemon.secrets.load.ok");
    expect(okLog).toBeDefined();
    expect(okLog?.data.loadedCount).toBe(1);
    expect(provider.get(GITHUB_TOKEN).reveal()).toBe("ghp_test_value_abcdefghij");
  });

  it("loadSecrets returns false and logs on required-missing failure", async () => {
    const GITHUB_TOKEN = makeSecretKey("GITHUB_TOKEN");
    const provider = makeInMemoryProvider({ values: {} });
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
      secrets: {
        provider,
        declaration: { required: [GITHUB_TOKEN], optional: [] },
      },
    });

    const loaded = await daemon.loadSecrets();
    expect(loaded).toBe(false);
    const failedLog = logs.find((l) => l.event === "daemon.secrets.load.failed");
    expect(failedLog).toBeDefined();
    expect(failedLog?.data.code).toBe("required-missing");
  });

  // -------------------------------------------------------------------
  // 1B-c integration: Daemon × cost record log emission
  // -------------------------------------------------------------------

  it("emits daemon.wake.cost with schemaVersion 1 after every wake", async () => {
    const executor = new SubprocessExecutor({
      resolveCommand: () => ({
        command: "node",
        args: ["-e", "process.stdout.write('::wake-summary:: ok\\n'); process.exit(0);"],
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
    await waitFor(() => logs.some((l) => l.event === "daemon.wake.cost"), 2000);
    const costEvent = logs.find((l) => l.event === "daemon.wake.cost");
    expect(costEvent).toBeDefined();
    expect(costEvent?.data.schemaVersion).toBe(1);
    expect(costEvent?.data.agentId).toBe("hello-world");
    const llm = costEvent?.data.llm as { modelProvider?: string } | undefined;
    expect(llm?.modelProvider).toBe("placeholder");
    const rollup = costEvent?.data.rollupHints as { dayUtc?: string } | undefined;
    expect(rollup?.dayUtc).toMatch(/^\d{4}-\d{2}-\d{2}$/);
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

/**
 * In-memory SecretsProvider for daemon integration tests. Mimics
 * DotenvSecretsProvider's contract without touching the filesystem.
 */
const makeInMemoryProvider = (config: {
  readonly values: Record<string, string>;
}): SecretsProvider => {
  const store = new Map<string, SecretValue>();
  const declared = new Set<string>();
  let loaded = false;

  return {
    capabilities: (): SecretsProviderCapabilities => ({
      id: "in-memory-test",
      displayName: "In-Memory Test Provider",
      version: "0.0.0-test",
      supportsHotReload: false,
      stateful: false,
    }),
    // eslint-disable-next-line @typescript-eslint/require-await -- async to match the interface
    load: async (declaration: SecretDeclaration): Promise<SecretsLoadResult> => {
      declared.clear();
      for (const key of declaration.required) declared.add(key.value);
      for (const key of declaration.optional) declared.add(key.value);
      store.clear();
      for (const key of declaration.required) {
        const value = config.values[key.value];
        if (value === undefined) {
          return {
            ok: false,
            error: new (class extends Error {
              public readonly code = "required-missing" as const;
              public override readonly cause: unknown = undefined;
            })(`required secret missing: ${key.value}`),
          };
        }
        store.set(key.value, makeSecretValue(value));
      }
      const missingOptional: SecretKey[] = [];
      for (const key of declaration.optional) {
        const value = config.values[key.value];
        if (value === undefined) {
          missingOptional.push(key);
          continue;
        }
        store.set(key.value, makeSecretValue(value));
      }
      loaded = true;
      return { ok: true, loadedCount: store.size, missingOptional };
    },
    get: (key) => {
      if (!loaded) throw new Error("provider: get() before load()");
      const value = store.get(key.value);
      if (!value) {
        throw new Error(`unknown key: ${key.value}`);
      }
      return value;
    },
    has: (key) => store.has(key.value),
    loadedKeys: () => [...store.keys()].map((value) => ({ kind: "secret-key" as const, value })),
  };
};
