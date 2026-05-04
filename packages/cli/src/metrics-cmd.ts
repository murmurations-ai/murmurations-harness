/**
 * `murmuration metrics [--json] [--since <days>]` — static effectiveness
 * snapshot computed from on-disk artifacts (no daemon required).
 *
 * Sources:
 *   - `<root>/runs/<agentId>/index.jsonl`                   wake records (Phase 2D5)
 *   - `<root>/.murmuration/accountability-observations.jsonl` done_when observations (Workstream H)
 *
 * What this command computes (everything that needs no GitHub round-trip):
 *
 *   - wake completion rate (per agent + aggregate) from `outcome` field
 *   - total spend over the window (USD micros, summed from cost records)
 *   - per-accountability met-rate from observations
 *
 * What it deliberately skips (requires GitHub state — provided by the
 * forthcoming `metrics.snapshot` daemon RPC + dashboard tab in K2):
 *
 *   - issue closure rate by type
 *   - open-issue age distribution
 *   - cost per closed issue
 *
 * @see docs/specs/0001-agent-effectiveness.md §8
 * @see ADR-0042 (effectiveness metrics surface)
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  AccountabilityObservationStore,
  computeAccountabilityMetRates,
  type AccountabilityMetRate,
  type RunArtifactIndexEntry,
} from "@murmurations-ai/core";

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

export interface AgentWakeStats {
  readonly agentId: string;
  readonly totalWakes: number;
  readonly completedWakes: number;
  readonly completionRate: number;
  readonly totalCostMicros: number;
}

export interface MetricsSnapshot {
  readonly windowStart: string; // ISO
  readonly windowEnd: string; // ISO
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

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

export const runMetrics = async (args: readonly string[], rootDir: string): Promise<void> => {
  const jsonFlag = args.includes("--json");
  const sinceIdx = args.indexOf("--since");
  const sinceDays = sinceIdx >= 0 ? Number(args[sinceIdx + 1] ?? "30") : 30;
  if (!Number.isFinite(sinceDays) || sinceDays <= 0) {
    process.stderr.write(`murmuration metrics: --since must be a positive number\n`);
    process.exit(2);
  }

  const now = new Date();
  const since = new Date(now.getTime() - sinceDays * 24 * 60 * 60 * 1000);

  const snapshot = await computeMetricsFromDisk({ rootDir, since, now, windowDays: sinceDays });

  if (jsonFlag) {
    process.stdout.write(JSON.stringify(snapshot, null, 2) + "\n");
    return;
  }

  process.stdout.write(formatMetricsTable(snapshot) + "\n");
};

// ---------------------------------------------------------------------------
// Computation
// ---------------------------------------------------------------------------

export const computeMetricsFromDisk = async (input: {
  readonly rootDir: string;
  readonly since: Date;
  readonly now: Date;
  readonly windowDays: number;
}): Promise<MetricsSnapshot> => {
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
    "Issue-closure rate, age distribution, and cost-per-closed are not in this view (require GitHub state — see dashboard or `metrics.snapshot` RPC).",
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

// ---------------------------------------------------------------------------
// Table formatter
// ---------------------------------------------------------------------------

const formatMetricsTable = (s: MetricsSnapshot): string => {
  const lines: string[] = [];
  lines.push(
    `Effectiveness window: last ${String(s.windowDays)}d (${s.windowStart.slice(0, 10)} → ${s.windowEnd.slice(0, 10)})`,
  );
  lines.push("");

  const agg = s.aggregate;
  const aggRate =
    agg.totalWakes === 0 ? "—" : `${(agg.completionRate * 100).toFixed(1).padStart(5)}%`;
  const aggCostUsd = (agg.totalCostMicros / 1_000_000).toFixed(2);
  lines.push(
    `Aggregate: ${String(agg.totalWakes)} wakes (${String(agg.completedWakes)} completed, ${aggRate}); $${aggCostUsd} USD`,
  );
  lines.push("");

  lines.push("Per-agent wake completion:");
  if (s.perAgent.length === 0) {
    lines.push("  (no wake records in window)");
  } else {
    const header = "  " + "AGENT".padEnd(25) + "  WAKES  COMPL  RATE   COST_USD";
    lines.push(header);
    lines.push("  " + "─".repeat(header.length));
    for (const a of s.perAgent) {
      const rate = a.totalWakes === 0 ? "—" : `${(a.completionRate * 100).toFixed(1).padStart(5)}%`;
      const usd = (a.totalCostMicros / 1_000_000).toFixed(4);
      lines.push(
        `  ${a.agentId.padEnd(25)}  ${String(a.totalWakes).padStart(5)}  ${String(a.completedWakes).padStart(5)}  ${rate}  ${usd.padStart(8)}`,
      );
    }
  }
  lines.push("");

  lines.push("Accountability met-rate:");
  if (s.accountabilityMetRates.length === 0) {
    lines.push("  (no observations in window)");
  } else {
    const header = "  " + "ACCOUNTABILITY".padEnd(40) + "  N    MET    RATE";
    lines.push(header);
    lines.push("  " + "─".repeat(header.length));
    for (const r of s.accountabilityMetRates) {
      const rate = r.observations === 0 ? "—" : `${(r.rate * 100).toFixed(1).padStart(5)}%`;
      lines.push(
        `  ${r.accountabilityId.padEnd(40)}  ${String(r.observations).padStart(3)}  ${String(r.metCount).padStart(4)}   ${rate}`,
      );
    }
  }

  if (s.notes.length > 0) {
    lines.push("");
    lines.push("Notes:");
    for (const n of s.notes) lines.push(`  • ${n}`);
  }

  return lines.join("\n");
};
