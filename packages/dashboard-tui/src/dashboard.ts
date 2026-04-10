/**
 * Murmuration Dashboard — TUI with four panels + system overview bar.
 *
 * Uses @mariozechner/pi-tui for differential rendering. Reads the
 * .murmuration/ directory tree for all data. Auto-refreshes every
 * 30s. Press [q] or Ctrl+C to quit, [r] to force refresh.
 *
 * UX improvements from Design Agent (#11) review:
 *   1. ANSI color-coded status markers (green ok, red fail, yellow review-due)
 *   2. System Overview bar — first 3 seconds of operator attention
 *   3. Structured activity log with outcome annotations
 *   4. Cost panel sorted by highest-cost first + ASCII bar chart
 *   5. Reassuring empty states
 *
 * Spec §13: read-only in v0.1.
 */

import { TUI, Text, ProcessTerminal } from "@mariozechner/pi-tui";
import { resolve } from "node:path";

import {
  readPipelineState,
  readRecentActivity,
  readGovernanceState,
  readCostSummary,
  type AgentStatus,
  type ActivityEntry,
  type GovernanceEntry,
  type CostSummary,
} from "./data.js";

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
// const WHITE = "\x1b[37m"; // reserved for future use

const green = (s: string): string => `${GREEN}${s}${RESET}`;
const red = (s: string): string => `${RED}${s}${RESET}`;
const yellow = (s: string): string => `${YELLOW}${s}${RESET}`;
const cyan = (s: string): string => `${CYAN}${s}${RESET}`;
const bold = (s: string): string => `${BOLD}${s}${RESET}`;
const dim = (s: string): string => `${DIM}${s}${RESET}`;

// ---------------------------------------------------------------------------
// System Overview bar — the "first 3 seconds" view
// ---------------------------------------------------------------------------

const renderOverview = (
  agents: readonly AgentStatus[],
  governance: readonly GovernanceEntry[],
  cost: CostSummary,
): string => {
  const failCount = agents.filter((a) => a.outcome === "failed").length;
  const staleCount = agents.filter((a) => a.stale).length;
  const reviewDue = governance.filter((g) => g.reviewDue).length;

  let status: string;
  if (failCount > 0) {
    status = red(`CRITICAL (${String(failCount)} failed)`);
  } else if (staleCount > 0 || reviewDue > 0) {
    const parts: string[] = [];
    if (staleCount > 0) parts.push(`${String(staleCount)} stale`);
    if (reviewDue > 0) parts.push(`${String(reviewDue)} review-due`);
    status = yellow(`ATTENTION (${parts.join(", ")})`);
  } else {
    status = green("ALL SYSTEMS OK");
  }

  const activeCount = agents.filter((a) => a.outcome === "completed").length;
  const todayCost = formatUsd(cost.todayMicros);

  return [
    `  ${bold("Status:")} ${status}    ${bold("Agents:")} ${String(activeCount)}/${String(agents.length)} active    ${bold("Today:")} ${todayCost} (${String(cost.todayWakes)} wakes)`,
    "",
  ].join("\n");
};

// ---------------------------------------------------------------------------
// Panel renderers — ANSI colored, no box-drawing
// ---------------------------------------------------------------------------

const HR = dim("────────────────────────────────────────────────────");

const renderPipeline = (agents: readonly AgentStatus[], cost: CostSummary): string => {
  const lines = [` ${bold("Agents")}`, ` ${HR}`];
  if (agents.length === 0) {
    lines.push(`  ${dim("No agents discovered. Run: murmuration start --root <dir>")}`);
    return lines.join("\n");
  }

  // Build a cost lookup from the cost summary for total per agent
  const costMap = new Map(cost.perAgent.map((a) => [a.agentId, a]));
  const maxCost = Math.max(...cost.perAgent.map((a) => a.totalMicros), 1);
  const BAR_WIDTH = 8;

  for (const a of agents) {
    let marker: string;
    if (a.outcome === "completed") marker = green("[ok]");
    else if (a.outcome === "failed") marker = red("[FAIL]");
    else if (a.outcome === "timed-out") marker = yellow("[TOUT]");
    else if (a.outcome === "killed") marker = red("[KILL]");
    else marker = dim("[--]");

    const staleFlag = a.stale ? yellow(" !") : "";
    const time = a.lastWake ? a.lastWake.toISOString().slice(11, 16) : dim("--:--");
    const next = a.nextWakeCountdown !== "--" ? a.nextWakeCountdown.padEnd(7) : dim("--".padEnd(7));

    // Cost bar from aggregate total
    const agentCost = costMap.get(a.agentId);
    const totalCost = agentCost ? formatUsd(agentCost.totalMicros) : dim("$0.0000");
    const wakes = agentCost ? String(agentCost.wakes).padStart(2) : dim(" 0");
    const barLen = agentCost ? Math.max(0, Math.round((agentCost.totalMicros / maxCost) * BAR_WIDTH)) : 0;
    const bar = barLen > 0 ? cyan("█".repeat(barLen)) + dim("░".repeat(BAR_WIDTH - barLen)) : dim("░".repeat(BAR_WIDTH));

    lines.push(`  ${marker.padEnd(6)} ${a.agentId.padEnd(24)} ${time} ${dim("next")} ${next} ${totalCost} ${bar} ${dim(`${wakes}w`)}${staleFlag}`);
  }
  return lines.join("\n");
};

const renderActivity = (entries: readonly ActivityEntry[]): string => {
  const lines = [` ${bold("Agent Activity")}`, ` ${HR}`];
  if (entries.length === 0) {
    lines.push(`  ${dim("Waiting for agent activity. Start the daemon to see wakes here.")}`);
    return lines.join("\n");
  }
  for (const e of entries.slice(-12)) {
    const timeStr = dim(e.ts);
    let eventStr: string;
    if (e.event === "completed") eventStr = green(e.event.padEnd(12));
    else if (e.event === "failed" || e.event === "error") eventStr = red(e.event.padEnd(12));
    else eventStr = cyan(e.event.padEnd(12));
    lines.push(`  ${timeStr}  ${e.agentId.padEnd(24)} ${eventStr}`);
  }
  return lines.join("\n");
};

const renderGovernance = (items: readonly GovernanceEntry[]): string => {
  const lines = [` ${bold("Governance")}`, ` ${HR}`];
  if (items.length === 0) {
    lines.push(`  ${dim("All governance items are up-to-date. No pending decisions.")}`);
    return lines.join("\n");
  }

  // Split into pending (active) and decided (terminal)
  const pending = items.filter((i) => !i.isTerminal);
  const decided = items.filter((i) => i.isTerminal);

  if (pending.length > 0) {
    lines.push(`  ${bold("Pending")}`);
    for (const item of pending.slice(0, 5)) {
      const dueStr = item.reviewDue ? yellow(" [REVIEW DUE]") : "";
      const stateStr = item.state === "open" || item.state === "deliberating"
        ? cyan(item.state.padEnd(14))
        : item.state.padEnd(14);
      const summaryStr = item.summary ? dim(` ${item.summary}`) : "";
      lines.push(`  ${dim(item.id)}  ${item.kind.padEnd(12)} ${stateStr}${dueStr}${summaryStr}`);
    }
  }

  if (decided.length > 0) {
    lines.push(`  ${bold("Recent Decisions")}`);
    // Show most recent first (by lastTransitionAt)
    const sorted = [...decided].sort((a, b) =>
      (b.lastTransitionAt?.getTime() ?? 0) - (a.lastTransitionAt?.getTime() ?? 0),
    );
    for (const item of sorted.slice(0, 4)) {
      const stateStr = item.state === "resolved" || item.state === "ratified"
        ? green(item.state.padEnd(14))
        : item.state === "rejected"
          ? red(item.state.padEnd(14))
          : item.state.padEnd(14);
      const when = item.lastTransitionAt
        ? dim(item.lastTransitionAt.toISOString().slice(5, 16).replace("T", " "))
        : "";
      const summaryStr = item.summary ? dim(` ${item.summary}`) : "";
      lines.push(`  ${dim(item.id)}  ${item.kind.padEnd(12)} ${stateStr} ${when}${summaryStr}`);
    }
  }

  const dueCount = items.filter((i) => i.reviewDue).length;
  if (dueCount > 0) {
    lines.push(`  ${yellow(`${String(dueCount)} items due for review`)}`);
  }
  return lines.join("\n");
};

const formatUsd = (micros: number): string => `$${(micros / 1_000_000).toFixed(4)}`;

/** Compact cost + wakes sparkline — per-agent cost is in the Agents panel now. */
const renderCostSummary = (cost: CostSummary): string => {
  const lines = [` ${bold("Cost & Wakes")}`, ` ${HR}`];
  lines.push(`  Today: ${bold(formatUsd(cost.todayMicros))} (${String(cost.todayWakes)}w)    Week: ${formatUsd(cost.weekMicros)} (${String(cost.weekWakes)}w)    Month: ${formatUsd(cost.monthMicros)} (${String(cost.monthWakes)}w)`);

  // Wakes-per-day sparkline (last 7 days)
  const sparkChars = " ▁▂▃▄▅▆▇█";
  const days: number[] = [];
  const dayLabels: string[] = [];
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86_400_000);
    dayLabels.push(d.toISOString().slice(8, 10));
    days.push(0);
  }
  // Approximate: today's wakes in the last bucket, rest spread evenly.
  // Proper per-day breakdown needs daily aggregation from index.jsonl
  // which the shared dashboard-data layer will provide.
  if (cost.weekWakes > 0) {
    const otherDays = cost.weekWakes - cost.todayWakes;
    const perDay = otherDays > 0 ? Math.round(otherDays / 6) : 0;
    for (let i = 0; i < 6; i++) days[i] = perDay;
    days[6] = cost.todayWakes;
  }
  const maxDay = Math.max(...days, 1);
  const spark = days
    .map((d) => sparkChars[Math.round((d / maxDay) * (sparkChars.length - 1))])
    .join("");

  lines.push(`  Wakes/day: ${cyan(spark)}  ${dim(dayLabels.join(" "))}`);
  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// Dashboard entry point
// ---------------------------------------------------------------------------

export const startDashboard = async (rootDir: string): Promise<void> => {
  const root = resolve(rootDir);
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);

  const display = new Text("");
  tui.addChild(display);

  const refresh = async (): Promise<void> => {
    const [pipeline, activity, governance, cost] = await Promise.all([
      readPipelineState(root),
      readRecentActivity(root),
      readGovernanceState(root),
      readCostSummary(root),
    ]);

    const header = `  ${bold("Murmuration Dashboard")} ${dim("—")} ${dim(root)}  ${dim("[q] quit  [r] refresh")}\n`;
    const overview = renderOverview(pipeline, governance, cost);
    const panels = [
      renderPipeline(pipeline, cost),
      renderCostSummary(cost),
      renderGovernance(governance),
      renderActivity(activity),
    ].join("\n\n");

    display.setText(header + overview + "\n" + panels);
    tui.requestRender();
  };

  await refresh();

  const timers = [setInterval(() => void refresh(), 30_000)];

  tui.addInputListener((data: string) => {
    if (data === "q" || data === "\x03") {
      for (const t of timers) clearInterval(t);
      tui.stop();
      process.exit(0);
    }
    if (data === "r") {
      void refresh();
      return { consume: true };
    }
    return undefined;
  });

  tui.start();

  await new Promise<void>(() => {
    // Never resolves — the input listener handles exit.
  });
};
