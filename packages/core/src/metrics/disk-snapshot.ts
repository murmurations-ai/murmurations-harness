/**
 * Metrics snapshot computed from on-disk artifacts (no daemon required).
 *
 * Sources:
 *   - `<root>/runs/<agentId>/index.jsonl`                   wake records (Phase 2D5)
 *   - `<root>/.murmuration/accountability-observations.jsonl` done_when observations (Workstream H)
 *
 * Surfaces consuming this:
 *   - `murmuration metrics --json` (Workstream K1)
 *   - dashboard tab in `@murmurations-ai/dashboard-tui` (Workstream K2)
 *
 * Skips GitHub-derived metrics (closure rate, age distribution,
 * cost-per-closed) — those need GitHub state and live in the
 * daemon-hosted `metrics.snapshot` RPC alongside this static view.
 *
 * @see docs/specs/0001-agent-effectiveness.md §8
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { computeAccountabilityMetRates, type AccountabilityMetRate } from "./effectiveness.js";
import { AccountabilityObservationStore } from "./observations.js";
import type { RunArtifactIndexEntry } from "../daemon/runs.js";

export interface AgentWakeStats {
  readonly agentId: string;
  readonly totalWakes: number;
  readonly completedWakes: number;
  readonly completionRate: number;
  readonly totalCostMicros: number;
}

export interface DiskMetricsSnapshot {
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly windowDays: number;
  readonly aggregate: {
    readonly totalWakes: number;
    readonly completedWakes: number;
    readonly completionRate: number;
    readonly totalCostMicros: number;
  };
  readonly perAgent: readonly AgentWakeStats[];
  readonly accountabilityMetRates: readonly AccountabilityMetRate[];
  readonly notes: readonly string[];
}

export const computeMetricsFromDisk = async (input: {
  readonly rootDir: string;
  readonly since: Date;
  readonly now: Date;
  readonly windowDays: number;
}): Promise<DiskMetricsSnapshot> => {
  const wakeEntries = await readAllWakeEntries(input.rootDir);
  const inWindow = wakeEntries.filter((e) => {
    const t = new Date(e.startedAt).getTime();
    return t >= input.since.getTime() && t <= input.now.getTime();
  });

  const perAgentMap = new Map<string, { total: number; completed: number; cost: number }>();
  let aggTotal = 0;
  let aggCompleted = 0;
  let aggCost = 0;

  for (const entry of inWindow) {
    const bucket = perAgentMap.get(entry.agentId) ?? { total: 0, completed: 0, cost: 0 };
    bucket.total += 1;
    if (entry.outcome === "completed") bucket.completed += 1;
    bucket.cost += entry.totals.costMicros;
    perAgentMap.set(entry.agentId, bucket);

    aggTotal += 1;
    if (entry.outcome === "completed") aggCompleted += 1;
    aggCost += entry.totals.costMicros;
  }

  const perAgent: AgentWakeStats[] = [];
  for (const [agentId, b] of perAgentMap) {
    perAgent.push({
      agentId,
      totalWakes: b.total,
      completedWakes: b.completed,
      completionRate: b.total === 0 ? 0 : b.completed / b.total,
      totalCostMicros: b.cost,
    });
  }
  perAgent.sort((a, b) => a.agentId.localeCompare(b.agentId));

  const observationsPath = join(input.rootDir, ".murmuration", "accountability-observations.jsonl");
  const store = new AccountabilityObservationStore({ path: observationsPath });
  const observations = await store.readAll();
  const accountabilityMetRates = computeAccountabilityMetRates({
    observations,
    since: input.since,
    now: input.now,
  });

  const notes: string[] = [];
  if (wakeEntries.length === 0) {
    notes.push("No wake records found at <root>/runs/<agent>/index.jsonl — start the daemon.");
  }
  if (observations.length === 0) {
    notes.push(
      "No accountability observations found — done_when validators emit one per wake (Workstream H).",
    );
  }
  notes.push(
    "Issue-closure rate, age distribution, and cost-per-closed are not in this view (require GitHub state — see daemon `metrics.snapshot` RPC).",
  );

  return {
    windowStart: input.since.toISOString(),
    windowEnd: input.now.toISOString(),
    windowDays: input.windowDays,
    aggregate: {
      totalWakes: aggTotal,
      completedWakes: aggCompleted,
      completionRate: aggTotal === 0 ? 0 : aggCompleted / aggTotal,
      totalCostMicros: aggCost,
    },
    perAgent,
    accountabilityMetRates,
    notes,
  };
};

// ---------------------------------------------------------------------------
// Disk reader — walks <root>/runs/<agent>/index.jsonl
// ---------------------------------------------------------------------------

const readAllWakeEntries = async (rootDir: string): Promise<readonly RunArtifactIndexEntry[]> => {
  const runsDir = join(rootDir, "runs");
  let agentDirs: readonly string[];
  try {
    const entries = await readdir(runsDir, { withFileTypes: true });
    agentDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }

  const out: RunArtifactIndexEntry[] = [];
  for (const agentDir of agentDirs) {
    const indexPath = join(runsDir, agentDir, "index.jsonl");
    try {
      await stat(indexPath);
    } catch {
      continue;
    }
    let content: string;
    try {
      content = await readFile(indexPath, "utf8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isIndexEntry(parsed)) out.push(parsed);
      } catch {
        /* skip malformed line */
      }
    }
  }
  return out;
};

interface IndexEntryShape {
  readonly wakeId?: unknown;
  readonly agentId?: unknown;
  readonly outcome?: unknown;
  readonly startedAt?: unknown;
  readonly totals?: unknown;
}

const isIndexEntry = (raw: unknown): raw is RunArtifactIndexEntry => {
  if (typeof raw !== "object" || raw === null) return false;
  const r = raw as IndexEntryShape;
  return (
    typeof r.wakeId === "string" &&
    typeof r.agentId === "string" &&
    typeof r.outcome === "string" &&
    typeof r.startedAt === "string" &&
    typeof r.totals === "object" &&
    r.totals !== null
  );
};
