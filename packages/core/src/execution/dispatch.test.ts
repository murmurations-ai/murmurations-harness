import { describe, expect, it } from "vitest";

import { DispatchExecutor } from "./dispatch.js";
import { InProcessExecutor, type AgentRunner } from "./in-process.js";
import {
  isCompleted,
  makeAgentId,
  makeCircleId,
  makeWakeId,
  type AgentExecutor,
  type AgentSpawnContext,
} from "./index.js";

interface FakeClients {
  readonly tag: string;
}

const makeContext = (agentId: string): AgentSpawnContext => ({
  wakeId: makeWakeId("11111111-1111-1111-1111-111111111111"),
  agentId: makeAgentId(agentId),
  identity: {
    agentId: makeAgentId(agentId),
    frontmatter: {
      agentId: makeAgentId(agentId),
      name: agentId,
      modelTier: "balanced",
      circleMemberships: [makeCircleId("test")],
    },
    layers: [],
  },
  signals: {
    wakeId: makeWakeId("11111111-1111-1111-1111-111111111111"),
    assembledAt: new Date(),
    signals: [],
    warnings: [],
  },
  wakeReason: { kind: "manual", invokedBy: "test" },
  budget: {
    maxInputTokens: 0,
    maxOutputTokens: 0,
    maxWallClockMs: 5000,
    model: { tier: "balanced", provider: "test", model: "test", maxTokens: 4096 },
    maxCostMicros: 0,
  },
  environment: {},
});

describe("DispatchExecutor", () => {
  it("routes spawn to the correct inner executor by agentId", async () => {
    // eslint-disable-next-line @typescript-eslint/require-await
    const runnerA: AgentRunner<FakeClients> = async () => ({ wakeSummary: "agent-a ran" });
    // eslint-disable-next-line @typescript-eslint/require-await
    const runnerB: AgentRunner<FakeClients> = async () => ({ wakeSummary: "agent-b ran" });

    const executorA: AgentExecutor = new InProcessExecutor<FakeClients>({
      resolveRunner: () => runnerA,
      resolveClients: () => ({ tag: "a" }),
      instanceId: "exec-a",
    });
    const executorB: AgentExecutor = new InProcessExecutor<FakeClients>({
      resolveRunner: () => runnerB,
      resolveClients: () => ({ tag: "b" }),
      instanceId: "exec-b",
    });

    const dispatch = new DispatchExecutor(
      new Map([
        ["agent-a", executorA],
        ["agent-b", executorB],
      ]),
    );

    const handleA = await dispatch.spawn(makeContext("agent-a"));
    const handleB = await dispatch.spawn(makeContext("agent-b"));

    const resultA = await dispatch.waitForCompletion(handleA);
    const resultB = await dispatch.waitForCompletion(handleB);

    expect(isCompleted(resultA)).toBe(true);
    expect(resultA.wakeSummary).toBe("agent-a ran");
    expect(isCompleted(resultB)).toBe(true);
    expect(resultB.wakeSummary).toBe("agent-b ran");
  });

  it("throws for an unregistered agentId", async () => {
    const dispatch = new DispatchExecutor(new Map());
    await expect(dispatch.spawn(makeContext("unknown"))).rejects.toThrow(/no executor registered/);
  });

  it("capabilities reports dispatch + merged flags", () => {
    const executorA: AgentExecutor = new InProcessExecutor<FakeClients>({
      // eslint-disable-next-line @typescript-eslint/require-await
      resolveRunner: () => async () => ({ wakeSummary: "" }),
      resolveClients: () => ({ tag: "" }),
    });
    const dispatch = new DispatchExecutor(new Map([["a", executorA]]));
    const caps = dispatch.capabilities();
    expect(caps.id).toBe("dispatch");
    expect(caps.supportsInProcess).toBe(true);
  });
});
