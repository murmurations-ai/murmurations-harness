import { describe, expect, it } from "vitest";

import {
  ACTION_ITEM_LABEL,
  AWAITING_SOURCE_CLOSE_LABEL,
  KICKOFF_LABEL,
  SCOPE_ALL_LABEL,
  SOURCE_DIRECTIVE_LABEL,
  VERIFICATION_FAILED_LABEL,
  assignedLabel,
  buildAgentRoutingLabels,
  findReservedLabels,
  isAssignedLabel,
  isReservedLabel,
  isScopeLabel,
  parseAssignedLabel,
  parseScopeAgentLabel,
  parseScopeGroupLabel,
  scopeAgentLabel,
  scopeGroupLabel,
} from "./index.js";

describe("label factories and parsers", () => {
  it("round-trips assignedLabel through parseAssignedLabel", () => {
    expect(parseAssignedLabel(assignedLabel("rentals-agent"))).toBe("rentals-agent");
  });

  it("round-trips scopeAgentLabel through parseScopeAgentLabel", () => {
    expect(parseScopeAgentLabel(scopeAgentLabel("facilitator-agent"))).toBe("facilitator-agent");
  });

  it("round-trips scopeGroupLabel through parseScopeGroupLabel", () => {
    expect(parseScopeGroupLabel(scopeGroupLabel("partnership"))).toBe("partnership");
  });

  it("returns null when parser is given a non-matching label", () => {
    expect(parseAssignedLabel("scope:agent:foo")).toBeNull();
    expect(parseScopeAgentLabel("assigned:foo")).toBeNull();
    expect(parseScopeGroupLabel("scope:agent:foo")).toBeNull();
  });

  it("isAssignedLabel and isScopeLabel discriminate cleanly", () => {
    expect(isAssignedLabel(assignedLabel("a"))).toBe(true);
    expect(isAssignedLabel(scopeAgentLabel("a"))).toBe(false);
    expect(isScopeLabel(scopeAgentLabel("a"))).toBe(true);
    expect(isScopeLabel(scopeGroupLabel("g"))).toBe(true);
    expect(isScopeLabel(SCOPE_ALL_LABEL)).toBe(true);
    expect(isScopeLabel(assignedLabel("a"))).toBe(false);
  });
});

describe("buildAgentRoutingLabels", () => {
  it("returns the OR-set of labels an agent should match", () => {
    expect(buildAgentRoutingLabels("rentals-agent", ["partnership"])).toStrictEqual([
      "assigned:rentals-agent",
      "scope:agent:rentals-agent",
      "scope:group:partnership",
      "scope:all",
    ]);
  });

  it("works with no group memberships", () => {
    expect(buildAgentRoutingLabels("solo-agent", [])).toStrictEqual([
      "assigned:solo-agent",
      "scope:agent:solo-agent",
      "scope:all",
    ]);
  });

  it("preserves group order", () => {
    expect(buildAgentRoutingLabels("a", ["g1", "g2", "g3"])).toStrictEqual([
      "assigned:a",
      "scope:agent:a",
      "scope:group:g1",
      "scope:group:g2",
      "scope:group:g3",
      "scope:all",
    ]);
  });
});

describe("isReservedLabel — Security H1 lateral-movement defense", () => {
  it("reserves source-directive (the directive trust label)", () => {
    expect(isReservedLabel(SOURCE_DIRECTIVE_LABEL)).toBe(true);
  });

  it("reserves kickoff (Source-only onboarding label)", () => {
    expect(isReservedLabel(KICKOFF_LABEL)).toBe(true);
  });

  it("reserves all scope:* labels (the routing OR-set the aggregator listens for)", () => {
    expect(isReservedLabel(SCOPE_ALL_LABEL)).toBe(true);
    expect(isReservedLabel(scopeAgentLabel("any-agent"))).toBe(true);
    expect(isReservedLabel(scopeGroupLabel("any-group"))).toBe(true);
  });

  it("does NOT reserve assigned:* (legitimate work-routing label)", () => {
    expect(isReservedLabel(assignedLabel("rentals-agent"))).toBe(false);
  });

  it("does NOT reserve action-item (created by meeting facilitators)", () => {
    expect(isReservedLabel(ACTION_ITEM_LABEL)).toBe(false);
  });

  it("does NOT reserve closure-ladder labels (written by agents during normal operation)", () => {
    expect(isReservedLabel(AWAITING_SOURCE_CLOSE_LABEL)).toBe(false);
    expect(isReservedLabel(VERIFICATION_FAILED_LABEL)).toBe(false);
  });

  it("does NOT reserve arbitrary operator labels", () => {
    expect(isReservedLabel("priority:high")).toBe(false);
    expect(isReservedLabel("type: tension")).toBe(false);
    expect(isReservedLabel("good-first-issue")).toBe(false);
  });

  it("findReservedLabels returns only the reserved subset", () => {
    expect(
      findReservedLabels([
        ACTION_ITEM_LABEL,
        assignedLabel("a"),
        SOURCE_DIRECTIVE_LABEL,
        SCOPE_ALL_LABEL,
        "priority:high",
      ]),
    ).toStrictEqual([SOURCE_DIRECTIVE_LABEL, SCOPE_ALL_LABEL]);
  });

  it("findReservedLabels returns empty when no labels are reserved", () => {
    expect(findReservedLabels([ACTION_ITEM_LABEL, assignedLabel("a"), "priority:high"])).toEqual(
      [],
    );
  });
});
