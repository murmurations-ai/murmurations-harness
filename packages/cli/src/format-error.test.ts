import { describe, expect, it } from "vitest";

import { formatFatalError } from "./format-error.js";

describe("formatFatalError (harness#360)", () => {
  it("formats a generic Error without a class prefix", () => {
    expect(formatFatalError(new Error("boom"))).toBe("murmuration: fatal: boom");
  });

  it("preserves typed-error discriminator as [ClassName] prefix", () => {
    class PluginInitError extends Error {
      public override readonly name = "PluginInitError";
    }
    expect(formatFatalError(new PluginInitError("plugin failed compat check"))).toBe(
      "murmuration: fatal: [PluginInitError] plugin failed compat check",
    );
  });

  it("preserves distinct typed errors so log triage can grep by name", () => {
    class PluginEventError extends Error {
      public override readonly name = "PluginEventError";
    }
    class PluginTimeoutError extends Error {
      public override readonly name = "PluginTimeoutError";
    }
    expect(formatFatalError(new PluginEventError("event handler threw"))).toContain(
      "[PluginEventError]",
    );
    expect(formatFatalError(new PluginTimeoutError("hook took > 5s"))).toContain(
      "[PluginTimeoutError]",
    );
  });

  it("handles non-Error values via String()", () => {
    expect(formatFatalError("string thrown directly")).toBe(
      "murmuration: fatal: string thrown directly",
    );
    expect(formatFatalError(42)).toBe("murmuration: fatal: 42");
    expect(formatFatalError({ shape: "object" })).toBe("murmuration: fatal: [object Object]");
  });

  it("handles null/undefined cleanly", () => {
    expect(formatFatalError(undefined)).toBe("murmuration: fatal: undefined");
    expect(formatFatalError(null)).toBe("murmuration: fatal: null");
  });
});
