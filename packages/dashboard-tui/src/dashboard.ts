/**
 * Murmuration Dashboard — TUI with compact panels + system overview.
 *
 * UX polished from two rounds of Design Agent (#11) review.
 * Spec §13: read-only in v0.1.
 */

import { TUI, Text, ProcessTerminal } from "@mariozechner/pi-tui";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

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
  const runningCount = agents.filter((a) => a.state === "running" || a.state === "waking").length;
  const failCount = agents.filter((a) => a.consecutiveFailures > 0).length;
  const stalledCount = agents.filter(
    (a) => a.stale && (a.state === "running" || a.state === "waking"),
  ).length;
  const idleStale = agents.filter(
    (a) => a.stale && a.state !== "running" && a.state !== "waking",
  ).length;
  const reviewDue = governance.filter((g) => g.reviewDue).length;

  let status: string;
  if (stalledCount > 0) {
    status = red(`CRITICAL (${String(stalledCount)} stalled)`);
  } else if (failCount > 0 || idleStale > 0 || reviewDue > 0) {
    const parts: string[] = [];
    if (failCount > 0) parts.push(red(`${String(failCount)} failing`));
    if (idleStale > 0) parts.push(yellow(`${String(idleStale)} awaiting first wake`));
    if (reviewDue > 0) parts.push(yellow(`${String(reviewDue)} review-due`));
    status = yellow("ATTENTION") + ` (${parts.join(", ")})`;
  } else if (runningCount > 0) {
    status = cyan(`ACTIVE (${String(runningCount)} running)`);
  } else {
    status = green("ALL SYSTEMS OK");
  }

  const activeCount = agents.filter((a) => a.totalWakes > 0).length;
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
    if (a.state === "running") marker = cyan("[RUN]");
    else if (a.state === "waking") marker = cyan("[WAKE]");
    else if (a.outcome === "success") marker = green("[ok]");
    else if (a.outcome === "failure") marker = red("[FAIL]");
    else if (a.outcome === "timeout") marker = yellow("[TOUT]");
    else if (a.outcome === "killed") marker = red("[KILL]");
    else if (a.state === "idle") marker = dim("[idle]");
    else marker = dim("[--]");

    const failStr = a.consecutiveFailures > 0 ? red(` ${String(a.consecutiveFailures)}F`) : "";

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
      `  ${marker.padEnd(6)} ${a.agentId.padEnd(24)} ${time}  ${dim("next")} ${next} ${totalCost} ${bar} ${wakes}w${failStr}`,
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

  // Sparkline (last 7 days) — real buckets from finishedAt timestamps,
  // computed in readCostSummary (fixes #59: previously we distributed
  // week wakes evenly across days 0-5, which misled Source about
  // activity shape).
  const sparkChars = " ▁▂▃▄▅▆▇█";
  const days: number[] = [...cost.wakesPerDay7d];
  const dayLabels: string[] = [];
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86_400_000);
    dayLabels.push(d.toISOString().slice(8, 10));
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

/** Full-screen preflight message shown when `.murmuration/` is absent
 *  (fixes #61). Four empty panels with no explanation was worse than
 *  no dashboard — a new operator had no signal about what was wrong. */
const renderNoMurmurationDir = (root: string): string => {
  const lines = [
    "",
    `  ${bold("Murmuration Dashboard")}`,
    "",
    `  ${red("No .murmuration/ directory found at:")}`,
    `    ${root}`,
    "",
    `  ${dim("The dashboard reads daemon state from .murmuration/ under")}`,
    `  ${dim("your murmuration root. It doesn't exist here yet.")}`,
    "",
    `  ${bold("To fix:")}`,
    `    ${cyan("•")} cd to your murmuration root, then run murmuration-dashboard`,
    `    ${cyan("•")} Or pass the correct path: ${dim("murmuration-dashboard --root <path>")}`,
    `    ${cyan("•")} Run ${dim("murmuration start")} first if the daemon has never run here`,
    "",
    `  ${dim("[r] refresh  [q] quit")}`,
  ];
  return lines.join("\n");
};

export const startDashboard = async (rootDir: string): Promise<void> => {
  const root = resolve(rootDir);
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);

  const display = new Text("");
  tui.addChild(display);

  const refresh = async (): Promise<void> => {
    if (!existsSync(join(root, ".murmuration"))) {
      display.setText(renderNoMurmurationDir(root));
      tui.requestRender();
      return;
    }

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
