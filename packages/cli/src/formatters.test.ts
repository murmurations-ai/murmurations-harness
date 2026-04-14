import { describe, it, expect } from "vitest";
import {
  formatAgentsTable,
  formatGroupsTable,
  formatEventsTable,
  formatCostTable,
} from "./formatters.js";

describe("formatAgentsTable", () => {
  it("renders header and separator for empty array", () => {
    const result = formatAgentsTable([]);
    expect(result).toContain("AGENT");
    expect(result).toContain("─");
    expect(result.split("\n")).toHaveLength(2); // header + separator
  });

  it("renders agent rows with idle rate", () => {
    const result = formatAgentsTable([
      {
        agentId: "01-research",
        state: "idle",
        totalWakes: 10,
        totalArtifacts: 5,
        idleWakes: 2,
        consecutiveFailures: 0,
        groups: ["intelligence"],
      },
    ]);
    expect(result).toContain("01-research");
    expect(result).toContain("20%"); // 2/10 = 20% idle
    expect(result).toContain("intelligence");
  });

  it("shows — for agents with no wakes", () => {
    const result = formatAgentsTable([
      {
        agentId: "new-agent",
        state: "idle",
        totalWakes: 0,
        totalArtifacts: 0,
        idleWakes: 0,
        consecutiveFailures: 0,
        groups: [],
      },
    ]);
    expect(result).toContain("—");
  });
});

describe("formatGroupsTable", () => {
  it("renders group with members", () => {
    const result = formatGroupsTable([
      {
        groupId: "content",
        memberCount: 3,
        totalWakes: 10,
        totalArtifacts: 5,
        members: ["a", "b", "c"],
      },
    ]);
    expect(result).toContain("content");
    expect(result).toContain("a, b, c");
  });
});

describe("formatEventsTable", () => {
  it("shows (none) when empty", () => {
    const result = formatEventsTable([], []);
    expect(result).toContain("(none)");
  });

  it("shows in-flight meetings first", () => {
    const result = formatEventsTable(
      [{ groupId: "content", date: "2026-04-14", kind: "operational", status: "completed" }],
      [{ groupId: "intelligence", kind: "governance" }],
    );
    expect(result.indexOf("In-flight")).toBeLessThan(result.indexOf("Recent"));
    expect(result).toContain("intelligence");
  });
});

describe("formatCostTable", () => {
  it("shows total and per-agent rates", () => {
    const result = formatCostTable(10, 5, [
      { agentId: "01-research", totalWakes: 5, totalArtifacts: 3 },
      { agentId: "02-content", totalWakes: 0, totalArtifacts: 0 },
    ]);
    expect(result).toContain("Total: 10 wakes, 5 artifacts");
    expect(result).toContain("0.6"); // 3/5
    expect(result).toContain("—"); // 0 wakes
  });
});
