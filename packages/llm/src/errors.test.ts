import { describe, it, expect } from "vitest";

import {
  formatLLMError,
  LLMForbiddenError,
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
