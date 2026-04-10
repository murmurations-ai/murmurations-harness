/**
 * Data readers for the four dashboard panels. Each function reads
 * from the .murmuration/ directory tree and returns structured data
 * the panel components render.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import cronParser from "cron-parser";

// ---------------------------------------------------------------------------
// Panel 1: Pipeline State — last wake per agent
// ---------------------------------------------------------------------------

export interface AgentStatus {
  readonly agentId: string;
  readonly lastWake: Date | null;
  readonly outcome: string | null;
  readonly costMicros: number;
  readonly costFormatted: string;
  readonly stale: boolean; // no wake in > 48h
  readonly nextWake: Date | null;
  readonly nextWakeCountdown: string; // human-readable "2h 14m" or "--"
}

/** Parse the cron expression from an agent's role.md frontmatter. */
const parseCronFromRole = async (rootDir: string, agentId: string): Promise<{ cron?: string | undefined; tz?: string | undefined; delayMs?: number | undefined }> => {
  try {
    const rolePath = join(rootDir, "agents", agentId, "role.md");
    const content = await readFile(rolePath, "utf8");
    const fmMatch = /^---\n([\s\S]*?)\n---/m.exec(content);
    if (!fmMatch) return {};
    const fm = fmMatch[1] ?? "";
    const cronMatch = /cron:\s*"([^"]+)"/.exec(fm);
    const tzMatch = /tz:\s*"([^"]+)"/.exec(fm);
    const delayMatch = /delayMs:\s*(\d+)/.exec(fm);
    return {
      cron: cronMatch?.[1],
      tz: tzMatch?.[1],
      delayMs: delayMatch ? Number(delayMatch[1]) : undefined,
    };
  } catch {
    return {};
  }
};

/** Compute next fire time from a cron expression. */
const computeNextFire = (cron: string, tz?: string): Date | null => {
  try {
    const parsed = cronParser.parseExpression(cron, { currentDate: new Date(), tz: tz ?? "UTC" });
    const next = parsed.next();
    return new Date(next.getTime());
  } catch {
    return null;
  }
};

/** Format a countdown like "2h 14m" or "34m" or "< 1m". */
const formatCountdown = (target: Date | null): string => {
  if (!target) return "--";
  const deltaMs = target.getTime() - Date.now();
  if (deltaMs <= 0) return "now";
  const totalMin = Math.floor(deltaMs / 60_000);
  if (totalMin < 1) return "< 1m";
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours === 0) return `${String(mins)}m`;
  return `${String(hours)}h ${String(mins).padStart(2, "0")}m`;
};

export const readPipelineState = async (rootDir: string): Promise<readonly AgentStatus[]> => {
  // Discover agents from the agents/ directory (not just runs/)
  // so we show agents that haven't woken yet too.
  const agentsDir = join(rootDir, "agents");
  let agentDirs: string[];
  try {
    const entries = await readdir(agentsDir);
    // Filter to dirs that have role.md
    const valid: string[] = [];
    for (const e of entries.sort()) {
      try {
        await readFile(join(agentsDir, e, "role.md"), "utf8");
        valid.push(e);
      } catch { /* skip */ }
    }
    agentDirs = valid;
  } catch {
    return [];
  }

  const runsDir = join(rootDir, ".murmuration", "runs");
  const results: AgentStatus[] = [];
  for (const agentId of agentDirs.sort()) {
    // Read next wake from role.md cron
    const schedule = await parseCronFromRole(rootDir, agentId);
    const nextWake = schedule.cron ? computeNextFire(schedule.cron, schedule.tz) : null;
    const nextWakeCountdown = formatCountdown(nextWake);

    const indexPath = join(runsDir, agentId, "index.jsonl");
    try {
      const contents = await readFile(indexPath, "utf8");
      const lines = contents.trim().split("\n").filter((l) => l.length > 0);
      const lastLine = lines[lines.length - 1];
      if (!lastLine) {
        results.push({ agentId, lastWake: null, outcome: null, costMicros: 0, costFormatted: "$0.0000", stale: true, nextWake, nextWakeCountdown });
        continue;
      }
      const entry = JSON.parse(lastLine) as {
        finishedAt?: string;
        outcome?: string;
        llm?: { costMicros?: number; costUsdFormatted?: string };
      };
      const lastWake = entry.finishedAt ? new Date(entry.finishedAt) : null;
      const stale = lastWake ? Date.now() - lastWake.getTime() > 48 * 3600 * 1000 : true;
      results.push({
        agentId,
        lastWake,
        outcome: entry.outcome ?? null,
        costMicros: entry.llm?.costMicros ?? 0,
        costFormatted: `$${entry.llm?.costUsdFormatted ?? "0.0000"}`,
        stale,
        nextWake,
        nextWakeCountdown,
      });
    } catch {
      results.push({ agentId, lastWake: null, outcome: null, costMicros: 0, costFormatted: "$0.0000", stale: true, nextWake, nextWakeCountdown });
    }
  }
  return results;
};

// ---------------------------------------------------------------------------
// Panel 2: Agent Activity — recent wake events from daemon log
// ---------------------------------------------------------------------------

export interface ActivityEntry {
  readonly ts: string;
  readonly agentId: string;
  readonly event: string;
  readonly detail: string;
}

export const readRecentActivity = async (rootDir: string, maxEntries = 20): Promise<readonly ActivityEntry[]> => {
  const logPath = join(rootDir, ".murmuration", "daemon.log");
  let contents: string;
  try {
    contents = await readFile(logPath, "utf8");
  } catch {
    // Also try cron.log
    try {
      contents = await readFile(join(rootDir, ".murmuration", "cron.log"), "utf8");
    } catch {
      return [];
    }
  }

  const lines = contents.trim().split("\n").filter((l) => l.length > 0);
  const entries: ActivityEntry[] = [];
  for (const line of lines.slice(-maxEntries * 3)) {
    try {
      const d = JSON.parse(line) as { ts?: string; event?: string; agentId?: string; outcome?: string; wakeSummary?: string };
      if (!d.event) continue;
      if (d.event === "daemon.wake.fire" || d.event === "daemon.wake.completed" || d.event === "daemon.wake.failed") {
        const detail = d.event === "daemon.wake.completed"
          ? (d.wakeSummary?.split("\n")[0]?.slice(0, 60) ?? d.outcome ?? "")
          : d.event === "daemon.wake.failed" ? "FAILED" : "firing...";
        entries.push({
          ts: d.ts?.slice(11, 19) ?? "",
          agentId: d.agentId ?? "?",
          event: d.event.replace("daemon.wake.", ""),
          detail,
        });
      }
    } catch {
      // skip malformed lines
    }
  }
  return entries.slice(-maxEntries);
};

// ---------------------------------------------------------------------------
// Panel 3: Governance — pending items + review-due
// ---------------------------------------------------------------------------

export interface GovernanceEntry {
  readonly id: string;
  readonly kind: string;
  readonly state: string;
  readonly createdBy: string;
  readonly reviewDue: boolean;
  readonly summary: string;
}

export const readGovernanceState = async (rootDir: string): Promise<readonly GovernanceEntry[]> => {
  const itemsPath = join(rootDir, ".murmuration", "governance", "items.jsonl");
  let contents: string;
  try {
    contents = await readFile(itemsPath, "utf8");
  } catch {
    return [];
  }

  const entries: GovernanceEntry[] = [];
  const now = Date.now();
  for (const line of contents.trim().split("\n")) {
    if (!line) continue;
    try {
      const item = JSON.parse(line) as {
        id?: string;
        kind?: string;
        currentState?: string;
        createdBy?: { value?: string };
        reviewAt?: string | null;
        payload?: { topic?: string; action?: string };
      };
      const reviewAt = item.reviewAt ? new Date(item.reviewAt).getTime() : null;
      entries.push({
        id: item.id?.slice(0, 8) ?? "?",
        kind: item.kind ?? "?",
        state: item.currentState ?? "?",
        createdBy: item.createdBy?.value ?? "?",
        reviewDue: reviewAt !== null && reviewAt < now,
        summary: (item.payload?.topic ?? item.payload?.action ?? "").slice(0, 40),
      });
    } catch {
      // skip
    }
  }
  return entries;
};

// ---------------------------------------------------------------------------
// Panel 4: Cost & Budget — aggregated from all index.jsonl files
// ---------------------------------------------------------------------------

export interface CostSummary {
  readonly todayMicros: number;
  readonly todayWakes: number;
  readonly weekMicros: number;
  readonly weekWakes: number;
  readonly monthMicros: number;
  readonly monthWakes: number;
  readonly perAgent: readonly { agentId: string; totalMicros: number; wakes: number }[];
}

export const readCostSummary = async (rootDir: string): Promise<CostSummary> => {
  const runsDir = join(rootDir, ".murmuration", "runs");
  let agentDirs: string[];
  try {
    agentDirs = await readdir(runsDir);
  } catch {
    return { todayMicros: 0, todayWakes: 0, weekMicros: 0, weekWakes: 0, monthMicros: 0, monthWakes: 0, perAgent: [] };
  }

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const monthAgo = new Date(now.getTime() - 30 * 86_400_000);

  let todayMicros = 0, todayWakes = 0, weekMicros = 0, weekWakes = 0, monthMicros = 0, monthWakes = 0;
  const perAgent: { agentId: string; totalMicros: number; wakes: number }[] = [];

  for (const agentId of agentDirs.sort()) {
    const indexPath = join(runsDir, agentId, "index.jsonl");
    let agentTotal = 0;
    let agentWakes = 0;
    try {
      const contents = await readFile(indexPath, "utf8");
      for (const line of contents.trim().split("\n")) {
        if (!line) continue;
        try {
          const entry = JSON.parse(line) as {
            finishedAt?: string;
            totals?: { costMicros?: number };
          };
          const cost = entry.totals?.costMicros ?? 0;
          const finishedAt = entry.finishedAt ? new Date(entry.finishedAt) : null;
          agentTotal += cost;
          agentWakes++;
          if (finishedAt) {
            if (finishedAt.toISOString().slice(0, 10) === todayStr) { todayMicros += cost; todayWakes++; }
            if (finishedAt >= weekAgo) { weekMicros += cost; weekWakes++; }
            if (finishedAt >= monthAgo) { monthMicros += cost; monthWakes++; }
          }
        } catch { /* skip */ }
      }
    } catch { /* no index */ }
    if (agentWakes > 0) perAgent.push({ agentId, totalMicros: agentTotal, wakes: agentWakes });
  }

  return { todayMicros, todayWakes, weekMicros, weekWakes, monthMicros, monthWakes, perAgent };
};
