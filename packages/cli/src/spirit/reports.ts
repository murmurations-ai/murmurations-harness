/**
 * Spirit reporting surfaces — Workstream Q.
 *
 * Three operator-facing synthesis tools:
 *
 *   - `metrics`         — thin wrapper over K1's computeMetricsFromDisk
 *   - `attention_queue` — failing agents + low met-rate + awaiting-source-close, ranked
 *   - `report(scope?)`  — combines the above + recent events into prose
 *
 * Reporting is intentionally read-only and disk-first. Daemon RPCs are
 * consulted opportunistically — if no daemon is running, the disk
 * fallbacks still work.
 *
 * @see docs/specs/0002-spirit-meta-agent.md §5 Workstream Q
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { computeMetricsFromDisk, type DiskMetricsSnapshot } from "@murmurations-ai/core";

interface SocketResponse {
  readonly id: string;
  readonly result?: unknown;
  readonly error?: string;
}

type Send = (method: string, params?: Record<string, unknown>) => Promise<SocketResponse>;

export type ReportScope = "health" | "activity" | "attention" | "all";

// ---------------------------------------------------------------------------
// metrics tool — wraps K1
// ---------------------------------------------------------------------------

export const fetchMetrics = async (
  rootDir: string,
  sinceDays: number,
): Promise<DiskMetricsSnapshot> => {
  const now = new Date();
  const since = new Date(now.getTime() - sinceDays * 24 * 60 * 60 * 1000);
  return computeMetricsFromDisk({ rootDir, since, now, windowDays: sinceDays });
};

export const renderMetricsMarkdown = (m: DiskMetricsSnapshot): string => {
  const lines: string[] = [
    `## Metrics (last ${String(m.windowDays)}d, ${m.windowStart.slice(0, 10)} → ${m.windowEnd.slice(0, 10)})`,
    "",
  ];
  const agg = m.aggregate;
  if (agg.totalWakes === 0) {
    lines.push("_No wake records yet._");
    return lines.join("\n");
  }
  const rate = (agg.completionRate * 100).toFixed(1);
  const usd = (agg.totalCostMicros / 1_000_000).toFixed(2);
  lines.push(
    `**Wakes:** ${String(agg.totalWakes)} · **completed:** ${String(agg.completedWakes)} (${rate}%) · **spend:** $${usd}`,
    "",
  );
  if (m.accountabilityMetRates.length > 0) {
    lines.push("**Accountability met-rate:**", "");
    for (const r of m.accountabilityMetRates) {
      const pct = (r.rate * 100).toFixed(0);
      lines.push(
        `- ${r.accountabilityId}: ${pct}% (${String(r.metCount)}/${String(r.observations)})`,
      );
    }
  }
  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// attention_queue
// ---------------------------------------------------------------------------

export interface AttentionItem {
  readonly kind: "failing-agent" | "low-met-rate" | "awaiting-close";
  readonly subject: string;
  readonly note: string;
  /** Ranking score — higher = more urgent. */
  readonly score: number;
}

export const buildAttentionQueue = async (input: {
  readonly rootDir: string;
  readonly send: Send;
  readonly sinceDays?: number;
  readonly metRateThreshold?: number; // default 0.6 — accountabilities below this are flagged
  /** When provided, skip the internal metrics fetch — used by buildReport
   *  so the same `fetchMetrics` call serves both renderMetricsMarkdown and
   *  the attention queue. */
  readonly metrics?: DiskMetricsSnapshot;
}): Promise<readonly AttentionItem[]> => {
  const sinceDays = input.sinceDays ?? 30;
  const metRateThreshold = input.metRateThreshold ?? 0.6;
  const items: AttentionItem[] = [];

  // Failing agents — best-effort daemon RPC; absent daemon → skip silently.
  try {
    const resp = await input.send("agents.list");
    const agents = (resp.result as readonly AgentRow[] | undefined) ?? [];
    for (const a of agents) {
      if (a.consecutiveFailures && a.consecutiveFailures > 0) {
        items.push({
          kind: "failing-agent",
          subject: a.agentId,
          note: `${String(a.consecutiveFailures)} consecutive failures`,
          score: 100 + a.consecutiveFailures * 10,
        });
      }
    }
  } catch {
    /* daemon not reachable — fall through */
  }

  // Low met-rate accountabilities (requires observations on disk).
  try {
    const m = input.metrics ?? (await fetchMetrics(input.rootDir, sinceDays));
    for (const r of m.accountabilityMetRates) {
      if (r.observations >= 3 && r.rate < metRateThreshold) {
        const pct = (r.rate * 100).toFixed(0);
        items.push({
          kind: "low-met-rate",
          subject: r.accountabilityId,
          note: `${pct}% met (${String(r.metCount)}/${String(r.observations)} over ${String(sinceDays)}d) — under ${String(Math.round(metRateThreshold * 100))}% threshold`,
          score: 80 + Math.round((1 - r.rate) * 50),
        });
      }
    }
  } catch {
    /* no metrics — fall through */
  }

  // Awaiting-source-close — best-effort parse of latest facilitator digest.
  const awaiting = await readAwaitingFromFacilitator(input.rootDir);
  for (const a of awaiting) {
    items.push({
      kind: "awaiting-close",
      subject: a.id,
      note: a.note,
      score: 60,
    });
  }

  items.sort((a, b) => b.score - a.score);
  return items;
};

export const renderAttentionMarkdown = (items: readonly AttentionItem[]): string => {
  if (items.length === 0) {
    return `## Source attention queue\n\n_(empty — nothing flagged for Source action right now)_`;
  }
  const lines: string[] = [`## Source attention queue (${String(items.length)} items)`, ""];
  for (const i of items) {
    const tag =
      i.kind === "failing-agent"
        ? "⚠️ failing"
        : i.kind === "low-met-rate"
          ? "📉 met-rate"
          : "🔒 awaiting close";
    lines.push(`- ${tag} **${i.subject}** — ${i.note}`);
  }
  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// report(scope) — top-level synthesis
// ---------------------------------------------------------------------------

export const buildReport = async (input: {
  readonly rootDir: string;
  readonly send: Send;
  readonly scope: ReportScope;
}): Promise<string> => {
  const sections: string[] = ["# Murmuration report", ""];

  // Fetch metrics once when any section needs them. `attention` reuses
  // accountabilityMetRates from the same snapshot via the `metrics` arg
  // below, so the two sections always reflect a single point-in-time view.
  const needsMetrics =
    input.scope === "health" || input.scope === "attention" || input.scope === "all";
  const metrics = needsMetrics ? await fetchMetrics(input.rootDir, 30) : undefined;

  if ((input.scope === "health" || input.scope === "all") && metrics) {
    sections.push(renderMetricsMarkdown(metrics));
    sections.push("");
  }

  if (input.scope === "activity" || input.scope === "all") {
    const activity = await renderActivitySection(input);
    sections.push(activity);
    sections.push("");
  }

  if (input.scope === "attention" || input.scope === "all") {
    const items = await buildAttentionQueue({
      rootDir: input.rootDir,
      send: input.send,
      ...(metrics ? { metrics } : {}),
    });
    sections.push(renderAttentionMarkdown(items));
    sections.push("");
  }

  sections.push(`_(generated ${new Date().toISOString()})_`);
  return sections.join("\n");
};

const renderActivitySection = async (input: {
  readonly rootDir: string;
  readonly send: Send;
}): Promise<string> => {
  const lines: string[] = ["## Recent activity", ""];

  // Try daemon events first — most useful when the daemon is running.
  try {
    const resp = await input.send("events.history", { limit: 15 });
    const events = (resp.result as readonly DaemonEvent[] | undefined) ?? [];
    if (events.length > 0) {
      for (const e of events) {
        const url = e.minutesUrl ? ` — ${e.minutesUrl}` : "";
        lines.push(`- ${e.date} · ${e.groupId} · ${e.kind} (${e.status})${url}`);
      }
      return lines.join("\n");
    }
  } catch {
    /* fall through to disk */
  }

  // Disk fallback: most-recent digest per agent.
  const recent = await collectMostRecentDigests(input.rootDir, 10);
  if (recent.length === 0) {
    lines.push("_(no daemon events and no agent digests on disk)_");
    return lines.join("\n");
  }
  for (const r of recent) {
    lines.push(`- ${r.day} · ${r.agentId} (${r.outcome})`);
  }
  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// Disk helpers
// ---------------------------------------------------------------------------

interface AgentRow {
  readonly agentId: string;
  readonly consecutiveFailures?: number;
}

interface DaemonEvent {
  readonly date: string;
  readonly groupId: string;
  readonly kind: string;
  readonly status: string;
  readonly minutesUrl?: string;
}

interface DigestSummary {
  readonly day: string;
  readonly agentId: string;
  readonly outcome: string;
}

const collectMostRecentDigests = async (
  rootDir: string,
  max: number,
): Promise<readonly DigestSummary[]> => {
  const runsDir = join(rootDir, "runs");
  let agents: string[];
  try {
    agents = (await readdir(runsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }

  const out: DigestSummary[] = [];
  for (const agent of agents) {
    const indexPath = join(runsDir, agent, "index.jsonl");
    let content: string;
    try {
      content = await readFile(indexPath, "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    const last = lines[lines.length - 1];
    if (!last) continue;
    try {
      const parsed = JSON.parse(last) as {
        startedAt?: string;
        outcome?: string;
        agentId?: string;
      };
      out.push({
        day: parsed.startedAt?.slice(0, 10) ?? "—",
        agentId: parsed.agentId ?? agent,
        outcome: parsed.outcome ?? "?",
      });
    } catch {
      /* skip */
    }
  }
  out.sort((a, b) => (a.day < b.day ? 1 : -1));
  return out.slice(0, max);
};

const readAwaitingFromFacilitator = async (
  rootDir: string,
): Promise<readonly { id: string; note: string }[]> => {
  const facilitatorDir = join(rootDir, "runs", "facilitator-agent");
  let dayDirs: string[];
  try {
    dayDirs = (await readdir(facilitatorDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  const latest = dayDirs[dayDirs.length - 1];
  if (!latest) return [];

  let digestFiles: string[];
  try {
    digestFiles = (await readdir(join(facilitatorDir, latest)))
      .filter((f) => f.startsWith("digest-") && f.endsWith(".md"))
      .sort();
  } catch {
    return [];
  }
  const latestDigest = digestFiles[digestFiles.length - 1];
  if (!latestDigest) return [];

  let content: string;
  try {
    content = await readFile(join(facilitatorDir, latest, latestDigest), "utf8");
  } catch {
    return [];
  }

  // Find the awaiting-source-close section (case-insensitive).
  const items: { id: string; note: string }[] = [];
  const lines = content.split("\n");
  let inSection = false;
  for (const line of lines) {
    const isHeader = /^#{1,6}\s/.test(line);
    if (isHeader) {
      const lower = line.toLowerCase();
      if (lower.includes("awaiting") && lower.includes("source")) {
        inSection = true;
        continue;
      }
      if (inSection) break;
    }
    if (inSection) {
      const m = /^[-*]\s*(#?\d+|\S+)\s*[—-]?\s*(.*)$/.exec(line.trim());
      if (m) {
        items.push({ id: m[1] ?? "?", note: m[2]?.trim() ?? "" });
      }
    }
  }
  return items;
};
