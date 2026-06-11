import { describe, it, expect } from "vitest";

import {
  formatLLMError,
  isResumeSessionMissing,
  LLMForbiddenError,
  LLMInternalError,
  LLMRateLimitError,
  LLMUnauthorizedError,
} from "./errors.js";

describe("formatLLMError", () => {
  it("renders a forbidden gemini error with provider-specific hints", () => {
    const err = new LLMForbiddenError("gemini", "Permission denied", {
      requestUrl: "https://example",
    });
    const out = formatLLMError(err, { agentId: "coordinator", model: "gemini-2.5-flash" });
    expect(out).toContain("LLM call failed for coordinator");
    expect(out).toContain("provider: gemini");
    expect(out).toContain("model:    gemini-2.5-flash");
    expect(out).toContain("code:     forbidden (HTTP 403)");
    expect(out).toContain("Permission denied");
    expect(out).toContain("Next steps:");
    expect(out).toContain("model_tier: economy");
  });

  it("renders a 401 with env-var remediation", () => {
    const err = new LLMUnauthorizedError("anthropic", "bad key", {
      requestUrl: "https://example",
    });
    const out = formatLLMError(err);
    expect(out).toContain("ANTHROPIC_API_KEY");
    expect(out).toContain("restart the daemon");
  });

  it("renders rate-limit with cadence hints", () => {
    const err = new LLMRateLimitError("openai", "slow down", {
      requestUrl: "https://example",
      status: 429,
      retryAfterSeconds: 30,
      limitScope: "rpm",
    });
    const out = formatLLMError(err, { model: "gpt-4o-mini" });
    expect(out).toContain("rate-limited");
    expect(out).toContain("HTTP 429");
    expect(out).toContain("wake_schedule");
  });

  it("omits agentId header when not provided", () => {
    const err = new LLMForbiddenError("openai", "nope", { requestUrl: "x" });
    const out = formatLLMError(err);
    expect(out).toMatch(/^LLM call failed\n/);
  });
});

describe("isResumeSessionMissing (harness#424)", () => {
  const internal = (message: string, cause?: unknown): LLMInternalError =>
    new LLMInternalError("claude-cli", message, {
      requestUrl: "subprocess://claude",
      ...(cause !== undefined ? { cause } : {}),
    });

  it("matches the claude resume-missing stderr on the error message", () => {
    expect(
      isResumeSessionMissing(
        internal("No conversation found with session ID: 44f95226-4fee-4bbe-bea0-dfada5e9d77c"),
      ),
    ).toBe(true);
  });

  it("is case-insensitive and ignores the trailing id", () => {
    expect(isResumeSessionMissing(internal("no conversation found with session id: abc"))).toBe(
      true,
    );
  });

  it("matches when the text is on the cause, not the top-level message", () => {
    const err = internal("in-process runner threw", {
      message: "No conversation found with session ID: deadbeef",
      kind: "spawn-error",
    });
    expect(isResumeSessionMissing(err)).toBe(true);
  });

  it("does NOT match unrelated failures (auth, rate limit, generic exit 1)", () => {
    expect(isResumeSessionMissing(internal("invalid API key"))).toBe(false);
    expect(isResumeSessionMissing(internal("claude exited with code 1"))).toBe(false);
    expect(
      isResumeSessionMissing(new LLMUnauthorizedError("anthropic", "bad key", { requestUrl: "x" })),
    ).toBe(false);
  });

  it("does not throw on a non-object cause", () => {
    expect(isResumeSessionMissing(internal("boom", "a string cause"))).toBe(false);
  });
});
