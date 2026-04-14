/**
 * Shared display formatters for CLI batch verbs and REPL commands.
 *
 * Both surfaces format the same data — this module eliminates the
 * duplication and inconsistency between bin.ts and attach.ts.
 */

export interface AgentRow {
  readonly agentId: string;
  readonly state: string;
  readonly totalWakes: number;
  readonly totalArtifacts: number;
  readonly idleWakes: number;
  readonly consecutiveFailures: number;
  readonly groups: readonly string[];
}

export interface GroupRow {
  readonly groupId: string;
  readonly memberCount: number;
  readonly totalWakes: number;
  readonly totalArtifacts: number;
  readonly members: readonly string[];
}

export interface MeetingRow {
  readonly groupId: string;
  readonly date: string;
  readonly kind: string;
  readonly minutesUrl?: string;
  readonly title?: string;
  readonly status: string;
}

export interface CostRow {
  readonly agentId: string;
  readonly totalWakes: number;
  readonly totalArtifacts: number;
}

export const formatAgentsTable = (agents: readonly AgentRow[]): string => {
  const header = "AGENT".padEnd(25) + " STATE".padEnd(10) + "  WAKES  ARTS  IDLE%  FAIL  GROUPS";
  const sep = "─".repeat(85);
  const rows = agents.map((a) => {
    const idle =
      a.totalWakes > 0 ? `${String(Math.round((a.idleWakes / a.totalWakes) * 100))}%` : "—";
    return `${a.agentId.padEnd(25)} ${a.state.padEnd(10)} ${String(a.totalWakes).padStart(6)}  ${String(a.totalArtifacts).padStart(4)}  ${idle.padStart(5)}  ${String(a.consecutiveFailures).padStart(4)}  ${a.groups.join(", ")}`;
  });
  return [header, sep, ...rows].join("\n");
};

export const formatGroupsTable = (groups: readonly GroupRow[]): string => {
  const header = "GROUP".padEnd(20) + " MEMBERS  WAKES  ARTS  MEMBERS";
  const sep = "─".repeat(75);
  const rows = groups.map(
    (g) =>
      `${g.groupId.padEnd(20)} ${String(g.memberCount).padStart(7)}  ${String(g.totalWakes).padStart(5)}  ${String(g.totalArtifacts).padStart(4)}  ${g.members.join(", ")}`,
  );
  return [header, sep, ...rows].join("\n");
};

export const formatEventsTable = (
  meetings: readonly MeetingRow[],
  inFlight: readonly { groupId: string; kind: string }[],
): string => {
  const lines: string[] = [];
  if (inFlight.length > 0) {
    lines.push("In-flight:");
    for (const m of inFlight) lines.push(`  ${m.groupId} ${m.kind} — running`);
  }
  lines.push("Recent meetings:");
  if (meetings.length > 0) {
    for (const m of meetings) {
      lines.push(`  ${m.date}  ${m.groupId.padEnd(15)} ${m.kind.padEnd(14)} ${m.minutesUrl ?? ""}`);
    }
  } else {
    lines.push("  (none)");
  }
  return lines.join("\n");
};

export const formatCostTable = (
  totalWakes: number,
  totalArtifacts: number,
  agents: readonly CostRow[],
): string => {
  const header = `Total: ${String(totalWakes)} wakes, ${String(totalArtifacts)} artifacts\n`;
  const colHeader = "AGENT".padEnd(25) + "  WAKES  ARTIFACTS  ART/WAKE";
  const sep = "─".repeat(60);
  const rows = agents.map((a) => {
    const rate = a.totalWakes > 0 ? (a.totalArtifacts / a.totalWakes).toFixed(1) : "—";
    return `${a.agentId.padEnd(25)} ${String(a.totalWakes).padStart(6)}  ${String(a.totalArtifacts).padStart(9)}  ${rate.padStart(8)}`;
  });
  return [header, colHeader, sep, ...rows].join("\n");
};
