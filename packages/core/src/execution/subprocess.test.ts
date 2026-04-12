import { describe, expect, it } from "vitest";

import { SubprocessExecutor, type SubprocessCommand } from "./subprocess.js";
import {
  HandleUnknownError,
  isCompleted,
  isFailed,
  makeAgentId,
  makeCircleId,
  makeWakeId,
  type AgentSpawnContext,
  type CostBudget,
  type IdentityChain,
  type ResolvedModel,
  type SignalBundle,
  type WakeReason,
} from "./index.js";

const model: ResolvedModel = {
  tier: "fast",
  provider: "test",
  model: "test-model",
  maxTokens: 1024,
};

const budget: CostBudget = {
  maxInputTokens: 1000,
  maxOutputTokens: 1000,
  maxWallClockMs: 5000,
  model,
  maxCostMicros: 10_000,
};

const makeContext = (agentId: string, wakeId: string): AgentSpawnContext => {
  const id = makeAgentId(agentId);
  const identity: IdentityChain = {
    agentId: id,
    frontmatter: {
      agentId: id,
      name: agentId,
      modelTier: "fast",
      circleMemberships: [makeCircleId("engineering")],
    },
    layers: [
      {
        kind: "murmuration-soul",
        content: "soul",
        sourcePath: "<test>",
      },
      {
        kind: "agent-soul",
        agentId: id,
        content: "agent-soul",
        sourcePath: "<test>",
      },
      {
        kind: "agent-role",
        agentId: id,
        content: "agent-role",
        sourcePath: "<test>",
      },
      {
        kind: "circle-context",
        circleId: makeCircleId("engineering"),
        content: "engineering circle context",
        sourcePath: "<test>",
      },
    ],
  };
  const signals: SignalBundle = {
    wakeId: makeWakeId(wakeId),
    assembledAt: new Date(),
    signals: [],
    actionItems: [],
    warnings: [],
  };
  const wakeReason: WakeReason = { kind: "manual", invokedBy: "test" };
  return {
    wakeId: makeWakeId(wakeId),
    agentId: id,
    identity,
    signals,
    wakeReason,
    wakeMode: "individual" as const,
    budget,
    environment: {},
  };
};

describe("SubprocessExecutor", () => {
  it("reports capabilities", () => {
    const executor = new SubprocessExecutor({
      resolveCommand: () => ({ command: "node", args: ["-e", "process.exit(0)"] }),
    });
    const caps = executor.capabilities();
    expect(caps.id).toBe("subprocess");
    expect(caps.supportsSubprocessIsolation).toBe(true);
    expect(caps.supportsInProcess).toBe(false);
    expect(caps.supportsKill).toBe(true);
    expect(caps.capturesStdio).toBe(true);
    expect(caps.supportedModelTiers).toContain("fast");
  });

  it("runs a successful echo command and reports completed", async () => {
    const executor = new SubprocessExecutor({
      resolveCommand: (): SubprocessCommand => ({
        command: "node",
        args: [
          "-e",
          "process.stdout.write('::wake-summary:: hello from test\\n'); process.exit(0);",
        ],
      }),
    });

    const ctx = makeContext("test-agent", "wake-1");
    const handle = await executor.spawn(ctx);
    expect(handle.__executor).toBe("subprocess");
    expect(handle.wakeId.value).toBe("wake-1");

    const result = await executor.waitForCompletion(handle);
    expect(isCompleted(result)).toBe(true);
    expect(result.wakeSummary).toContain("hello from test");
    expect(result.cost.wallClockMs).toBeGreaterThanOrEqual(0);

    // 1B-c: costRecord is populated with subprocess delta.
    expect(result.costRecord).toBeDefined();
    expect(result.costRecord?.schemaVersion).toBe(1);
    expect(result.costRecord?.wallClockMs).toBeGreaterThanOrEqual(0);
    expect(result.costRecord?.subprocess).toBeDefined();
    // CPU deltas are monotonic non-negative.
    expect(result.costRecord?.subprocess?.userCpuMicros).toBeGreaterThanOrEqual(0);
    expect(result.costRecord?.subprocess?.systemCpuMicros).toBeGreaterThanOrEqual(0);
    // maxRSS is measured in kilobytes and should be positive for any real wake.
    expect(result.costRecord?.subprocess?.maxRssKb).toBeGreaterThan(0);
    // LLM and github fields are stubs in Phase 1.
    expect(result.costRecord?.llm.inputTokens).toBe(0);
    expect(result.costRecord?.llm.modelProvider).toBe("placeholder");
    expect(result.costRecord?.github.restCalls).toBe(0);
    expect(result.costRecord?.totals.costMicros.value).toBe(0);
    expect(result.costRecord?.budget).toBeNull();
    // Rollup hints have the right shape.
    expect(result.costRecord?.rollupHints.dayUtc).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.costRecord?.rollupHints.isoWeekUtc).toMatch(/^\d{4}-W\d{2}$/);
  });

  it("captures a non-zero exit as a failed outcome", async () => {
    const executor = new SubprocessExecutor({
      resolveCommand: (): SubprocessCommand => ({
        command: "node",
        args: ["-e", "process.exit(42);"],
      }),
    });

    const ctx = makeContext("fail-agent", "wake-fail");
    const handle = await executor.spawn(ctx);
    const result = await executor.waitForCompletion(handle);
    expect(isFailed(result)).toBe(true);
    if (isFailed(result)) {
      expect(result.outcome.error.code).toBe("internal");
      expect(result.outcome.error.message).toContain("42");
    }
  });

  it("parses governance event markers from stdout", async () => {
    const executor = new SubprocessExecutor({
      resolveCommand: (): SubprocessCommand => ({
        command: "node",
        args: [
          "-e",
          `
            process.stdout.write('::wake-summary:: testing\\n');
            process.stdout.write('::governance::tension:: {"title":"test tension"}\\n');
            process.stdout.write('::governance::notify:: {"target":"source"}\\n');
            process.exit(0);
          `,
        ],
      }),
    });

    const ctx = makeContext("gov-agent", "wake-gov");
    const handle = await executor.spawn(ctx);
    const result = await executor.waitForCompletion(handle);

    expect(isCompleted(result)).toBe(true);
    expect(result.governanceEvents).toHaveLength(2);
    expect(result.governanceEvents[0]?.kind).toBe("tension");
    expect(result.governanceEvents[1]?.kind).toBe("notify");
  });

  it("rejects waitForCompletion with HandleUnknownError for cross-executor handle", async () => {
    const executorA = new SubprocessExecutor({
      resolveCommand: () => ({ command: "node", args: ["-e", "process.exit(0)"] }),
      instanceId: "exec-a",
    });
    const executorB = new SubprocessExecutor({
      resolveCommand: () => ({ command: "node", args: ["-e", "process.exit(0)"] }),
      instanceId: "exec-b",
    });

    const ctx = makeContext("cross-agent", "wake-cross");
    const handle = await executorA.spawn(ctx);

    await expect(executorB.waitForCompletion(handle)).rejects.toThrow(HandleUnknownError);
  });

  it("SpawnError is raised when the resolver throws", async () => {
    const executor = new SubprocessExecutor({
      resolveCommand: () => {
        throw new Error("no such agent");
      },
    });

    const ctx = makeContext("boom-agent", "wake-boom");
    await expect(executor.spawn(ctx)).rejects.toMatchObject({
      code: "spawn-failed",
    });
  });

  it("kill on a completed wake is a no-op (idempotent)", async () => {
    const executor = new SubprocessExecutor({
      resolveCommand: (): SubprocessCommand => ({
        command: "node",
        args: ["-e", "process.exit(0)"],
      }),
    });

    const ctx = makeContext("quick-agent", "wake-quick");
    const handle = await executor.spawn(ctx);
    const result = await executor.waitForCompletion(handle);
    expect(isCompleted(result)).toBe(true);

    // After completion the handle is reaped; kill should silently succeed.
    await expect(executor.kill(handle, "test")).resolves.toBeUndefined();
  });

  it("kill on unknown handle resolves cleanly (does not throw)", async () => {
    const executorA = new SubprocessExecutor({
      resolveCommand: () => ({ command: "node", args: ["-e", "process.exit(0)"] }),
      instanceId: "exec-kill-a",
    });
    const executorB = new SubprocessExecutor({
      resolveCommand: () => ({ command: "node", args: ["-e", "process.exit(0)"] }),
      instanceId: "exec-kill-b",
    });

    const ctx = makeContext("kill-agent", "wake-kill");
    const handle = await executorA.spawn(ctx);

    // executorB does not know this handle; kill() is documented as
    // swallowing HandleUnknownError silently for idempotency.
    await expect(executorB.kill(handle, "from other executor")).resolves.toBeUndefined();

    // Clean up the real wake.
    await executorA.waitForCompletion(handle);
  });

  it("threads the spawn context through as env vars to the child", async () => {
    const executor = new SubprocessExecutor({
      resolveCommand: (): SubprocessCommand => ({
        command: "node",
        args: [
          "-e",
          `
            process.stdout.write('::wake-summary:: wakeId=' + process.env.MURMURATION_WAKE_ID + '\\n');
            process.stdout.write('::wake-summary:: agentId=' + process.env.MURMURATION_AGENT_ID + '\\n');
            const ctx = JSON.parse(process.env.MURMURATION_SPAWN_CONTEXT);
            process.stdout.write('::wake-summary:: layers=' + ctx.identity.layerKinds.join(',') + '\\n');
            process.exit(0);
          `,
        ],
      }),
    });

    const ctx = makeContext("thread-agent", "wake-thread");
    const handle = await executor.spawn(ctx);
    const result = await executor.waitForCompletion(handle);

    expect(isCompleted(result)).toBe(true);
    expect(result.wakeSummary).toContain("wakeId=wake-thread");
    expect(result.wakeSummary).toContain("agentId=thread-agent");
    expect(result.wakeSummary).toContain(
      "layers=murmuration-soul,agent-soul,agent-role,circle-context",
    );
  });
});

// ---------------------------------------------------------------------------
// Env scrub (ADR-0010 §8 / harness#8 — Security Agent #25)
// ---------------------------------------------------------------------------

describe("SubprocessExecutor env scrub (ADR-0010 §8 / harness#8)", () => {
  const spawnProbe = async (
    envVarName: string,
    opts: {
      contextEnvironment?: Record<string, string>;
      resolverEnv?: Record<string, string>;
    } = {},
  ): Promise<string> => {
    const executor = new SubprocessExecutor({
      resolveCommand: (): SubprocessCommand => {
        const cmd: {
          command: string;
          args: string[];
          env?: Record<string, string>;
        } = {
          command: "node",
          args: [
            "-e",
            `process.stdout.write('::wake-summary:: ' + (process.env[${JSON.stringify(envVarName)}] ?? '<unset>') + '\\n'); process.exit(0);`,
          ],
        };
        if (opts.resolverEnv) cmd.env = opts.resolverEnv;
        return cmd as SubprocessCommand;
      },
    });
    const ctx = makeContext("probe-agent", `wake-probe-${envVarName}`);
    if (opts.contextEnvironment) {
      (ctx as { environment: Record<string, string> }).environment = opts.contextEnvironment;
    }
    const handle = await executor.spawn(ctx);
    const result = await executor.waitForCompletion(handle);
    expect(isCompleted(result)).toBe(true);
    return result.wakeSummary.trim();
  };

  it("scrubs GITHUB_TOKEN from the child env even when set in process.env", async () => {
    process.env.GITHUB_TOKEN = "ghp_fake_should_not_leak";
    try {
      const seen = await spawnProbe("GITHUB_TOKEN");
      expect(seen).toBe("<unset>");
    } finally {
      delete process.env.GITHUB_TOKEN;
    }
  });

  it("scrubs ANTHROPIC_API_KEY from the child env", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-fake";
    try {
      const seen = await spawnProbe("ANTHROPIC_API_KEY");
      expect(seen).toBe("<unset>");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("passes PATH through so the child can resolve node (allow-list smoke test)", async () => {
    const seen = await spawnProbe("PATH");
    expect(seen).not.toBe("<unset>");
    expect(seen.length).toBeGreaterThan(0);
  });

  it("sets MURMURATION_WAKE_ID and MURMURATION_AGENT_ID in the child", async () => {
    const seenWake = await spawnProbe("MURMURATION_WAKE_ID");
    const seenAgent = await spawnProbe("MURMURATION_AGENT_ID");
    expect(seenWake).toContain("wake-probe-");
    expect(seenAgent).toBe("probe-agent");
  });

  it("context.environment overrides flow through to the child", async () => {
    const seen = await spawnProbe("MY_WAKE_VAR", {
      contextEnvironment: { MY_WAKE_VAR: "wake-scoped-value" },
    });
    expect(seen).toBe("wake-scoped-value");
  });

  it("resolved.env from the command resolver flows through to the child", async () => {
    const seen = await spawnProbe("MY_RESOLVER_VAR", {
      resolverEnv: { MY_RESOLVER_VAR: "resolver-scoped-value" },
    });
    expect(seen).toBe("resolver-scoped-value");
  });
});
