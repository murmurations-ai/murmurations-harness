/**
 * Runner tests — focused on MCP tool loading path and LLM integration.
 *
 * Creates a minimal fixture on disk (wake prompt, identity files) so
 * the runner can assemble prompts, then verifies tool loading and
 * LLM call behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createDefaultRunner } from "./index.js";
import type { DefaultRunnerClients, RunnerToolDefinition } from "./index.js";
import type { AgentSpawnContext } from "../execution/index.js";
import { makeAgentId, makeWakeId } from "../execution/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let rootDir: string;

const writeFixture = async (path: string, content: string): Promise<void> => {
  const full = join(rootDir, path);
  const dir = full.substring(0, full.lastIndexOf("/"));
  await mkdir(dir, { recursive: true });
  await writeFile(full, content, "utf8");
};

const makeSpawn = (overrides: Partial<AgentSpawnContext> = {}): AgentSpawnContext => ({
  wakeId: makeWakeId(),
  agentId: makeAgentId("test-agent"),
  identity: {
    agentId: makeAgentId("test-agent"),
    layers: [
      { kind: "murmuration-soul" as const, content: "# Soul\nShared." },
      { kind: "agent-soul" as const, content: "# Agent Soul\nChar." },
      { kind: "agent-role" as const, content: "# Role\nTest agent role." },
    ],
    frontmatter: {
      agentId: makeAgentId("test-agent"),
      name: "Test Agent",
      modelTier: "fast" as const,
      groupMemberships: [],
    },
  },
  signals: { signals: [], actionItems: [], updatedAt: new Date() },
  wakeReason: "scheduled",
  wakeMode: "individual",
  budget: { maxCostMicros: 100_000, maxGithubApiCalls: 10, onBreach: "warn" },
  environment: {},
  ...overrides,
});

const makeLlmClient = (responseContent: string): NonNullable<DefaultRunnerClients["llm"]> => {
  const calls: unknown[] = [];
  return {
    complete: (opts: Record<string, unknown>) => {
      calls.push(opts);
      return Promise.resolve({
        ok: true as const,
        value: {
          content: `${responseContent}\n\n## Self-Reflection\nEFFECTIVENESS: high\nOBSERVATION: Test completed.\nGOVERNANCE_EVENT: none`,
          inputTokens: 100,
          outputTokens: 200,
          modelUsed: "test-model",
        },
      });
    },
    _calls: calls,
  } as NonNullable<DefaultRunnerClients["llm"]> & { _calls: unknown[] };
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "runner-test-"));

  // Minimal fixtures the runner needs
  await writeFixture("agents/test-agent/prompts/wake.md", "You are being woken. Do your job.");
});

afterEach(async () => {
  if (rootDir) await rm(rootDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createDefaultRunner", () => {
  it("runs basic wake without MCP tools", async () => {
    const runner = createDefaultRunner("test-agent", [], {}, rootDir);
    const llm = makeLlmClient("Hello, I completed my task.");

    const result = await runner({
      spawn: makeSpawn(),
      clients: { llm },
    });

    expect(result.wakeSummary).toContain("test-agent");
  });

  it("skips when no LLM client provided", async () => {
    const runner = createDefaultRunner("test-agent", [], {}, rootDir);
    const result = await runner({
      spawn: makeSpawn(),
      clients: {},
    });
    expect(result.wakeSummary).toContain("skipped");
  });

  it("loads MCP tools and passes them to LLM when mcpServerConfigs present", async () => {
    const runner = createDefaultRunner("test-agent", [], {}, rootDir);
    const llm = makeLlmClient("Used tools successfully.");

    const loadedTools: RunnerToolDefinition[] = [
      {
        name: "fs__read_file",
        description: "Read a file",
        parameters: {},
        execute: () => Promise.resolve("file contents"),
      },
    ];

    let loadToolsCalled = false;
    let closeWasCalled = false;
    let receivedParentEnv: Readonly<Record<string, string>> | undefined;

    const mcpToolLoader: NonNullable<DefaultRunnerClients["mcpToolLoader"]> = {
      loadTools: (_servers, parentEnv) => {
        loadToolsCalled = true;
        receivedParentEnv = parentEnv;
        return Promise.resolve(loadedTools);
      },
      close: () => {
        closeWasCalled = true;
        return Promise.resolve();
      },
    };

    const spawn = makeSpawn({
      mcpServerConfigs: [{ name: "fs", command: "npx", args: ["-y", "mcp-fs"] }],
      environment: { SOME_SECRET: "value123" },
    });

    const result = await runner({
      spawn,
      clients: { llm, mcpToolLoader },
    });

    expect(result.wakeSummary).toContain("test-agent");
    expect(loadToolsCalled).toBe(true);
    expect(closeWasCalled).toBe(true);
    expect(receivedParentEnv).toEqual({ SOME_SECRET: "value123" });

    // Verify tools were passed to LLM
    const llmCalls = (llm as unknown as { _calls: { tools?: unknown; maxSteps?: number }[] })
      ._calls;
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0]?.tools).toBeDefined();
    expect(llmCalls[0]?.tools).toHaveLength(1);
    expect(llmCalls[0]?.maxSteps).toBe(5);
  });

  it("does not load tools when no mcpServerConfigs", async () => {
    const runner = createDefaultRunner("test-agent", [], {}, rootDir);
    const llm = makeLlmClient("No tools needed.");

    let loadToolsCalled = false;
    const mcpToolLoader: NonNullable<DefaultRunnerClients["mcpToolLoader"]> = {
      loadTools: () => {
        loadToolsCalled = true;
        return Promise.resolve([]);
      },
      close: () => Promise.resolve(),
    };

    await runner({
      spawn: makeSpawn(), // no mcpServerConfigs
      clients: { llm, mcpToolLoader },
    });

    expect(loadToolsCalled).toBe(false);
  });

  it("closes MCP connections even when LLM call fails", async () => {
    const runner = createDefaultRunner("test-agent", [], {}, rootDir);

    const llm: NonNullable<DefaultRunnerClients["llm"]> = {
      complete: () =>
        Promise.resolve({
          ok: false as const,
          error: { code: "INTERNAL", message: "LLM exploded" },
        }),
    };

    let closeWasCalled = false;
    const mcpToolLoader: NonNullable<DefaultRunnerClients["mcpToolLoader"]> = {
      loadTools: () =>
        Promise.resolve([
          { name: "t", description: "t", parameters: {}, execute: () => Promise.resolve("x") },
        ]),
      close: () => {
        closeWasCalled = true;
        return Promise.resolve();
      },
    };

    const spawn = makeSpawn({
      mcpServerConfigs: [{ name: "t", command: "echo", args: [] }],
    });

    await expect(runner({ spawn, clients: { llm, mcpToolLoader } })).rejects.toThrow("LLM failed");

    expect(closeWasCalled).toBe(true);
  });

  it("detects governance events in LLM output", async () => {
    const runner = createDefaultRunner("test-agent", [], {}, rootDir);

    const llmWithGovernance: NonNullable<DefaultRunnerClients["llm"]> = {
      complete: () =>
        Promise.resolve({
          ok: true as const,
          value: {
            content:
              "Found an issue.\n\n## Self-Reflection\nEFFECTIVENESS: medium\nOBSERVATION: Found a problem.\nGOVERNANCE_EVENT:\n  TENSION: We need better monitoring",
            inputTokens: 50,
            outputTokens: 100,
            modelUsed: "test-model",
          },
        }),
    };

    const result = await runner({
      spawn: makeSpawn(),
      clients: { llm: llmWithGovernance },
    });

    expect(result.governanceEvents).toBeDefined();
    expect(result.governanceEvents!.length).toBeGreaterThanOrEqual(1);
    expect(result.governanceEvents![0]?.kind).toBe("tension");
  });
});
