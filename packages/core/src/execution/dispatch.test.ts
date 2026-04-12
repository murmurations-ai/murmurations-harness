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

  it("regression: waitForCompletion resolves the correct executor even when instanceIds differ only by suffix", async () => {
    // This test reproduces the bug fixed in 88476f5: multiple
    // InProcessExecutors shared the default instanceId "in-process",
    // so DispatchExecutor.waitForCompletion matched the FIRST one in
    // the map — which wasn't necessarily the one that spawned the
    // handle. The fix gives each executor a unique instanceId.
    //
    // To catch regression: create two executors with DIFFERENT unique
    // IDs and verify each handle resolves to the correct executor's
    // runner output. If the dispatch naively matches the first
    // executor, agent-b's handle would fail with "unknown handle".

    // eslint-disable-next-line @typescript-eslint/require-await
    const runnerA: AgentRunner<FakeClients> = async () => ({ wakeSummary: "from-a" });
    // eslint-disable-next-line @typescript-eslint/require-await
    const runnerB: AgentRunner<FakeClients> = async () => ({ wakeSummary: "from-b" });

    // Unique instanceIds per agent — this is what boot.ts now does.
    const executorA: AgentExecutor = new InProcessExecutor<FakeClients>({
      resolveRunner: () => runnerA,
      resolveClients: () => ({ tag: "a" }),
      instanceId: "in-process-agent-a",
    });
    const executorB: AgentExecutor = new InProcessExecutor<FakeClients>({
      resolveRunner: () => runnerB,
      resolveClients: () => ({ tag: "b" }),
      instanceId: "in-process-agent-b",
    });

    const dispatch = new DispatchExecutor(
      new Map([
        ["agent-a", executorA],
        ["agent-b", executorB],
      ]),
    );

    // Spawn B first, then A — if dispatch matches by iteration
    // order instead of instanceId, B's handle would resolve against
    // A's executor and fail.
    const handleB = await dispatch.spawn(makeContext("agent-b"));
    const handleA = await dispatch.spawn(makeContext("agent-a"));

    const resultB = await dispatch.waitForCompletion(handleB);
    const resultA = await dispatch.waitForCompletion(handleA);

    expect(isCompleted(resultA)).toBe(true);
    expect(resultA.wakeSummary).toBe("from-a");
    expect(isCompleted(resultB)).toBe(true);
    expect(resultB.wakeSummary).toBe("from-b");
  });

  it("throws for an unregistered agentId", async () => {
    const dispatch = new DispatchExecutor(new Map());
    await expect(dispatch.spawn(makeContext("unknown"))).rejects.toThrow(/no executor registered/);
  });

  it("kill delegates to the correct inner executor", async () => {
    // eslint-disable-next-line @typescript-eslint/require-await
    const runner: AgentRunner<FakeClients> = async () => ({ wakeSummary: "ok" });
    const executor: AgentExecutor = new InProcessExecutor<FakeClients>({
      resolveRunner: () => runner,
      resolveClients: () => ({ tag: "a" }),
      instanceId: "exec-kill-test",
    });
    const dispatch = new DispatchExecutor(new Map([["agent-a", executor]]));
    const handle = await dispatch.spawn(makeContext("agent-a"));
    // kill should not throw for a valid handle
    await expect(dispatch.kill(handle, "test")).resolves.toBeUndefined();
  });

  it("kill silently succeeds for unknown handle (idempotent)", async () => {
    const dispatch = new DispatchExecutor(new Map());
    const fakeHandle = {
      __executor: "nonexistent",
      wakeId: makeWakeId("22222222-2222-2222-2222-222222222222"),
    };
    await expect(dispatch.kill(fakeHandle, "cleanup")).resolves.toBeUndefined();
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
