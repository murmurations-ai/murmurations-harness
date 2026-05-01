/**
 * Subscription-CLI provider family — unit tests.
 *
 * Tests the parser logic (no real subprocess), interface stubs, and
 * one end-to-end happy path with a mocked CLI adapter. Live testing
 * with a real `claude` binary is operator-side.
 */

import { describe, expect, it } from "vitest";

import type { LLMRequest } from "../../types.js";

import { ClaudeCliAdapter } from "./adapters/claude.js";
import { CodexCliAdapter } from "./adapters/codex.js";
import { GeminiCliAdapter } from "./adapters/gemini.js";
import { createSubscriptionCliClient } from "./index.js";
import type { SubprocessLLMAdapter } from "./types.js";

const minimalRequest = (overrides: Partial<LLMRequest> = {}): LLMRequest => ({
  messages: [{ role: "user", content: "hello" }],
  maxOutputTokens: 1000,
  ...overrides,
});

describe("ClaudeCliAdapter.buildFlags", () => {
  const adapter = new ClaudeCliAdapter();

  it("emits -p --output-format json --dangerously-skip-permissions", () => {
    const flags = adapter.buildFlags(minimalRequest());
    expect(flags).toEqual(["-p", "--output-format", "json", "--dangerously-skip-permissions"]);
  });

  it("appends --model when set", () => {
    const flags = adapter.buildFlags(minimalRequest({ model: "claude-sonnet-4-6" }));
    expect(flags).toContain("--model");
    expect(flags).toContain("claude-sonnet-4-6");
  });

  it("never includes prompt content (ADR-0034 D1)", () => {
    const flags = adapter.buildFlags(
      minimalRequest({
        messages: [{ role: "user", content: "secret prompt material" }],
      }),
    );
    expect(flags.join(" ")).not.toContain("secret prompt material");
  });
});

describe("ClaudeCliAdapter.parseOutput", () => {
  const adapter = new ClaudeCliAdapter();

  const happyPath = [
    JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "abc",
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-sonnet-4-6-20251029",
        content: [{ type: "text", text: "ok" }],
      },
    }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      result: "hello world",
      cost_usd: 0.012,
      usage: { input_tokens: 100, output_tokens: 50 },
    }),
  ].join("\n");

  it("parses tokens, content, and normalized model from a happy stream", () => {
    const out = adapter.parseOutput(happyPath);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.content).toBe("hello world");
    expect(out.value.inputTokens).toBe(100);
    expect(out.value.outputTokens).toBe(50);
    // Date suffix stripped (cost catalog stability).
    expect(out.value.modelUsed).toBe("claude-sonnet-4-6");
    expect(out.value.providerUsed).toBe("claude-cli");
  });

  it("returns ParseError on empty output", () => {
    const out = adapter.parseOutput("");
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.kind).toBe("parse-error");
    expect(out.error.message.toLowerCase()).toContain("empty");
  });

  it("returns ParseError when usage tokens are missing (ADR-0034 D3)", () => {
    const noUsage = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "ok",
      // no usage field — must NOT silently zero
    });
    const out = adapter.parseOutput(noUsage);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.message).toContain("usage");
  });

  it("returns ParseError when no result event is present", () => {
    const noResult = JSON.stringify({
      type: "system",
      session_id: "abc",
    });
    const out = adapter.parseOutput(noResult);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.message).toContain("result event");
  });

  it("skips malformed JSON lines instead of failing the whole parse", () => {
    const withGarbage = `garbage line not json
${JSON.stringify({ type: "result", result: "ok", usage: { input_tokens: 1, output_tokens: 1 } })}`;
    const out = adapter.parseOutput(withGarbage);
    expect(out.ok).toBe(true);
  });

  it("extracts tool_use blocks from the most recent assistant event (BU-1)", () => {
    const withTools = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "thinking…" },
            { type: "tool_use", id: "t1", name: "read_file", input: { path: "x.ts" } },
          ],
          model: "claude-sonnet-4-6",
        },
      }),
      JSON.stringify({
        type: "result",
        result: "done",
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    ].join("\n");
    const out = adapter.parseOutput(withTools);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.toolCalls).toEqual([
      { name: "read_file", args: { path: "x.ts" }, result: null },
    ]);
  });

  it("preserves cache token fields when present", () => {
    const withCache = JSON.stringify({
      type: "result",
      result: "ok",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 20,
      },
    });
    const out = adapter.parseOutput(withCache);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.cacheReadTokens).toBe(80);
    expect(out.value.cacheWriteTokens).toBe(20);
  });
});

describe("CodexCliAdapter.buildFlags", () => {
  const adapter = new CodexCliAdapter();

  it("emits exec --json with sandbox bypass and stdin marker", () => {
    const flags = adapter.buildFlags(minimalRequest());
    expect(flags[0]).toBe("exec");
    expect(flags).toContain("--json");
    expect(flags).toContain("--skip-git-repo-check");
    expect(flags).toContain("--ephemeral");
    expect(flags).toContain("--dangerously-bypass-approvals-and-sandbox");
    // Trailing `-` tells codex exec to read prompt from stdin (D1).
    expect(flags[flags.length - 1]).toBe("-");
  });

  it("appends --model when set", () => {
    const flags = adapter.buildFlags(minimalRequest({ model: "gpt-5" }));
    expect(flags).toContain("--model");
    expect(flags).toContain("gpt-5");
  });

  it("never includes prompt content (ADR-0034 D1)", () => {
    const flags = adapter.buildFlags(
      minimalRequest({
        messages: [{ role: "user", content: "secret prompt material" }],
      }),
    );
    expect(flags.join(" ")).not.toContain("secret prompt material");
  });
});

describe("CodexCliAdapter.parseOutput", () => {
  const adapter = new CodexCliAdapter();

  const happyPath = [
    JSON.stringify({ type: "thread.started", thread_id: "t1" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({
      type: "item.completed",
      item: { id: "item_0", type: "agent_message", text: "pong" },
    }),
    JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 13304,
        cached_input_tokens: 11648,
        output_tokens: 5,
        reasoning_output_tokens: 0,
      },
    }),
  ].join("\n");

  it("parses tokens, content, and cache from a happy stream", () => {
    const out = adapter.parseOutput(happyPath);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.content).toBe("pong");
    expect(out.value.inputTokens).toBe(13304);
    expect(out.value.outputTokens).toBe(5);
    expect(out.value.cacheReadTokens).toBe(11648);
    expect(out.value.providerUsed).toBe("codex-cli");
  });

  it("returns ParseError on empty output", () => {
    const out = adapter.parseOutput("");
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.message.toLowerCase()).toContain("empty");
  });

  it("returns ParseError when turn.completed is missing (ADR-0034 D3)", () => {
    const noTurn = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "ok" },
    });
    const out = adapter.parseOutput(noTurn);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.message).toContain("turn.completed");
  });

  it("extracts function_call items as tool calls", () => {
    const withTool = [
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "fc_0",
          type: "function_call",
          name: "shell",
          arguments: JSON.stringify({ cmd: "ls" }),
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "done" },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    ].join("\n");
    const out = adapter.parseOutput(withTool);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.toolCalls).toEqual([{ name: "shell", args: { cmd: "ls" }, result: null }]);
  });
});

describe("GeminiCliAdapter.buildFlags", () => {
  const adapter = new GeminiCliAdapter();

  it("emits --output-format json --yolo and reads from stdin", () => {
    const flags = adapter.buildFlags(minimalRequest());
    expect(flags).toContain("--output-format");
    expect(flags).toContain("json");
    expect(flags).toContain("--yolo");
    // No -p flag — gemini reads from stdin when no positional arg given (D1).
    expect(flags).not.toContain("-p");
  });

  it("appends --model when set", () => {
    const flags = adapter.buildFlags(minimalRequest({ model: "gemini-2.5-flash" }));
    expect(flags).toContain("--model");
    expect(flags).toContain("gemini-2.5-flash");
  });

  it("never includes prompt content (ADR-0034 D1)", () => {
    const flags = adapter.buildFlags(
      minimalRequest({
        messages: [{ role: "user", content: "secret prompt material" }],
      }),
    );
    expect(flags.join(" ")).not.toContain("secret prompt material");
  });
});

describe("GeminiCliAdapter.parseOutput", () => {
  const adapter = new GeminiCliAdapter();

  const happyPath = JSON.stringify({
    session_id: "abc",
    response: "pong",
    stats: {
      models: {
        "gemini-2.5-flash-lite": {
          tokens: { prompt: 3511, candidates: 58, cached: 0, thoughts: 53 },
        },
        "gemini-2.5-flash": {
          tokens: { prompt: 8289, candidates: 1, cached: 7972, thoughts: 27 },
        },
      },
      tools: { totalCalls: 0 },
    },
  });

  it("sums tokens across models and reports primary model by output volume", () => {
    const out = adapter.parseOutput(happyPath);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.content).toBe("pong");
    expect(out.value.inputTokens).toBe(3511 + 8289);
    expect(out.value.outputTokens).toBe(58 + 1);
    expect(out.value.cacheReadTokens).toBe(7972);
    // flash-lite has more output tokens (58 vs 1), so it's the primary model.
    expect(out.value.modelUsed).toBe("gemini-2.5-flash-lite");
    expect(out.value.providerUsed).toBe("gemini-cli");
  });

  it("returns ParseError on empty output", () => {
    const out = adapter.parseOutput("");
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.message.toLowerCase()).toContain("empty");
  });

  it("returns ParseError when stats.models is missing (ADR-0034 D3)", () => {
    const noStats = JSON.stringify({ response: "ok" });
    const out = adapter.parseOutput(noStats);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.message).toContain("stats.models");
  });

  it("returns ParseError when stats.models has zero usable tokens", () => {
    const zeroTokens = JSON.stringify({
      response: "ok",
      stats: { models: { "gemini-2.5-flash": { tokens: {} } } },
    });
    const out = adapter.parseOutput(zeroTokens);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.message).toContain("token counts");
  });

  it("tolerates leading/trailing noise around the JSON object", () => {
    const noisy = `Loaded cached credentials.\n${happyPath}\nbye`;
    const out = adapter.parseOutput(noisy);
    expect(out.ok).toBe(true);
  });
});

describe("createSubscriptionCliClient — factory", () => {
  // Mock adapter that returns a fixed LLMResponse without spawning anything.
  const mockAdapter: SubprocessLLMAdapter = {
    command: "/bin/echo",
    providerId: "mock-cli",
    buildFlags: () => [],
    parseOutput: () => ({
      ok: true,
      value: {
        content: "mock response",
        stopReason: "stop",
        inputTokens: 7,
        outputTokens: 3,
        modelUsed: "mock-model",
        providerUsed: "mock-cli",
        toolCalls: [],
        steps: 1,
      },
    }),
    authCheck: async () =>
      Promise.resolve({ ok: true as const, value: { kind: "authenticated" as const } }),
  };

  it("builds an LLMClient with .complete and .capabilities methods", () => {
    const client = createSubscriptionCliClient({
      cli: "claude",
      model: "claude-sonnet-4-6",
      cliAdapter: mockAdapter,
    });
    expect(typeof client.complete).toBe("function");
    expect(typeof client.capabilities).toBe("function");
  });

  it("complete() round-trips a real subprocess (echo) → parser → LLMResponse", async () => {
    const client = createSubscriptionCliClient({
      cli: "claude",
      model: "test-model",
      cliAdapter: mockAdapter,
      timeoutMs: 5_000,
    });
    const result = await client.complete({
      messages: [{ role: "user", content: "hi" }],
      maxOutputTokens: 100,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content).toBe("mock response");
    expect(result.value.inputTokens).toBe(7);
    expect(result.value.outputTokens).toBe(3);
  });

  it("capabilities() reports the configured provider id", () => {
    const client = createSubscriptionCliClient({
      cli: "claude",
      model: "test",
      cliAdapter: mockAdapter,
    });
    expect(client.capabilities().provider).toBe("mock-cli");
  });

  it("capabilities() defaults to supportsToolUse=false (BU-1 conservative)", () => {
    const client = createSubscriptionCliClient({
      cli: "claude",
      model: "test",
      cliAdapter: mockAdapter,
    });
    expect(client.capabilities().supportsToolUse).toBe(false);
  });

  it("forwards bound model to buildFlags when request.model is unset", async () => {
    // Regression: runner/index.ts deliberately does not set request.model
    // (relies on bound model). Subprocess adapter must default it from
    // its construction-time model, otherwise --model never reaches the CLI.
    let observedModel: string | undefined;
    const probeAdapter: SubprocessLLMAdapter = {
      ...mockAdapter,
      buildFlags: (req) => {
        observedModel = req.model;
        return [];
      },
    };
    const client = createSubscriptionCliClient({
      cli: "codex",
      model: "gpt-5.5",
      cliAdapter: probeAdapter,
    });
    await client.complete({
      messages: [{ role: "user", content: "hi" }],
      maxOutputTokens: 100,
    });
    expect(observedModel).toBe("gpt-5.5");
  });

  it("preserves explicit request.model over bound model when both are set", async () => {
    let observedModel: string | undefined;
    const probeAdapter: SubprocessLLMAdapter = {
      ...mockAdapter,
      buildFlags: (req) => {
        observedModel = req.model;
        return [];
      },
    };
    const client = createSubscriptionCliClient({
      cli: "codex",
      model: "gpt-5.5",
      cliAdapter: probeAdapter,
    });
    await client.complete({
      messages: [{ role: "user", content: "hi" }],
      maxOutputTokens: 100,
      model: "gpt-4o",
    });
    expect(observedModel).toBe("gpt-4o");
  });
});
