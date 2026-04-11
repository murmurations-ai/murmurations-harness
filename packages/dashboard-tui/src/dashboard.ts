/**
 * Murmuration Dashboard — TUI with compact panels + system overview.
 *
 * UX polished from two rounds of Design Agent (#11) review.
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

const green = (s: string): string => `${GREEN}${s}${RESET}`;
const red = (s: string): string => `${RED}${s}${RESET}`;
const yellow = (s: string): string => `${YELLOW}${s}${RESET}`;
const cyan = (s: string): string => `${CYAN}${s}${RESET}`;
const bold = (s: string): string => `${BOLD}${s}${RESET}`;
const dim = (s: string): string => `${DIM}${s}${RESET}`;

const HR = dim("────────────────────────────────────────────────────────────────");
const formatUsd = (micros: number): string => `$${(micros / 1_000_000).toFixed(4)}`;

// ---------------------------------------------------------------------------
// System Overview — the "first 3 seconds" view
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
    if (staleCount > 0) parts.push(red(`${String(staleCount)} stale`));
    if (reviewDue > 0) parts.push(yellow(`${String(reviewDue)} review-due`));
    status = yellow("ATTENTION") + ` (${parts.join(", ")})`;
  } else {
    status = green("ALL SYSTEMS OK");
  }

  const activeCount = agents.filter((a) => a.outcome === "completed").length;
  return `  ${bold("Status:")} ${status}  ${dim("|")}  ${bold("Agents:")} ${String(activeCount)}/${String(agents.length)} active  ${dim("|")}  ${bold("Today:")} ${formatUsd(cost.todayMicros)} (${String(cost.todayWakes)} wakes)\n`;
};

// ---------------------------------------------------------------------------
// Agents panel — combined pipeline + cost, inactive agents collapsed
// ---------------------------------------------------------------------------

const renderAgents = (agents: readonly AgentStatus[], cost: CostSummary): string => {
  const lines = [` ${bold("Agents")}`, ` ${HR}`];
  if (agents.length === 0) {
    lines.push(`  ${dim("No agents discovered. Run: murmuration start --root <dir>")}`);
    return lines.join("\n");
  }

  const costMap = new Map(cost.perAgent.map((a) => [a.agentId, a]));
  const maxCost = Math.max(...cost.perAgent.map((a) => a.totalMicros), 1);
  const BAR_WIDTH = 8;

  // Split active (have woken) vs inactive (never woken)
  const active = agents.filter((a) => a.lastWake !== null);
  const inactive = agents.filter((a) => a.lastWake === null);

  for (const a of active) {
    let marker: string;
    if (a.outcome === "completed") marker = green("[ok]");
    else if (a.outcome === "failed") marker = red("[FAIL]");
    else if (a.outcome === "timed-out") marker = yellow("[TOUT]");
    else if (a.outcome === "killed") marker = red("[KILL]");
    else marker = dim("[--]");

    const time = a.lastWake!.toISOString().slice(11, 16);
    const next = a.nextWakeCountdown !== "--" ? a.nextWakeCountdown.padEnd(8) : dim("--".padEnd(8));

    const agentCost = costMap.get(a.agentId);
    const totalCost = agentCost ? formatUsd(agentCost.totalMicros) : dim("$0.0000");
    const wakes = agentCost ? String(agentCost.wakes) : "0";
    const barLen = agentCost
      ? Math.max(0, Math.round((agentCost.totalMicros / maxCost) * BAR_WIDTH))
      : 0;
    const bar =
      barLen > 0
        ? cyan("█".repeat(barLen)) + dim("░".repeat(BAR_WIDTH - barLen))
        : dim("░".repeat(BAR_WIDTH));

    lines.push(
      `  ${marker.padEnd(6)} ${a.agentId.padEnd(24)} ${time}  ${dim("next")} ${next} ${totalCost} ${bar} ${wakes}w`,
    );
  }

  // Collapse inactive agents into a summary
  if (inactive.length > 0) {
    const nextWakes = inactive
      .filter((a) => a.nextWakeCountdown !== "--")
      .map((a) => a.nextWakeCountdown)
      .sort();
    const soonest = nextWakes.length > 0 ? `  soonest: ${nextWakes[0] ?? ""}` : "";
    lines.push(`  ${dim(`[--]  ${String(inactive.length)} agents awaiting first wake${soonest}`)}`);
  }

  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// Cost & Wakes — compact summary + sparkline
// ---------------------------------------------------------------------------

const renderCostSummary = (cost: CostSummary): string => {
  const lines = [` ${bold("Cost & Wakes")}`, ` ${HR}`];
  lines.push(
    `  Today: ${bold(formatUsd(cost.todayMicros))} (${String(cost.todayWakes)}w)  ${dim("|")}  Week: ${formatUsd(cost.weekMicros)} (${String(cost.weekWakes)}w)  ${dim("|")}  Month: ${formatUsd(cost.monthMicros)} (${String(cost.monthWakes)}w)`,
  );

  // Sparkline (last 7 days) with day count labels
  const sparkChars = " ▁▂▃▄▅▆▇█";
  const days: number[] = [];
  const dayLabels: string[] = [];
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86_400_000);
    dayLabels.push(d.toISOString().slice(8, 10));
    days.push(0);
  }
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
  const counts = days.map((d) => (d > 0 ? String(d).padStart(2) : dim(" 0"))).join(" ");

  lines.push(`  Wakes/day: ${cyan(spark)}   ${dim(dayLabels.join(" "))}`);
  lines.push(`             ${counts}`);
  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// Governance — pending + recent with counts in headers
// ---------------------------------------------------------------------------

const renderGovernance = (items: readonly GovernanceEntry[]): string => {
  const lines = [` ${bold("Governance")}`, ` ${HR}`];
  if (items.length === 0) {
    lines.push(`  ${dim("All governance items are up-to-date. No pending decisions.")}`);
    return lines.join("\n");
  }

  const pending = items.filter((i) => !i.isTerminal);
  const decided = items.filter((i) => i.isTerminal);

  if (pending.length > 0) {
    lines.push(`  ${bold(`Pending (${String(pending.length)})`)}`);
    for (const item of pending.slice(0, 5)) {
      const dueStr = item.reviewDue ? yellow(" [REVIEW DUE]") : "";
      const stateStr = cyan(item.state.padEnd(14));
      const summaryStr = item.summary ? dim(` ${item.summary}`) : "";
      lines.push(`  ${dim(item.id)}  ${item.kind.padEnd(12)} ${stateStr}${dueStr}${summaryStr}`);
    }
    if (pending.length > 5) lines.push(`  ${dim(`... and ${String(pending.length - 5)} more`)}`);
  }

  if (decided.length > 0) {
    const sorted = [...decided].sort(
      (a, b) => (b.lastTransitionAt?.getTime() ?? 0) - (a.lastTransitionAt?.getTime() ?? 0),
    );
    lines.push(`  ${bold(`Recent Decisions (${String(decided.length)})`)}`);
    for (const item of sorted.slice(0, 3)) {
      const stateStr =
        item.state === "resolved" || item.state === "ratified"
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

// ---------------------------------------------------------------------------
// Agent Activity — compact, truncated
// ---------------------------------------------------------------------------

const renderActivity = (entries: readonly ActivityEntry[]): string => {
  const lines = [` ${bold("Activity")}`, ` ${HR}`];
  if (entries.length === 0) {
    lines.push(`  ${dim("Waiting for agent activity. Start the daemon to see wakes here.")}`);
    return lines.join("\n");
  }
  for (const e of entries.slice(-10)) {
    const timeStr = dim(e.ts);
    let eventStr: string;
    if (e.event === "completed") eventStr = green("ok");
    else if (e.event === "failed" || e.event === "error") eventStr = red("FAIL");
    else eventStr = cyan(e.event.slice(0, 6));
    const detail = e.detail ? dim(` ${e.detail.slice(0, 50)}`) : "";
    lines.push(`  ${timeStr}  ${e.agentId.padEnd(20)} ${eventStr}${detail}`);
  }
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
      renderAgents(pipeline, cost),
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

  await new Promise<void>((_resolve) => {
    /* keep process alive */
  });
};
