import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeUSDMicros } from "../cost/usd.js";
import type { WakeCostRecord } from "../cost/record.js";
import {
  InternalExecutorError,
  makeAgentId,
  makeWakeId,
  type AgentResult,
} from "../execution/index.js";
import { RunArtifactWriter, type RunArtifactIndexEntry } from "./runs.js";

const WAKE_START = new Date("2026-04-12T18:00:00.000Z");
const WAKE_END = new Date("2026-04-12T18:00:03.500Z");
const WAKE_ID = "3986ebbc-43f0-4d0a-bb7d-71e69b5d7dfc";

const makeResult = (overrides: Partial<AgentResult> = {}): AgentResult => ({
  wakeId: makeWakeId(WAKE_ID),
  agentId: makeAgentId("01-research"),
  outcome: { kind: "completed" },
  outputs: [],
  governanceEvents: [],
  actions: [],
  actionReceipts: [],
  cost: {
    inputTokens: 1200,
    outputTokens: 350,
    wallClockMs: 3500,
    costMicros: 4500,
    budgetOverrunEvents: 0,
  },
  wakeSummary:
    "## Trending\n- foo — something moving — high\n## Underserved\n- bar — gap — medium\n",
  startedAt: WAKE_START,
  finishedAt: WAKE_END,
  ...overrides,
});

const makeCostRecord = (): WakeCostRecord => ({
  schemaVersion: 1,
  wakeId: makeWakeId(WAKE_ID),
  agentId: makeAgentId("01-research"),
  modelTier: "balanced",
  startedAt: WAKE_START,
  finishedAt: WAKE_END,
  wallClockMs: 3500,
  subprocess: undefined,
  llm: {
    inputTokens: 1200,
    outputTokens: 350,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    modelProvider: "gemini",
    modelName: "gemini-2.5-pro",
    costMicros: makeUSDMicros(4500),
  },
  github: {
    restCalls: 2,
    graphqlCalls: 1,
    cacheHits: 0,
    rateLimitRemaining: 4998,
  },
  totals: {
    costMicros: makeUSDMicros(4500),
    apiCalls: 3,
  },
  budget: null,
  rollupHints: {
    dayUtc: "2026-04-12",
    isoWeekUtc: "2026-W15",
    groupIds: ["intelligence"],
  },
});

describe("RunArtifactWriter", () => {
  let rootDir = "";

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "murmuration-runs-"));
  });

  afterEach(async () => {
    if (rootDir) await rm(rootDir, { recursive: true, force: true });
  });

  it("writes a dated digest file and appends an index.jsonl entry", async () => {
    const writer = new RunArtifactWriter({
      rootDir,
      now: () => new Date("2026-04-12T18:00:04.000Z"),
    });
    const result = makeResult();
    const costRecord = makeCostRecord();

    await writer.record(result, costRecord);

    const digestPath = join(rootDir, "2026-04-12", "digest-2026-04-12T18-00-04Z-3986ebbc.md");
    const stats = await stat(digestPath);
    expect(stats.isFile()).toBe(true);

    const digestBody = await readFile(digestPath, "utf8");
    expect(digestBody).toContain(`wake_id: ${WAKE_ID}`);
    expect(digestBody).toContain("agent_id: 01-research");
    expect(digestBody).toContain("outcome: completed");
    expect(digestBody).toContain("llm_provider: gemini");
    expect(digestBody).toContain("llm_model: gemini-2.5-pro");
    expect(digestBody).toContain("## Trending");

    const indexPath = join(rootDir, "index.jsonl");
    const indexContents = await readFile(indexPath, "utf8");
    // One line + trailing newline.
    expect(indexContents.endsWith("\n")).toBe(true);
    const lines = indexContents.trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry: RunArtifactIndexEntry = JSON.parse(lines[0] ?? "{}");
    expect(entry.schemaVersion).toBe(1);
    expect(entry.wakeId).toBe(WAKE_ID);
    expect(entry.agentId).toBe("01-research");
    expect(entry.outcome).toBe("completed");
    expect(entry.modelTier).toBe("balanced");
    expect(entry.llm.provider).toBe("gemini");
    expect(entry.llm.model).toBe("gemini-2.5-pro");
    expect(entry.llm.inputTokens).toBe(1200);
    expect(entry.llm.outputTokens).toBe(350);
    expect(entry.llm.costMicros).toBe(4500);
    expect(entry.github.restCalls).toBe(2);
    expect(entry.github.graphqlCalls).toBe(1);
    expect(entry.totals.apiCalls).toBe(3);
    expect(entry.digestPath).toBe("2026-04-12/digest-2026-04-12T18-00-04Z-3986ebbc.md");
  });

  it("appends to index.jsonl across multiple wakes on the same day", async () => {
    const writer = new RunArtifactWriter({
      rootDir,
      now: () => new Date("2026-04-12T18:00:04.000Z"),
    });
    await writer.record(
      makeResult({
        wakeId: makeWakeId("11111111-1111-1111-1111-111111111111"),
      }),
      makeCostRecord(),
    );
    await writer.record(
      makeResult({
        wakeId: makeWakeId("22222222-2222-2222-2222-222222222222"),
      }),
      makeCostRecord(),
    );

    const indexContents = await readFile(join(rootDir, "index.jsonl"), "utf8");
    const lines = indexContents.trim().split("\n");
    expect(lines).toHaveLength(2);
    const a = JSON.parse(lines[0] ?? "{}") as RunArtifactIndexEntry;
    const b = JSON.parse(lines[1] ?? "{}") as RunArtifactIndexEntry;
    expect(a.wakeId).toBe("11111111-1111-1111-1111-111111111111");
    expect(b.wakeId).toBe("22222222-2222-2222-2222-222222222222");
    // Distinct digest filenames — no clobbering.
    expect(a.digestPath).toBe("2026-04-12/digest-2026-04-12T18-00-04Z-11111111.md");
    expect(b.digestPath).toBe("2026-04-12/digest-2026-04-12T18-00-04Z-22222222.md");
  });

  it("records a failed outcome with unknown provider when costRecord is absent", async () => {
    const writer = new RunArtifactWriter({
      rootDir,
      now: () => new Date("2026-04-12T18:00:04.000Z"),
    });
    const result = makeResult({
      outcome: {
        kind: "failed",
        error: new InternalExecutorError("boom"),
      },
      cost: {
        inputTokens: 0,
        outputTokens: 0,
        wallClockMs: 100,
        costMicros: 0,
        budgetOverrunEvents: 0,
      },
      wakeSummary: "",
    });

    await writer.record(result, undefined);

    const indexContents = await readFile(join(rootDir, "index.jsonl"), "utf8");
    const entry = JSON.parse(indexContents.trim()) as RunArtifactIndexEntry;
    expect(entry.outcome).toBe("failed");
    expect(entry.llm.provider).toBe("unknown");
    expect(entry.llm.model).toBe("unknown");
    expect(entry.llm.costMicros).toBe(0);
    expect(entry.modelTier).toBe("unknown");
  });

  it("swallows I/O errors and reports them via the logger", async () => {
    // Point the writer at a path where mkdir will fail (inside a
    // non-writable location). Using a file as the rootDir triggers
    // ENOTDIR when the writer tries to mkdir a subdirectory.
    const blockedDir = join(rootDir, "blocker");
    // Create a regular file at `blockedDir` — any mkdir under it fails.
    await (async (): Promise<void> => {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(blockedDir, "not a directory", "utf8");
    })();

    const writer = new RunArtifactWriter({
      rootDir: blockedDir,
      now: () => new Date("2026-04-12T18:00:04.000Z"),
    });

    const warnings: { event: string; data: Record<string, unknown> }[] = [];
    const logger = {
      warn: (event: string, data: Record<string, unknown>): void => {
        warnings.push({ event, data });
      },
    };

    // Should not throw.
    await writer.record(makeResult(), makeCostRecord(), logger);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.event).toBe("daemon.runs.write.failed");
    expect(warnings[0]?.data.wakeId).toBe(WAKE_ID);
  });
});
