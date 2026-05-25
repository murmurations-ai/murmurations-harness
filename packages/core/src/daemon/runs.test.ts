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
import {
  RunArtifactWriter,
  type RunArtifactIndexEntry,
  type SubscriptionCliAuditContext,
} from "./runs.js";

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
    shadowCostMicros: undefined,
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

  describe("signalBundle metrics (harness#394 scope 2)", () => {
    it("includes signalBundle block when bundleMetrics is passed", async () => {
      const writer = new RunArtifactWriter({
        rootDir,
        now: () => new Date("2026-04-12T18:00:04.000Z"),
      });
      await writer.record(makeResult(), makeCostRecord(), undefined, undefined, {
        issueCount: 23,
      });
      const indexContents = await readFile(join(rootDir, "index.jsonl"), "utf8");
      const entry = JSON.parse(indexContents.trim()) as RunArtifactIndexEntry;
      expect(entry.signalBundle).toEqual({ issueCount: 23 });
    });

    it("omits signalBundle block when not supplied (legacy / no signal aggregator)", async () => {
      const writer = new RunArtifactWriter({
        rootDir,
        now: () => new Date("2026-04-12T18:00:04.000Z"),
      });
      await writer.record(makeResult(), makeCostRecord());
      const indexContents = await readFile(join(rootDir, "index.jsonl"), "utf8");
      const entry = JSON.parse(indexContents.trim()) as RunArtifactIndexEntry;
      expect(entry.signalBundle).toBeUndefined();
    });
  });

  describe("subscriptionCli audit context (T-CLI-9 / harness#301)", () => {
    const auditContext: SubscriptionCliAuditContext = {
      cliName: "claude",
      resolvedPath: "/usr/local/bin/claude",
      permissionMode: "restricted",
      allowedTools: ["mcp__murmuration-spirit__*"],
      envAllowlistApplied: true,
    };

    it("includes subscriptionCli block in index.jsonl when configured", async () => {
      const writer = new RunArtifactWriter({
        rootDir,
        now: () => new Date("2026-04-12T18:00:04.000Z"),
        subscriptionCli: auditContext,
      });
      await writer.record(makeResult(), makeCostRecord());

      const indexPath = join(rootDir, "index.jsonl");
      const indexContents = await readFile(indexPath, "utf8");
      const entry = JSON.parse(indexContents.trim()) as RunArtifactIndexEntry;

      expect(entry.subscriptionCli).toEqual(auditContext);
      expect(entry.subscriptionCli?.cliName).toBe("claude");
      expect(entry.subscriptionCli?.permissionMode).toBe("restricted");
      expect(entry.subscriptionCli?.resolvedPath).toBe("/usr/local/bin/claude");
      expect(entry.subscriptionCli?.allowedTools).toEqual(["mcp__murmuration-spirit__*"]);
      expect(entry.subscriptionCli?.envAllowlistApplied).toBe(true);
    });

    it("omits subscriptionCli block from index.jsonl when not a subscription-CLI wake", async () => {
      const writer = new RunArtifactWriter({
        rootDir,
        now: () => new Date("2026-04-12T18:00:04.000Z"),
      });
      await writer.record(makeResult(), makeCostRecord());

      const indexPath = join(rootDir, "index.jsonl");
      const indexContents = await readFile(indexPath, "utf8");
      const entry = JSON.parse(indexContents.trim()) as RunArtifactIndexEntry;

      expect(entry.subscriptionCli).toBeUndefined();
    });

    it("records trusted permissionMode when configured as trusted", async () => {
      const trustedContext: SubscriptionCliAuditContext = {
        ...auditContext,
        permissionMode: "trusted",
      };
      const writer = new RunArtifactWriter({
        rootDir,
        now: () => new Date("2026-04-12T18:00:04.000Z"),
        subscriptionCli: trustedContext,
      });
      await writer.record(makeResult(), makeCostRecord());

      const indexPath = join(rootDir, "index.jsonl");
      const indexContents = await readFile(indexPath, "utf8");
      const entry = JSON.parse(indexContents.trim()) as RunArtifactIndexEntry;

      expect(entry.subscriptionCli?.permissionMode).toBe("trusted");
    });

    it("persists subscriptionCli block across multiple wakes on the same writer", async () => {
      const writer = new RunArtifactWriter({
        rootDir,
        now: () => new Date("2026-04-12T18:00:04.000Z"),
        subscriptionCli: auditContext,
      });
      await writer.record(
        makeResult({ wakeId: makeWakeId("aaaaaaaa-0000-0000-0000-000000000001") }),
        makeCostRecord(),
      );
      await writer.record(
        makeResult({ wakeId: makeWakeId("aaaaaaaa-0000-0000-0000-000000000002") }),
        makeCostRecord(),
      );

      const indexPath = join(rootDir, "index.jsonl");
      const indexContents = await readFile(indexPath, "utf8");
      const lines = indexContents.trim().split("\n");
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        const entry = JSON.parse(line) as RunArtifactIndexEntry;
        expect(entry.subscriptionCli?.cliName).toBe("claude");
        expect(entry.subscriptionCli?.envAllowlistApplied).toBe(true);
      }
    });
  });

  describe("validation propagation", () => {
    it("omits validation fields when no WakeValidationResult is passed", async () => {
      const writer = new RunArtifactWriter({
        rootDir,
        now: () => new Date("2026-04-12T18:00:04.000Z"),
      });
      await writer.record(makeResult(), makeCostRecord());

      const indexPath = join(rootDir, "index.jsonl");
      const entry = JSON.parse((await readFile(indexPath, "utf8")).trim()) as RunArtifactIndexEntry;

      expect(entry.validationStatus).toBeUndefined();
      expect(entry.obligationStatus).toBeUndefined();
      expect(entry.productive).toBeUndefined();
      expect(entry.unmetRequiredOutputsCount).toBeUndefined();
    });

    it("records validationStatus=productive when validation passes", async () => {
      const writer = new RunArtifactWriter({
        rootDir,
        now: () => new Date("2026-04-12T18:00:04.000Z"),
      });
      await writer.record(makeResult(), makeCostRecord(), undefined, {
        productive: true,
        artifactCount: 2,
        actionItemsAddressed: 0,
        actionItemsAssigned: 0,
        directivesUnaddressed: [],
      });

      const entry = JSON.parse(
        (await readFile(join(rootDir, "index.jsonl"), "utf8")).trim(),
      ) as RunArtifactIndexEntry;

      expect(entry.validationStatus).toBe("productive");
      expect(entry.productive).toBe(true);
      expect(entry.artifactCount).toBe(2);
      expect(entry.directivesUnaddressed).toBe(0);
    });

    it("records validationStatus=idle when not productive and no directives unaddressed", async () => {
      const writer = new RunArtifactWriter({
        rootDir,
        now: () => new Date("2026-04-12T18:00:04.000Z"),
      });
      await writer.record(makeResult(), makeCostRecord(), undefined, {
        productive: false,
        artifactCount: 0,
        actionItemsAddressed: 0,
        actionItemsAssigned: 0,
        directivesUnaddressed: [],
        reason: "wake completed but produced no artifacts",
      });

      const entry = JSON.parse(
        (await readFile(join(rootDir, "index.jsonl"), "utf8")).trim(),
      ) as RunArtifactIndexEntry;

      expect(entry.validationStatus).toBe("idle");
    });

    it("records validationStatus=unaddressed-directives when boundary 5 fires", async () => {
      const writer = new RunArtifactWriter({
        rootDir,
        now: () => new Date("2026-04-12T18:00:04.000Z"),
      });
      await writer.record(makeResult(), makeCostRecord(), undefined, {
        productive: false,
        artifactCount: 0,
        actionItemsAddressed: 0,
        actionItemsAssigned: 0,
        directivesUnaddressed: [{ issueNumber: 845, reason: "narrative-only-claim" }],
        reason: "1 directive(s) in signals not addressed by structured evidence",
      });

      const entry = JSON.parse(
        (await readFile(join(rootDir, "index.jsonl"), "utf8")).trim(),
      ) as RunArtifactIndexEntry;

      expect(entry.validationStatus).toBe("unaddressed-directives");
      expect(entry.directivesUnaddressed).toBe(1);
    });

    it("records validationStatus=obligation-unmet with unmetRequiredOutputsCount", async () => {
      const writer = new RunArtifactWriter({
        rootDir,
        now: () => new Date("2026-04-12T18:00:04.000Z"),
      });
      await writer.record(makeResult(), makeCostRecord(), undefined, {
        productive: false,
        artifactCount: 1,
        actionItemsAddressed: 0,
        actionItemsAssigned: 0,
        directivesUnaddressed: [],
        obligationStatus: "unmet",
        unmetRequiredOutputs: [
          {
            kind: "committed-artifact",
            paths: ["drafts/**/*.md"],
            description: "test",
          },
          { kind: "comment", description: "test" },
        ],
        reason: "contract obligation unmet: 2 required output(s) without matching evidence",
      });

      const entry = JSON.parse(
        (await readFile(join(rootDir, "index.jsonl"), "utf8")).trim(),
      ) as RunArtifactIndexEntry;

      expect(entry.validationStatus).toBe("obligation-unmet");
      expect(entry.obligationStatus).toBe("unmet");
      expect(entry.unmetRequiredOutputsCount).toBe(2);
    });

    it("obligation-unmet wins precedence over unaddressed-directives", async () => {
      const writer = new RunArtifactWriter({
        rootDir,
        now: () => new Date("2026-04-12T18:00:04.000Z"),
      });
      await writer.record(makeResult(), makeCostRecord(), undefined, {
        productive: false,
        artifactCount: 0,
        actionItemsAddressed: 0,
        actionItemsAssigned: 0,
        directivesUnaddressed: [{ issueNumber: 1, reason: "narrative-only-claim" }],
        obligationStatus: "unmet",
        unmetRequiredOutputs: [{ kind: "committed-artifact", description: "test" }],
      });

      const entry = JSON.parse(
        (await readFile(join(rootDir, "index.jsonl"), "utf8")).trim(),
      ) as RunArtifactIndexEntry;

      expect(entry.validationStatus).toBe("obligation-unmet");
    });
  });
});
