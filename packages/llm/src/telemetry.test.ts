/**
 * Telemetry tests — initLlmTelemetry / shutdownLlmTelemetry.
 *
 * These test the env-var gating and idempotency logic without
 * actually initializing OpenTelemetry (which would pollute the
 * test process). We mock NodeSDK and LangfuseSpanProcessor.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the OTEL SDK and Langfuse before importing
vi.mock("@opentelemetry/sdk-node", () => ({
  NodeSDK: class MockNodeSDK {
    start = vi.fn();
    shutdown = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock("@langfuse/otel", () => ({
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  LangfuseSpanProcessor: class MockSpanProcessor {},
}));

// Dynamic import so mocks are in place
const loadModule = async () => {
  // Each test needs a fresh module to reset the `sdk` variable
  vi.resetModules();
  return import("./telemetry.js");
};

describe("initLlmTelemetry", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns false when LANGFUSE_SECRET_KEY is missing", async () => {
    delete process.env.LANGFUSE_SECRET_KEY;
    process.env.LANGFUSE_PUBLIC_KEY = "pk_test";

    const { initLlmTelemetry } = await loadModule();
    expect(initLlmTelemetry()).toBe(false);
  });

  it("returns false when LANGFUSE_PUBLIC_KEY is missing", async () => {
    process.env.LANGFUSE_SECRET_KEY = "sk_test";
    delete process.env.LANGFUSE_PUBLIC_KEY;

    const { initLlmTelemetry } = await loadModule();
    expect(initLlmTelemetry()).toBe(false);
  });

  it("returns false when both keys are missing", async () => {
    delete process.env.LANGFUSE_SECRET_KEY;
    delete process.env.LANGFUSE_PUBLIC_KEY;

    const { initLlmTelemetry } = await loadModule();
    expect(initLlmTelemetry()).toBe(false);
  });

  it("returns true when both keys are set", async () => {
    process.env.LANGFUSE_SECRET_KEY = "sk_test";
    process.env.LANGFUSE_PUBLIC_KEY = "pk_test";

    const { initLlmTelemetry } = await loadModule();
    expect(initLlmTelemetry()).toBe(true);
  });

  it("is idempotent — second call returns false", async () => {
    process.env.LANGFUSE_SECRET_KEY = "sk_test";
    process.env.LANGFUSE_PUBLIC_KEY = "pk_test";

    const { initLlmTelemetry } = await loadModule();
    expect(initLlmTelemetry()).toBe(true);
    expect(initLlmTelemetry()).toBe(false);
  });
});

describe("shutdownLlmTelemetry", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("is a no-op when telemetry was never initialized", async () => {
    const { shutdownLlmTelemetry } = await loadModule();
    await expect(shutdownLlmTelemetry()).resolves.toBeUndefined();
  });

  it("shuts down and clears state after initialization", async () => {
    process.env.LANGFUSE_SECRET_KEY = "sk_test";
    process.env.LANGFUSE_PUBLIC_KEY = "pk_test";

    const { initLlmTelemetry, shutdownLlmTelemetry } = await loadModule();
    initLlmTelemetry();
    await shutdownLlmTelemetry();

    // After shutdown, init should work again (state cleared)
    expect(initLlmTelemetry()).toBe(true);
  });
});
