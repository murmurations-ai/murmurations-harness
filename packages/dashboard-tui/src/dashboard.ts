/**
 * Murmuration Dashboard — TUI with four panels.
 *
 * Uses @mariozechner/pi-tui for differential rendering. Reads the
 * .murmuration/ directory tree for all data. Auto-refreshes every
 * 30s. Press [q] or Ctrl+C to quit, [r] to force refresh.
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
// Panel renderers
// ---------------------------------------------------------------------------

const STATUS_ICONS: Record<string, string> = {
  completed: "✅",
  failed: "❌",
  "timed-out": "⏰",
  killed: "🛑",
};

const renderPipeline = (agents: readonly AgentStatus[]): string => {
  const lines = ["┌─ Pipeline State ─────────────────────────────────┐"];
  for (const a of agents) {
    const icon = a.outcome ? (STATUS_ICONS[a.outcome] ?? "⬚") : "⬚";
    const staleFlag = a.stale ? " ⚠️" : "";
    const time = a.lastWake ? a.lastWake.toISOString().slice(11, 16) : "never";
    const line = `│ ${icon} ${a.agentId.padEnd(22)} ${time}  ${a.costFormatted}${staleFlag}`;
    lines.push(line.padEnd(52) + "│");
  }
  lines.push("└──────────────────────────────────────────────────┘");
  return lines.join("\n");
};

const renderActivity = (entries: readonly ActivityEntry[]): string => {
  const lines = ["┌─ Agent Activity ─────────────────────────────────┐"];
  if (entries.length === 0) {
    lines.push("│ (no recent activity — start the daemon)".padEnd(52) + "│");
  }
  for (const e of entries.slice(-12)) {
    const line = `│ ${e.ts} [${e.agentId.slice(0, 15).padEnd(15)}] ${e.event.slice(0, 10).padEnd(10)}`;
    lines.push(line.padEnd(52) + "│");
  }
  lines.push("└──────────────────────────────────────────────────┘");
  return lines.join("\n");
};

const renderGovernance = (items: readonly GovernanceEntry[]): string => {
  const lines = ["┌─ Governance ─────────────────────────────────────┐"];
  if (items.length === 0) {
    lines.push("│ (no governance items)".padEnd(52) + "│");
  }
  for (const item of items.slice(0, 8)) {
    const due = item.reviewDue ? " 🔴" : "";
    const line = `│ ${item.id} ${item.kind.padEnd(12)} ${item.state.padEnd(14)}${due}`;
    lines.push(line.padEnd(52) + "│");
  }
  const dueCount = items.filter((i) => i.reviewDue).length;
  if (dueCount > 0) {
    lines.push(`│ 📋 ${String(dueCount)} items due for review`.padEnd(52) + "│");
  }
  lines.push("└──────────────────────────────────────────────────┘");
  return lines.join("\n");
};

const formatUsd = (micros: number): string => `$${(micros / 1_000_000).toFixed(4)}`;

const renderCost = (cost: CostSummary): string => {
  const lines = ["┌─ Cost & Budget ──────────────────────────────────┐"];
  lines.push(
    `│ Today:    ${formatUsd(cost.todayMicros).padEnd(12)} (${String(cost.todayWakes)} wakes)`.padEnd(52) + "│",
  );
  lines.push(
    `│ Week:     ${formatUsd(cost.weekMicros).padEnd(12)} (${String(cost.weekWakes)} wakes)`.padEnd(52) + "│",
  );
  lines.push(
    `│ Month:    ${formatUsd(cost.monthMicros).padEnd(12)} (${String(cost.monthWakes)} wakes)`.padEnd(52) + "│",
  );
  lines.push("│──────────────────────────────────────────────────│".padEnd(52) + "│");
  for (const a of cost.perAgent.slice(0, 6)) {
    const line = `│  ${a.agentId.padEnd(22)} ${formatUsd(a.totalMicros).padEnd(10)} ${String(a.wakes).padStart(3)} wakes`;
    lines.push(line.padEnd(52) + "│");
  }
  if (cost.perAgent.length > 6) {
    lines.push(`│  ... and ${String(cost.perAgent.length - 6)} more agents`.padEnd(52) + "│");
  }
  lines.push("└──────────────────────────────────────────────────┘");
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

    const header = `  Murmuration Dashboard — ${root}  [q] quit  [r] refresh\n`;
    const left = renderPipeline(pipeline) + "\n" + renderGovernance(governance);
    const right = renderActivity(activity) + "\n" + renderCost(cost);

    display.setText(header + "\n" + left + "\n" + right);
    tui.requestRender();
  };

  await refresh();

  const timers = [setInterval(() => void refresh(), 30_000)];

  // Global input listener — handles quit and refresh before
  // any component gets the input. Uses tui.addInputListener
  // which fires regardless of focus state.
  tui.addInputListener((data: string) => {
    if (data === "q" || data === "\x03") {
      // q or Ctrl+C
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

  // Keep the process alive — tui.start() doesn't block.
  // The process exits via the input listener calling process.exit.
  await new Promise<void>(() => {
    // Never resolves — the input listener handles exit.
  });
};
