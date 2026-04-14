import { describe, it, expect } from "vitest";
import { GroupWakeError } from "./group-wake.js";

describe("GroupWakeError", () => {
  it("has correct name property", () => {
    const err = new GroupWakeError("MISSING_GROUP_ID", "test");
    expect(err.name).toBe("GroupWakeError");
  });

  it("preserves error code", () => {
    const err = new GroupWakeError("GROUP_NOT_FOUND", "not found");
    expect(err.code).toBe("GROUP_NOT_FOUND");
    expect(err.message).toBe("not found");
  });

  it("is instanceof Error", () => {
    const err = new GroupWakeError("LLM_CONFIG_FAILED", "bad config");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(GroupWakeError);
  });

  it("supports all error codes", () => {
    const codes = [
      "GROUP_NOT_FOUND",
      "LLM_CONFIG_FAILED",
      "MISSING_GROUP_ID",
      "MISSING_LLM_TOKEN",
    ] as const;
    for (const code of codes) {
      const err = new GroupWakeError(code, `test ${code}`);
      expect(err.code).toBe(code);
    }
  });
});
