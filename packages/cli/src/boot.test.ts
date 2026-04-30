/**
 * Tests for boot.ts exported helpers. Today this file only covers
 * `makeDaemonHook` — the rest of `boot.ts` is exercised through the
 * daemon test suite and integration paths.
 */

import { describe, it, expect } from "vitest";

import { makeAgentId, makeWakeId, WakeCostBuilder } from "@murmurations-ai/core";

import { makeDaemonHook } from "./boot.js";

describe("makeDaemonHook", () => {
  const builder = (): WakeCostBuilder =>
    WakeCostBuilder.start({
      wakeId: makeWakeId("test-wake"),
      agentId: makeAgentId("test-agent"),
      modelTier: "balanced",
      groupIds: [],
    });

  const fakeLogger = (): {
    warn: (event: string, fields?: Record<string, unknown>) => void;
    calls: { event: string; fields?: Record<string, unknown> }[];
  } => {
    const calls: { event: string; fields?: Record<string, unknown> }[] = [];
    return {
      warn: (event, fields) => {
        if (fields !== undefined) calls.push({ event, fields });
        else calls.push({ event });
      },
      calls,
    };
  };

  it("prices a known model and does not warn", () => {
    const log = fakeLogger();
    const hook = makeDaemonHook(builder(), log);
    hook.onLlmCall({
      provider: "openai",
      model: "gpt-5.5",
      inputTokens: 1_000,
      outputTokens: 1_000,
    });
    expect(log.calls).toHaveLength(0);
  });

  it("warns once for an unknown model, then dedupes", () => {
    const log = fakeLogger();
    const hook = makeDaemonHook(builder(), log);
    for (let i = 0; i < 5; i++) {
      hook.onLlmCall({
        provider: "openai",
        model: "gpt-5.99-imaginary",
        inputTokens: 100,
        outputTokens: 100,
      });
    }
    expect(log.calls).toHaveLength(1);
    expect(log.calls[0]?.event).toBe("daemon.cost.pricing.unknown");
    expect(log.calls[0]?.fields).toMatchObject({
      provider: "openai",
      model: "gpt-5.99-imaginary",
      code: "unknown-model",
    });
  });

  it("warns separately for each unknown (provider, model) pair", () => {
    const log = fakeLogger();
    const hook = makeDaemonHook(builder(), log);
    hook.onLlmCall({
      provider: "openai",
      model: "fake-a",
      inputTokens: 1,
      outputTokens: 1,
    });
    hook.onLlmCall({
      provider: "anthropic",
      model: "fake-b",
      inputTokens: 1,
      outputTokens: 1,
    });
    hook.onLlmCall({
      provider: "openai",
      model: "fake-a",
      inputTokens: 1,
      outputTokens: 1,
    });
    expect(log.calls).toHaveLength(2);
  });

  it("does not throw when no logger is supplied (boot validation pass)", () => {
    const hook = makeDaemonHook(builder());
    expect(() =>
      hook.onLlmCall({
        provider: "openai",
        model: "fake",
        inputTokens: 1,
        outputTokens: 1,
      }),
    ).not.toThrow();
  });

  it("still records token counts when pricing is unknown (cost as 0)", () => {
    const log = fakeLogger();
    const b = builder();
    const hook = makeDaemonHook(b, log);
    hook.onLlmCall({
      provider: "openai",
      model: "fake",
      inputTokens: 7_000,
      outputTokens: 1_500,
    });
    const record = b.finalize(new Date());
    expect(record.llm.inputTokens).toBe(7_000);
    expect(record.llm.outputTokens).toBe(1_500);
    expect(record.llm.costMicros.value).toBe(0);
  });
});
