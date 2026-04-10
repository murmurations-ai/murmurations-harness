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
// Panel renderers — plain text, no manual box-drawing (emoji-safe)
// ---------------------------------------------------------------------------

const STATUS_MARKER: Record<string, string> = {
  completed: "[ok]",
  failed: "[FAIL]",
  "timed-out": "[TIMEOUT]",
  killed: "[KILLED]",
};

const HR = "────────────────────────────────────────────────────";

const renderPipeline = (agents: readonly AgentStatus[]): string => {
  const lines = [" Pipeline State", ` ${HR}`];
  for (const a of agents) {
    const marker = a.outcome ? (STATUS_MARKER[a.outcome] ?? "[?]") : "[--]";
    const staleFlag = a.stale ? " STALE" : "";
    const time = a.lastWake ? a.lastWake.toISOString().slice(11, 16) : "never";
    lines.push(`  ${marker.padEnd(10)} ${a.agentId.padEnd(24)} ${time}  ${a.costFormatted}${staleFlag}`);
  }
  return lines.join("\n");
};

const renderActivity = (entries: readonly ActivityEntry[]): string => {
  const lines = [" Agent Activity", ` ${HR}`];
  if (entries.length === 0) {
    lines.push("  (no recent activity — start the daemon)");
  }
  for (const e of entries.slice(-12)) {
    lines.push(`  ${e.ts}  ${e.agentId.padEnd(24)} ${e.event}`);
  }
  return lines.join("\n");
};

const renderGovernance = (items: readonly GovernanceEntry[]): string => {
  const lines = [" Governance", ` ${HR}`];
  if (items.length === 0) {
    lines.push("  (no governance items)");
  }
  for (const item of items.slice(0, 8)) {
    const due = item.reviewDue ? " [REVIEW DUE]" : "";
    lines.push(`  ${item.id}  ${item.kind.padEnd(12)} ${item.state.padEnd(14)}${due}`);
  }
  const dueCount = items.filter((i) => i.reviewDue).length;
  if (dueCount > 0) {
    lines.push(`  ${String(dueCount)} items due for review`);
  }
  return lines.join("\n");
};

const formatUsd = (micros: number): string => `$${(micros / 1_000_000).toFixed(4)}`;

const renderCost = (cost: CostSummary): string => {
  const lines = [" Cost & Budget", ` ${HR}`];
  lines.push(`  Today:    ${formatUsd(cost.todayMicros).padEnd(12)} (${String(cost.todayWakes)} wakes)`);
  lines.push(`  Week:     ${formatUsd(cost.weekMicros).padEnd(12)} (${String(cost.weekWakes)} wakes)`);
  lines.push(`  Month:    ${formatUsd(cost.monthMicros).padEnd(12)} (${String(cost.monthWakes)} wakes)`);
  lines.push(`  ${HR.slice(0, 40)}`);
  for (const a of cost.perAgent.slice(0, 10)) {
    lines.push(`  ${a.agentId.padEnd(24)} ${formatUsd(a.totalMicros).padEnd(10)} ${String(a.wakes).padStart(3)} wakes`);
  }
  if (cost.perAgent.length > 10) {
    lines.push(`  ... and ${String(cost.perAgent.length - 10)} more agents`);
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
