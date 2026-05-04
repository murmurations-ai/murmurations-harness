/**
 * `murmuration metrics [--json] [--since <days>]` — static effectiveness
 * snapshot computed from on-disk artifacts (no daemon required).
 *
 * Computation lives in `@murmurations-ai/core` (`computeMetricsFromDisk`)
 * so the dashboard tab can reuse it without duplicating the JSONL reader.
 *
 * @see docs/specs/0001-agent-effectiveness.md §8
 * @see ADR-0042 (effectiveness metrics surface)
 */

import { computeMetricsFromDisk, type DiskMetricsSnapshot } from "@murmurations-ai/core";

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

const formatMetricsTable = (s: DiskMetricsSnapshot): string => {
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
