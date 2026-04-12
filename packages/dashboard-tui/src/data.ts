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
  readonly state: string; // lifecycle state from AgentStateStore
  readonly lastWake: Date | null;
  readonly outcome: string | null;
  readonly costMicros: number;
  readonly costFormatted: string;
  readonly stale: boolean; // stalled or no wake in > 48h
  readonly consecutiveFailures: number;
  readonly totalWakes: number;
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
  // Primary: read from AgentStateStore (formal state machine)
  // Fallback: discover agents from agents/*/role.md + index.jsonl
  interface StateAgentRecord {
    agentId: string;
    currentState: string;
    lastWokenAt: string | null;
    lastOutcome: string | null;
    maxWallClockMs: number;
    consecutiveFailures: number;
    totalWakes: number;
    currentWakeId: string | null;
    currentWakeStartedAt: string | null;
  }

  const stateFile = join(rootDir, ".murmuration", "agents", "state.json");
  let stateAgents: Record<string, StateAgentRecord> | undefined;

  try {
    const content = await readFile(stateFile, "utf8");
    const parsed = JSON.parse(content) as { agents?: Record<string, StateAgentRecord> };
    stateAgents = parsed.agents;
  } catch {
    // No state store yet — fall back to discovery
  }

  // Discover agent dirs for cron info (state store doesn't have cron)
  const agentsDir = join(rootDir, "agents");
  let agentDirs: string[];
  try {
    const entries = await readdir(agentsDir);
    const valid: string[] = [];
    for (const e of entries.sort()) {
      try {
        await readFile(join(agentsDir, e, "role.md"), "utf8");
        valid.push(e);
      } catch { /* skip */ }
    }
    agentDirs = valid;
  } catch {
    agentDirs = [];
  }

  const results: AgentStatus[] = [];
  const runsDir = join(rootDir, ".murmuration", "runs");

  for (const agentId of agentDirs.sort()) {
    const schedule = await parseCronFromRole(rootDir, agentId);
    const nextWake = schedule.cron ? computeNextFire(schedule.cron, schedule.tz) : null;
    const nextWakeCountdown = formatCountdown(nextWake);

    // Try state store first
    const agentState = stateAgents?.[agentId];
    if (agentState) {
      const lastWake = agentState.lastWokenAt ? new Date(agentState.lastWokenAt) : null;
      const isRunning = agentState.currentState === "running" || agentState.currentState === "waking";
      const isStalled = isRunning && agentState.currentWakeStartedAt
        ? Date.now() - new Date(agentState.currentWakeStartedAt).getTime() > agentState.maxWallClockMs
        : false;
      const stale = isStalled || (!lastWake || Date.now() - lastWake.getTime() > 48 * 3600 * 1000);

      // Get cost from index.jsonl (state store tracks outcomes, not costs per wake)
      let costMicros = 0;
      let costFormatted = "$0.0000";
      try {
        const indexContent = await readFile(join(runsDir, agentId, "index.jsonl"), "utf8");
        const lines = indexContent.trim().split("\n").filter((l) => l.length > 0);
        const last = lines[lines.length - 1];
        if (last) {
          const entry = JSON.parse(last) as { llm?: { costMicros?: number; costUsdFormatted?: string } };
          costMicros = entry.llm?.costMicros ?? 0;
          costFormatted = `$${entry.llm?.costUsdFormatted ?? "0.0000"}`;
        }
      } catch { /* no cost data */ }

      results.push({
        agentId,
        state: agentState.currentState,
        lastWake,
        outcome: agentState.lastOutcome,
        costMicros,
        costFormatted,
        stale,
        consecutiveFailures: agentState.consecutiveFailures,
        totalWakes: agentState.totalWakes,
        nextWake,
        nextWakeCountdown,
      });
      continue;
    }

    // Fallback: index.jsonl
    const indexPath = join(runsDir, agentId, "index.jsonl");
    try {
      const contents = await readFile(indexPath, "utf8");
      const lines = contents.trim().split("\n").filter((l) => l.length > 0);
      const lastLine = lines[lines.length - 1];
      if (!lastLine) {
        results.push({ agentId, state: "registered", lastWake: null, outcome: null, costMicros: 0, costFormatted: "$0.0000", stale: true, consecutiveFailures: 0, totalWakes: 0, nextWake, nextWakeCountdown });
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
        state: "idle",
        lastWake,
        outcome: entry.outcome ?? null,
        costMicros: entry.llm?.costMicros ?? 0,
        costFormatted: `$${entry.llm?.costUsdFormatted ?? "0.0000"}`,
        stale,
        consecutiveFailures: 0,
        totalWakes: 0,
        nextWake,
        nextWakeCountdown,
      });
    } catch {
      results.push({ agentId, state: "registered", lastWake: null, outcome: null, costMicros: 0, costFormatted: "$0.0000", stale: true, consecutiveFailures: 0, totalWakes: 0, nextWake, nextWakeCountdown });
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
  // Primary: read from AgentStateStore's wake instances
  const stateFile = join(rootDir, ".murmuration", "agents", "state.json");
  try {
    const content = await readFile(stateFile, "utf8");
    const data = JSON.parse(content) as {
      wakes?: Record<string, {
        wakeId: string;
        agentId: string;
        state: string;
        startedAt: string | null;
        finishedAt: string | null;
        outcome: string | null;
      }>;
    };
    if (data.wakes) {
      const allWakes = Object.values(data.wakes)
        .filter((w) => w.startedAt)
        .sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""))
        .slice(-maxEntries);

      return allWakes.map((w) => {
        const ts = w.finishedAt?.slice(11, 19) ?? w.startedAt?.slice(11, 19) ?? "";
        let event: string;
        let detail: string;
        if (w.state === "running" || w.state === "waking") {
          event = "running";
          detail = `since ${w.startedAt?.slice(11, 19) ?? "?"}`;
        } else if (w.outcome === "success") {
          event = "completed";
          detail = "";
        } else if (w.outcome === "failure") {
          event = "failed";
          detail = "";
        } else if (w.outcome === "timeout") {
          event = "timed-out";
          detail = "";
        } else {
          event = w.state;
          detail = "";
        }
        return { ts, agentId: w.agentId, event, detail };
      });
    }
  } catch {
    // Fall through to log-based
  }

  // Fallback: parse daemon.log
  const logPath = join(rootDir, ".murmuration", "daemon.log");
  let contents: string;
  try {
    contents = await readFile(logPath, "utf8");
  } catch {
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
      // skip
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
  readonly isTerminal: boolean;
  readonly lastTransition: string | null; // "from → to" or null
  readonly lastTransitionAt: Date | null;
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
        history?: { from?: string; to?: string; at?: string }[];
      };
      const reviewAt = item.reviewAt ? new Date(item.reviewAt).getTime() : null;
      const history = item.history ?? [];
      const lastH = history.length > 0 ? history[history.length - 1] : null;
      const terminalStates = ["resolved", "withdrawn", "ratified", "rejected", "completed", "passed", "failed"];
      entries.push({
        id: item.id?.slice(0, 8) ?? "?",
        kind: item.kind ?? "?",
        state: item.currentState ?? "?",
        createdBy: item.createdBy?.value ?? "?",
        reviewDue: reviewAt !== null && reviewAt < now,
        summary: (item.payload?.topic ?? item.payload?.action ?? "").slice(0, 40),
        isTerminal: terminalStates.includes(item.currentState ?? ""),
        lastTransition: lastH ? `${lastH.from ?? "?"} -> ${lastH.to ?? "?"}` : null,
        lastTransitionAt: lastH?.at ? new Date(lastH.at) : null,
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
