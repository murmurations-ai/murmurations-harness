import { describe, expect, it } from "vitest";

import { NoOpStrategyPlugin } from "./index.js";

describe("NoOpStrategyPlugin", () => {
  it("returns empty objectives", () => {
    const plugin = new NoOpStrategyPlugin();
    expect(plugin.objectives()).toEqual([]);
  });

  it("returns null overallScore with guidance message", () => {
    const plugin = new NoOpStrategyPlugin();
    const assessment = plugin.assess([]);
    expect(assessment.overallScore).toBeNull();
    expect(assessment.summary).toContain("No strategy plugin configured");
    expect(assessment.suggestions).toEqual([]);
  });

  it("has name and version", () => {
    const plugin = new NoOpStrategyPlugin();
    expect(plugin.name).toBe("none");
    expect(plugin.version).toBe("1.0.0");
  });
});
