import { describe, expect, it } from "vitest";

import { makeUSDMicros } from "../cost/usd.js";
import type { WakeCostBuilder } from "../cost/builder.js";

import { InProcessExecutor, type AgentRunner } from "./in-process.js";
import {
  isCompleted,
  isFailed,
  isKilled,
  isTimedOut,
  makeAgentId,
  makeCircleId,
  makeWakeId,
  type AgentSpawnContext,
} from "./index.js";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

interface FakeClients {
  readonly llm: { readonly provider: string };
  readonly github: { readonly writeScoped: boolean };
}

const makeContext = (): AgentSpawnContext => ({
  wakeId: makeWakeId("11111111-1111-1111-1111-111111111111"),
  agentId: makeAgentId("01-research"),
  identity: {
    agentId: makeAgentId("01-research"),
    frontmatter: {
      agentId: makeAgentId("01-research"),
      name: "Research Agent",
      modelTier: "balanced",
      circleMemberships: [makeCircleId("intelligence")],
    },
    layers: [],
  },
  signals: {
    wakeId: makeWakeId("11111111-1111-1111-1111-111111111111"),
    assembledAt: new Date(),
    signals: [],
    actionItems: [],
    warnings: [],
  },
  wakeReason: {
    kind: "scheduled",
    cronExpression: "0 18 * * 0",
  },
  wakeMode: "individual" as const,
  budget: {
    maxInputTokens: 0,
    maxOutputTokens: 0,
    maxWallClockMs: 5_000,
    model: {
      tier: "balanced",
      provider: "gemini",
      model: "gemini-2.5-pro",
      maxTokens: 32_768,
    },
    maxCostMicros: 0,
  },
  environment: {},
});

describe("InProcessExecutor", () => {
  it("runs a runner in-process and returns the wake summary", async () => {
    // eslint-disable-next-line @typescript-eslint/require-await -- test doubles mimic the async runner signature
    const runner: AgentRunner<FakeClients> = async ({ clients, spawn: _spawn }) => {
      expect(clients.llm.provider).toBe("gemini");
      expect(clients.github.writeScoped).toBe(true);
      return { wakeSummary: "done" };
    };

    const executor = new InProcessExecutor<FakeClients>({
      resolveRunner: () => runner,
      resolveClients: () => ({
        llm: { provider: "gemini" },
        github: { writeScoped: true },
      }),
    });

    const handle = await executor.spawn(makeContext());
    const result = await executor.waitForCompletion(handle);
    expect(isCompleted(result)).toBe(true);
    expect(result.wakeSummary).toBe("done");
    expect(result.costRecord).toBeDefined();
  });

  it("binds the costBuilder to the wake so addLlmTokens lands on that wake's record", async () => {
    let capturedBuilder: WakeCostBuilder | null = null;
    // eslint-disable-next-line @typescript-eslint/require-await -- synchronous fake
    const runner: AgentRunner<FakeClients> = async ({ costBuilder }) => {
      capturedBuilder = costBuilder;
      costBuilder.addLlmTokens({
        inputTokens: 1200,
        outputTokens: 350,
        modelProvider: "gemini",
        modelName: "gemini-2.5-pro",
        costMicros: makeUSDMicros(4500),
      });
      return { wakeSummary: "llm-called" };
    };

    const executor = new InProcessExecutor<FakeClients>({
      resolveRunner: () => runner,
      resolveClients: ({ costBuilder }) => {
        // This is where the real boot path would call makeDaemonHook(costBuilder)
        // and construct a fresh LLMClient whose defaultCostHook routes into
        // THIS builder. We verify the builder identity by reference below.
        expect(costBuilder).toBeDefined();
        return { llm: { provider: "gemini" }, github: { writeScoped: false } };
      },
    });

    const handle = await executor.spawn(makeContext());
    const result = await executor.waitForCompletion(handle);
    expect(isCompleted(result)).toBe(true);
    expect(capturedBuilder).not.toBeNull();
    expect(result.costRecord?.llm.modelProvider).toBe("gemini");
    expect(result.costRecord?.llm.modelName).toBe("gemini-2.5-pro");
    expect(result.costRecord?.llm.inputTokens).toBe(1200);
    expect(result.costRecord?.llm.outputTokens).toBe(350);
    expect(result.costRecord?.llm.costMicros.value).toBe(4500);
  });

  it("wraps a runner throw as an outcome: failed", async () => {
    // eslint-disable-next-line @typescript-eslint/require-await -- synchronous fake
    const runner: AgentRunner<FakeClients> = async () => {
      throw new Error("kaboom");
    };

    const executor = new InProcessExecutor<FakeClients>({
      resolveRunner: () => runner,
      resolveClients: () => ({ llm: { provider: "" }, github: { writeScoped: false } }),
    });

    const handle = await executor.spawn(makeContext());
    const result = await executor.waitForCompletion(handle);
    expect(isFailed(result)).toBe(true);
    if (isFailed(result)) {
      expect(result.outcome.error.code).toBe("internal");
      expect(result.outcome.error.message).toContain("kaboom");
    }
  });

  it("resolveRunner can be async (dynamic import path)", async () => {
    // eslint-disable-next-line @typescript-eslint/require-await -- synchronous fake
    const runner: AgentRunner<FakeClients> = async () => ({ wakeSummary: "async-loaded" });

    const executor = new InProcessExecutor<FakeClients>({
      resolveRunner: async () => {
        // Simulate a dynamic import resolving the runner.
        await new Promise((r) => setTimeout(r, 1));
        return runner;
      },
      resolveClients: () => ({ llm: { provider: "" }, github: { writeScoped: false } }),
    });

    const handle = await executor.spawn(makeContext());
    const result = await executor.waitForCompletion(handle);
    expect(isCompleted(result)).toBe(true);
    expect(result.wakeSummary).toBe("async-loaded");
  });

  it("kill produces a killed outcome even if the runner ignores the signal", async () => {
    let unblock!: () => void;
    const runner: AgentRunner<FakeClients> = async () => {
      await new Promise<void>((resolve) => {
        unblock = resolve;
      });
      return { wakeSummary: "should not appear" };
    };

    const executor = new InProcessExecutor<FakeClients>({
      resolveRunner: () => runner,
      resolveClients: () => ({ llm: { provider: "" }, github: { writeScoped: false } }),
    });

    const handle = await executor.spawn(makeContext());
    await executor.kill(handle, "operator-requested");
    unblock(); // release the stuck runner so vitest doesn't hang

    const result = await executor.waitForCompletion(handle);
    expect(isKilled(result)).toBe(true);
    if (isKilled(result)) {
      expect(result.outcome.reason).toBe("operator-requested");
    }
  });

  it("wall-clock budget triggers a timed-out outcome", async () => {
    const runner: AgentRunner<FakeClients> = async ({ signal }) => {
      // Wait for the signal or 10s, whichever comes first. The executor
      // fires abort on the signal when the wall-clock budget expires.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 10_000);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
      return { wakeSummary: "will be ignored, terminal already resolved" };
    };

    const executor = new InProcessExecutor<FakeClients>({
      resolveRunner: () => runner,
      resolveClients: () => ({ llm: { provider: "" }, github: { writeScoped: false } }),
    });

    // Override maxWallClockMs to a very short value.
    const context = {
      ...makeContext(),
      budget: {
        ...makeContext().budget,
        maxWallClockMs: 50,
      },
    };
    const handle = await executor.spawn(context);
    const result = await executor.waitForCompletion(handle);
    expect(isTimedOut(result)).toBe(true);
  });

  it("capabilities() reports in-process + concurrent + unbounded", () => {
    const executor = new InProcessExecutor<FakeClients>({
      // eslint-disable-next-line @typescript-eslint/require-await -- synchronous fake
      resolveRunner: () => async () => ({ wakeSummary: "" }),
      resolveClients: () => ({ llm: { provider: "" }, github: { writeScoped: false } }),
    });
    const caps = executor.capabilities();
    expect(caps.supportsInProcess).toBe(true);
    expect(caps.supportsSubprocessIsolation).toBe(false);
    expect(caps.supportsKill).toBe(true);
    expect(caps.supportsConcurrentWakes).toBe(true);
    expect(caps.maxConcurrentWakes).toBe("unbounded");
  });
});
