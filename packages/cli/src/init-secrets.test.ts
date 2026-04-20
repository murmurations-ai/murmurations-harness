import { describe, expect, it, vi } from "vitest";

import {
  captureSecret,
  GITHUB_TOKEN_SPEC,
  LLM_KEY_SPECS,
  maskSecret,
  type ProviderKeySpec,
} from "./init-secrets.js";

describe("maskSecret (v0.5.0 Milestone 2)", () => {
  it("returns <empty> for blank input", () => {
    expect(maskSecret("")).toBe("<empty>");
    expect(maskSecret("   ")).toBe("<empty>");
  });

  it("shows last 4 + length for a normal key", () => {
    expect(maskSecret("AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZabcd")).toBe("…abcd (length 36)");
  });

  it("handles very short keys without leaking more than needed", () => {
    expect(maskSecret("abc")).toBe("…abc (length 3)");
  });

  it("trims leading/trailing whitespace before masking", () => {
    expect(maskSecret("  AIza...WXYZ  ")).toBe("…WXYZ (length 11)");
  });
});

describe("ProviderKeySpec.validate (v0.5.0 Milestone 2)", () => {
  describe("Gemini", () => {
    const spec = LLM_KEY_SPECS.gemini;
    it("accepts a well-formed Gemini key", () => {
      expect(spec.validate("AIzaSy" + "x".repeat(30))).toBeNull();
    });
    it("rejects missing AIza prefix", () => {
      expect(spec.validate("sk-ant-" + "x".repeat(40))).toMatch(/AIza/);
    });
    it("rejects too-short input", () => {
      expect(spec.validate("AIza")).toMatch(/too short/);
    });
    it("treats empty input as skip (null)", () => {
      expect(spec.validate("")).toBeNull();
      expect(spec.validate("   ")).toBeNull();
    });
  });

  describe("Anthropic", () => {
    const spec = LLM_KEY_SPECS.anthropic;
    it("accepts a well-formed Anthropic key", () => {
      expect(spec.validate("sk-ant-" + "x".repeat(40))).toBeNull();
    });
    it("rejects wrong prefix", () => {
      expect(spec.validate("AIzaSy" + "x".repeat(30))).toMatch(/sk-ant-/);
    });
  });

  describe("OpenAI", () => {
    const spec = LLM_KEY_SPECS.openai;
    it("accepts a well-formed OpenAI key", () => {
      expect(spec.validate("sk-" + "x".repeat(48))).toBeNull();
    });
    it("rejects missing sk- prefix", () => {
      expect(spec.validate("AIzaSy" + "x".repeat(30))).toMatch(/sk-/);
    });
  });

  describe("GitHub token", () => {
    const spec = GITHUB_TOKEN_SPEC;
    it("accepts ghp_ tokens", () => {
      expect(spec.validate("ghp_" + "x".repeat(40))).toBeNull();
    });
    it("accepts gho_ tokens", () => {
      expect(spec.validate("gho_" + "x".repeat(40))).toBeNull();
    });
    it("accepts github_pat_ fine-grained tokens", () => {
      expect(spec.validate("github_pat_" + "x".repeat(40))).toBeNull();
    });
    it("rejects wrong prefix", () => {
      expect(spec.validate("pat-" + "x".repeat(40))).toMatch(/ghp_/);
    });
  });
});

describe("captureSecret (v0.5.0 Milestone 2)", () => {
  it("returns the validated secret when the first paste passes + operator confirms", async () => {
    const log = vi.fn<(m: string) => void>();
    const askYN = vi.fn(() => Promise.resolve("y"));
    const promptSecretFn = vi.fn(() => Promise.resolve("AIzaSy" + "a".repeat(30)));

    const result = await captureSecret({
      spec: LLM_KEY_SPECS.gemini,
      log,
      askYN,
      promptSecretFn,
    });

    expect(result).toBe("AIzaSy" + "a".repeat(30));
    expect(promptSecretFn).toHaveBeenCalledTimes(1);
    const logged = log.mock.calls.map((c) => c[0]).join("");
    expect(logged).toContain("Captured GEMINI_API_KEY");
    expect(logged).toContain("…aaaa"); // last-4 masking
  });

  it("re-prompts on shape-validation failure, then succeeds", async () => {
    const log = vi.fn<(m: string) => void>();
    const askYN = vi.fn(() => Promise.resolve(""));
    const promptSecretFn = vi
      .fn<(options: { question: string }) => Promise<string>>()
      .mockResolvedValueOnce("not-a-key")
      .mockResolvedValueOnce("AIzaSy" + "b".repeat(30));

    const result = await captureSecret({
      spec: LLM_KEY_SPECS.gemini,
      log,
      askYN,
      promptSecretFn,
    });

    expect(result).toBe("AIzaSy" + "b".repeat(30));
    expect(promptSecretFn).toHaveBeenCalledTimes(2);
    const logged = log.mock.calls.map((c) => c[0]).join("");
    expect(logged).toMatch(/doesn't look like a Gemini key/);
    expect(logged).toContain("starts with `AIza`");
  });

  it("re-prompts when operator says 'n' to the masked confirmation", async () => {
    const log = vi.fn<(m: string) => void>();
    const askYN = vi
      .fn<(q: string) => Promise<string>>()
      .mockResolvedValueOnce("n")
      .mockResolvedValueOnce("y");
    const promptSecretFn = vi
      .fn<(options: { question: string }) => Promise<string>>()
      .mockResolvedValueOnce("AIzaSy" + "c".repeat(30))
      .mockResolvedValueOnce("AIzaSy" + "d".repeat(30));

    const result = await captureSecret({
      spec: LLM_KEY_SPECS.gemini,
      log,
      askYN,
      promptSecretFn,
    });

    expect(result).toBe("AIzaSy" + "d".repeat(30));
    expect(promptSecretFn).toHaveBeenCalledTimes(2);
  });

  it("treats empty input as skip and returns empty string", async () => {
    const log = vi.fn<(m: string) => void>();
    const askYN = vi.fn(() => Promise.resolve("y"));
    const promptSecretFn = vi.fn(() => Promise.resolve(""));

    const result = await captureSecret({
      spec: LLM_KEY_SPECS.gemini,
      log,
      askYN,
      promptSecretFn,
    });

    expect(result).toBe("");
    expect(promptSecretFn).toHaveBeenCalledTimes(1);
    const logged = log.mock.calls.map((c) => c[0]).join("");
    expect(logged).toContain("skipped");
  });

  it("gives up after maxAttempts and returns empty string", async () => {
    const log = vi.fn<(m: string) => void>();
    const askYN = vi.fn(() => Promise.resolve("y"));
    const promptSecretFn = vi.fn(() => Promise.resolve("not-a-valid-key"));

    const result = await captureSecret({
      spec: LLM_KEY_SPECS.gemini,
      log,
      askYN,
      promptSecretFn,
      maxAttempts: 2,
    });

    expect(result).toBe("");
    expect(promptSecretFn).toHaveBeenCalledTimes(2);
    const logged = log.mock.calls.map((c) => c[0]).join("");
    expect(logged).toMatch(/Skipping GEMINI_API_KEY after 2 attempts/);
  });

  it("never prints the raw secret in log output", async () => {
    const log = vi.fn<(m: string) => void>();
    const askYN = vi.fn(() => Promise.resolve("y"));
    const rawSecret = "AIzaSy" + "SECRETSECRETSECRET".repeat(2);
    const promptSecretFn = vi.fn(() => Promise.resolve(rawSecret));

    await captureSecret({
      spec: LLM_KEY_SPECS.gemini,
      log,
      askYN,
      promptSecretFn,
    });

    const logged = log.mock.calls.map((c) => c[0]).join("");
    expect(logged).not.toContain(rawSecret);
    // Only the last 4 chars should appear.
    const last4 = rawSecret.slice(-4);
    expect(logged).toContain(`…${last4}`);
  });

  // Guard against false positives on the shape heuristic — a key that
  // happens to pass prefix + length checks but we synthesize in tests.
  it("treats any spec with correct prefix+length as valid", () => {
    const spec: ProviderKeySpec = LLM_KEY_SPECS.anthropic;
    const candidate = "sk-ant-" + "z".repeat(40);
    expect(spec.validate(candidate)).toBeNull();
  });
});
