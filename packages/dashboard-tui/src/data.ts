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
  /**
   * Shadow API cost — what this wake *would* have cost on the API path.
   * Set when the wake routed through subscription-cli (claude-cli/codex-cli/
   * gemini-cli); null otherwise. UI can show "Free (would be $X.XX)".
   */
  readonly shadowCostMicros: number | null;
  readonly shadowCostFormatted: string | null;
  readonly stale: boolean; // stalled or no wake in > 48h
  readonly consecutiveFailures: number;
  readonly totalWakes: number;
  readonly nextWake: Date | null;
  readonly nextWakeCountdown: string; // human-readable "2h 14m" or "--"
}

/** Parse the cron expression from an agent's role.md frontmatter. */
const parseCronFromRole = async (
  rootDir: string,
  agentId: string,
): Promise<{
  cron?: string | undefined;
  tz?: string | undefined;
  delayMs?: number | undefined;
}> => {
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
  // Try daemon socket first (live data from running daemon)
  const { queryDaemon } = await import("./socket-client.js");
  const socketResult = await queryDaemon(rootDir, "status");
  if (socketResult && typeof socketResult === "object" && "agents" in socketResult) {
    const r = socketResult as {
      agents: {
        agentId: string;
        state: string;
        totalWakes: number;
        totalArtifacts: number;
        idleWakes: number;
        consecutiveFailures: number;
      }[];
    };
    const results: AgentStatus[] = [];
    for (const a of r.agents) {
      const schedule = await parseCronFromRole(rootDir, a.agentId);
      const nextWake = schedule.cron ? computeNextFire(schedule.cron, schedule.tz) : null;
      results.push({
        agentId: a.agentId,
        state: a.state,
        lastWake: null,
        outcome: null,
        costMicros: 0,
        costFormatted: "$0.00",
        shadowCostMicros: null,
        shadowCostFormatted: null,
        stale: false,
        consecutiveFailures: a.consecutiveFailures,
        totalWakes: a.totalWakes,
        nextWake,
        nextWakeCountdown: formatCountdown(nextWake),
      });
    }
    return results;
  }

  // Fallback: read from files (daemon not running or no socket)
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
      } catch {
        /* skip */
      }
    }
    agentDirs = valid;
  } catch {
    agentDirs = [];
  }

  const results: AgentStatus[] = [];
  // v0.5.x moved runs/ out of .murmuration/ so content is visible.
  // Read from new path; legacy data stays at .murmuration/runs/ until
  // the boot-time auto-migration picks it up.
  const runsDir = join(rootDir, "runs");

  for (const agentId of agentDirs.sort()) {
    const schedule = await parseCronFromRole(rootDir, agentId);
    const nextWake = schedule.cron ? computeNextFire(schedule.cron, schedule.tz) : null;
    const nextWakeCountdown = formatCountdown(nextWake);

    // Try state store first
    const agentState = stateAgents?.[agentId];
    if (agentState) {
      const lastWake = agentState.lastWokenAt ? new Date(agentState.lastWokenAt) : null;
      const isRunning =
        agentState.currentState === "running" || agentState.currentState === "waking";
      const isStalled =
        isRunning && agentState.currentWakeStartedAt
          ? Date.now() - new Date(agentState.currentWakeStartedAt).getTime() >
            agentState.maxWallClockMs
          : false;
      const stale = isStalled || !lastWake || Date.now() - lastWake.getTime() > 48 * 3600 * 1000;

      // Get cost from index.jsonl (state store tracks outcomes, not costs per wake)
      let costMicros = 0;
      let costFormatted = "$0.0000";
      let shadowCostMicros: number | null = null;
      let shadowCostFormatted: string | null = null;
      try {
        const indexContent = await readFile(join(runsDir, agentId, "index.jsonl"), "utf8");
        const lines = indexContent
          .trim()
          .split("\n")
          .filter((l) => l.length > 0);
        const last = lines[lines.length - 1];
        if (last) {
          const entry = JSON.parse(last) as {
            llm?: {
              costMicros?: number;
              costUsdFormatted?: string;
              shadowCostMicros?: number | null;
              shadowCostUsdFormatted?: string | null;
            };
          };
          costMicros = entry.llm?.costMicros ?? 0;
          costFormatted = `$${entry.llm?.costUsdFormatted ?? "0.0000"}`;
          shadowCostMicros = entry.llm?.shadowCostMicros ?? null;
          shadowCostFormatted =
            entry.llm?.shadowCostUsdFormatted != null
              ? `$${entry.llm.shadowCostUsdFormatted}`
              : null;
        }
      } catch {
        /* no cost data */
      }

      results.push({
        agentId,
        state: agentState.currentState,
        lastWake,
        outcome: agentState.lastOutcome,
        costMicros,
        costFormatted,
        shadowCostMicros,
        shadowCostFormatted,
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
      const lines = contents
        .trim()
        .split("\n")
        .filter((l) => l.length > 0);
      const lastLine = lines[lines.length - 1];
      if (!lastLine) {
        results.push({
          agentId,
          state: "registered",
          lastWake: null,
          outcome: null,
          costMicros: 0,
          costFormatted: "$0.0000",
          shadowCostMicros: null,
          shadowCostFormatted: null,
          stale: true,
          consecutiveFailures: 0,
          totalWakes: 0,
          nextWake,
          nextWakeCountdown,
        });
        continue;
      }
      const entry = JSON.parse(lastLine) as {
        finishedAt?: string;
        outcome?: string;
        llm?: {
          costMicros?: number;
          costUsdFormatted?: string;
          shadowCostMicros?: number | null;
          shadowCostUsdFormatted?: string | null;
        };
      };
      const lastWake = entry.finishedAt ? new Date(entry.finishedAt) : null;
      const stale = lastWake ? Date.now() - lastWake.getTime() > 48 * 3600 * 1000 : true;
      const fallbackShadow = entry.llm?.shadowCostUsdFormatted;
      results.push({
        agentId,
        state: "idle",
        lastWake,
        outcome: entry.outcome ?? null,
        costMicros: entry.llm?.costMicros ?? 0,
        costFormatted: `$${entry.llm?.costUsdFormatted ?? "0.0000"}`,
        shadowCostMicros: entry.llm?.shadowCostMicros ?? null,
        shadowCostFormatted:
          fallbackShadow !== undefined && fallbackShadow !== null ? `$${fallbackShadow}` : null,
        stale,
        consecutiveFailures: 0,
        totalWakes: 0,
        nextWake,
        nextWakeCountdown,
      });
    } catch {
      results.push({
        agentId,
        state: "registered",
        lastWake: null,
        outcome: null,
        costMicros: 0,
        costFormatted: "$0.0000",
        shadowCostMicros: null,
        shadowCostFormatted: null,
        stale: true,
        consecutiveFailures: 0,
        totalWakes: 0,
        nextWake,
        nextWakeCountdown,
      });
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

export const readRecentActivity = async (
  rootDir: string,
  maxEntries = 20,
): Promise<readonly ActivityEntry[]> => {
  // Primary: read from AgentStateStore's wake instances
  const stateFile = join(rootDir, ".murmuration", "agents", "state.json");
  try {
    const content = await readFile(stateFile, "utf8");
    const data = JSON.parse(content) as {
      wakes?: Record<
        string,
        {
          wakeId: string;
          agentId: string;
          state: string;
          startedAt: string | null;
          finishedAt: string | null;
          outcome: string | null;
        }
      >;
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
  const logPath = join(rootDir, ".murmuration", "logs", "daemon.log");
  let contents: string;
  try {
    contents = await readFile(logPath, "utf8");
  } catch {
    return [];
  }

  const lines = contents
    .trim()
    .split("\n")
    .filter((l) => l.length > 0);
  const entries: ActivityEntry[] = [];
  for (const line of lines.slice(-maxEntries * 3)) {
    try {
      const d = JSON.parse(line) as {
        ts?: string;
        event?: string;
        agentId?: string;
        outcome?: string;
        wakeSummary?: string;
      };
      if (!d.event) continue;
      if (
        d.event === "daemon.wake.fire" ||
        d.event === "daemon.wake.completed" ||
        d.event === "daemon.wake.failed"
      ) {
        const detail =
          d.event === "daemon.wake.completed"
            ? (d.wakeSummary?.split("\n")[0]?.slice(0, 60) ?? d.outcome ?? "")
            : d.event === "daemon.wake.failed"
              ? "FAILED"
              : "firing...";
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
      const terminalStates = [
        "resolved",
        "withdrawn",
        "ratified",
        "rejected",
        "completed",
        "passed",
        "failed",
      ];
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
  /**
   * Shadow API totals — what wakes routed through subscription-CLI
   * *would* have cost on the API. Always ≥ actual; ≈ actual when no
   * subscription-CLI wakes are in the window.
   */
  readonly todayShadowMicros: number;
  readonly weekShadowMicros: number;
  readonly monthShadowMicros: number;
  /** Wake counts for the last 7 calendar days, oldest first. Index 6
   *  is today. Bucketed by `finishedAt` date (local time) — real data,
   *  not a uniform distribution. */
  readonly wakesPerDay7d: readonly number[];
  readonly perAgent: readonly {
    readonly agentId: string;
    readonly totalMicros: number;
    readonly shadowMicros: number;
    readonly wakes: number;
  }[];
  /**
   * Per (provider, model) token usage over the day/week — only for
   * subscription-CLI providers. Vendors don't expose remaining-quota,
   * so this is "cumulative used" against the operator's known plan
   * (operator compares against e.g. Claude Pro: ~200 messages/day or
   * the published token allowance for their tier).
   */
  readonly subscriptionUsage: readonly SubscriptionUsage[];
}

export interface SubscriptionUsage {
  readonly provider: string; // e.g. "claude-cli"
  readonly model: string;
  readonly todayInputTokens: number;
  readonly todayOutputTokens: number;
  readonly todayWakes: number;
  readonly weekInputTokens: number;
  readonly weekOutputTokens: number;
  readonly weekWakes: number;
}

export const readCostSummary = async (rootDir: string): Promise<CostSummary> => {
  // v0.5.x moved runs/ out of .murmuration/ so content is visible.
  // Read from new path; legacy data stays at .murmuration/runs/ until
  // the boot-time auto-migration picks it up.
  const runsDir = join(rootDir, "runs");
  let agentDirs: string[];
  try {
    agentDirs = await readdir(runsDir);
  } catch {
    return {
      todayMicros: 0,
      todayWakes: 0,
      weekMicros: 0,
      weekWakes: 0,
      monthMicros: 0,
      monthWakes: 0,
      todayShadowMicros: 0,
      weekShadowMicros: 0,
      monthShadowMicros: 0,
      wakesPerDay7d: [0, 0, 0, 0, 0, 0, 0],
      perAgent: [],
      subscriptionUsage: [],
    };
  }

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const monthAgo = new Date(now.getTime() - 30 * 86_400_000);

  // 7-day wake histogram, index 0 = 6 days ago, index 6 = today.
  // Keyed by YYYY-MM-DD (ISO date) so finishedAt lookups are O(1).
  const wakesPerDay: number[] = [0, 0, 0, 0, 0, 0, 0];
  const dayKeys: string[] = [];
  for (let i = 6; i >= 0; i--) {
    dayKeys.push(new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10));
  }
  const dayKeyIndex = new Map(dayKeys.map((k, i) => [k, i]));

  let todayMicros = 0,
    todayWakes = 0,
    weekMicros = 0,
    weekWakes = 0,
    monthMicros = 0,
    monthWakes = 0,
    todayShadowMicros = 0,
    weekShadowMicros = 0,
    monthShadowMicros = 0;
  const perAgent: { agentId: string; totalMicros: number; shadowMicros: number; wakes: number }[] =
    [];

  // Subscription-CLI token usage by (provider, model). Keyed for O(1)
  // accumulation; flattened to an array at the end. Only providers
  // ending in "-cli" are tracked here — direct API providers report
  // costs in the main aggregation above.
  const subUsage = new Map<
    string,
    {
      provider: string;
      model: string;
      todayInputTokens: number;
      todayOutputTokens: number;
      todayWakes: number;
      weekInputTokens: number;
      weekOutputTokens: number;
      weekWakes: number;
    }
  >();

  for (const agentId of agentDirs.sort()) {
    const indexPath = join(runsDir, agentId, "index.jsonl");
    let agentTotal = 0;
    let agentShadow = 0;
    let agentWakes = 0;
    try {
      const contents = await readFile(indexPath, "utf8");
      for (const line of contents.trim().split("\n")) {
        if (!line) continue;
        try {
          const entry = JSON.parse(line) as {
            finishedAt?: string;
            totals?: { costMicros?: number };
            llm?: {
              provider?: string;
              model?: string;
              inputTokens?: number;
              outputTokens?: number;
              shadowCostMicros?: number | null;
            };
          };
          const cost = entry.totals?.costMicros ?? 0;
          // For shadow accounting: subscription-cli wakes report shadow
          // cost; API wakes report null (their actual is the real cost).
          // To compare apples-to-apples, treat null as "shadow == actual"
          // so the totals are the would-be-API spend across the fleet.
          const shadow = entry.llm?.shadowCostMicros ?? cost;
          const finishedAt = entry.finishedAt ? new Date(entry.finishedAt) : null;
          agentTotal += cost;
          agentShadow += shadow;
          agentWakes++;
          if (finishedAt) {
            const dateKey = finishedAt.toISOString().slice(0, 10);
            const isToday = dateKey === todayStr;
            const inWeek = finishedAt >= weekAgo;
            if (isToday) {
              todayMicros += cost;
              todayShadowMicros += shadow;
              todayWakes++;
            }
            if (inWeek) {
              weekMicros += cost;
              weekShadowMicros += shadow;
              weekWakes++;
            }
            if (finishedAt >= monthAgo) {
              monthMicros += cost;
              monthShadowMicros += shadow;
              monthWakes++;
            }
            const idx = dayKeyIndex.get(dateKey);
            if (idx !== undefined) {
              const current = wakesPerDay[idx] ?? 0;
              wakesPerDay[idx] = current + 1;
            }

            // Subscription-CLI usage tracking: aggregate by (provider, model)
            // for the *-cli providers. Direct API providers don't go in this
            // bucket — their cost is the real spend, surfaced above.
            const provider = entry.llm?.provider;
            const model = entry.llm?.model;
            if (provider && provider.endsWith("-cli") && model) {
              const key = `${provider}|${model}`;
              const existing = subUsage.get(key) ?? {
                provider,
                model,
                todayInputTokens: 0,
                todayOutputTokens: 0,
                todayWakes: 0,
                weekInputTokens: 0,
                weekOutputTokens: 0,
                weekWakes: 0,
              };
              const inTok = entry.llm?.inputTokens ?? 0;
              const outTok = entry.llm?.outputTokens ?? 0;
              if (isToday) {
                existing.todayInputTokens += inTok;
                existing.todayOutputTokens += outTok;
                existing.todayWakes++;
              }
              if (inWeek) {
                existing.weekInputTokens += inTok;
                existing.weekOutputTokens += outTok;
                existing.weekWakes++;
              }
              subUsage.set(key, existing);
            }
          }
        } catch {
          /* skip */
        }
      }
    } catch {
      /* no index */
    }
    if (agentWakes > 0)
      perAgent.push({
        agentId,
        totalMicros: agentTotal,
        shadowMicros: agentShadow,
        wakes: agentWakes,
      });
  }

  return {
    todayMicros,
    todayWakes,
    weekMicros,
    weekWakes,
    monthMicros,
    monthWakes,
    todayShadowMicros,
    weekShadowMicros,
    monthShadowMicros,
    wakesPerDay7d: wakesPerDay,
    perAgent,
    subscriptionUsage: [...subUsage.values()].sort((a, b) =>
      a.provider === b.provider
        ? a.model.localeCompare(b.model)
        : a.provider.localeCompare(b.provider),
    ),
  };
};
