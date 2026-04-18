/**
 * ProviderRegistry — unit tests (ADR-0025).
 *
 * The llm package ships no vendor strings. These tests use inline
 * fixtures mirroring what the CLI's built-in providers would register.
 */

import { describe, expect, it } from "vitest";

import {
  InvalidProviderDefinitionError,
  ProviderRegistry,
  validateProviderDefinition,
} from "./providers.js";
import type { ProviderDefinition } from "./providers.js";

const TEST_GEMINI: ProviderDefinition = {
  id: "gemini",
  displayName: "Google Gemini",
  envKeyName: "GEMINI_API_KEY",
  tiers: { fast: "gemini-2.5-flash", balanced: "gemini-2.5-pro", deep: "gemini-2.5-pro" },
  create: () => Promise.resolve({} as never),
};

const TEST_ANTHROPIC: ProviderDefinition = {
  id: "anthropic",
  displayName: "Anthropic",
  envKeyName: "ANTHROPIC_API_KEY",
  tiers: {
    fast: "claude-sonnet-4-5-20250929",
    balanced: "claude-sonnet-4-5-20250929",
    deep: "claude-opus-4-6-20251030",
  },
  create: () => Promise.resolve({} as never),
};

const TEST_OLLAMA: ProviderDefinition = {
  id: "ollama",
  displayName: "Ollama",
  envKeyName: null,
  tiers: { fast: "llama3.2:3b", balanced: "llama3.2", deep: "llama3.1:70b" },
  create: () => Promise.resolve({} as never),
};

describe("ProviderRegistry", () => {
  it("starts empty", () => {
    const r = new ProviderRegistry();
    expect(r.list()).toHaveLength(0);
    expect(r.has("gemini")).toBe(false);
    expect(r.get("gemini")).toBeUndefined();
  });

  it("registers and retrieves providers", () => {
    const r = new ProviderRegistry();
    r.register(TEST_GEMINI);
    expect(r.has("gemini")).toBe(true);
    expect(r.get("gemini")?.displayName).toBe("Google Gemini");
    expect(r.list()).toHaveLength(1);
  });

  it("throws on duplicate registration", () => {
    const r = new ProviderRegistry();
    r.register(TEST_GEMINI);
    expect(() => r.register(TEST_GEMINI)).toThrow(/already registered/);
  });

  it("envKeyName returns the registered key, null for keyless, undefined for unknown", () => {
    const r = new ProviderRegistry();
    r.register(TEST_GEMINI);
    r.register(TEST_OLLAMA);
    expect(r.envKeyName("gemini")).toBe("GEMINI_API_KEY");
    expect(r.envKeyName("ollama")).toBeNull();
    expect(r.envKeyName("unknown")).toBeUndefined();
  });

  it("resolveModelForTier returns tier mapping or undefined", () => {
    const r = new ProviderRegistry();
    r.register(TEST_ANTHROPIC);
    expect(r.resolveModelForTier("anthropic", "balanced")).toBe("claude-sonnet-4-5-20250929");
    expect(r.resolveModelForTier("anthropic", "deep")).toBe("claude-opus-4-6-20251030");
    expect(r.resolveModelForTier("unknown", "balanced")).toBeUndefined();
  });

  it("resolveModelForTier returns undefined for providers without tiers", () => {
    const r = new ProviderRegistry();
    r.register({
      id: "tierless",
      displayName: "Tierless",
      envKeyName: null,
      create: () => Promise.resolve({} as never),
    });
    expect(r.resolveModelForTier("tierless", "balanced")).toBeUndefined();
  });

  it("list() preserves registration order", () => {
    const r = new ProviderRegistry();
    r.register(TEST_GEMINI);
    r.register(TEST_ANTHROPIC);
    r.register(TEST_OLLAMA);
    expect(r.list().map((p) => p.id)).toEqual(["gemini", "anthropic", "ollama"]);
  });
});

describe("validateProviderDefinition", () => {
  const validDef = {
    id: "mistral",
    displayName: "Mistral",
    envKeyName: "MISTRAL_API_KEY",
    tiers: { fast: "mistral-small", balanced: "mistral-large", deep: "mistral-large" },
    create: () => Promise.resolve({} as never),
  };

  it("accepts a well-formed definition", () => {
    expect(() => validateProviderDefinition(validDef, "ext")).not.toThrow();
  });

  it("accepts null envKeyName (keyless)", () => {
    const keyless = { ...validDef, id: "local", envKeyName: null };
    expect(() => validateProviderDefinition(keyless, "ext")).not.toThrow();
  });

  it("accepts omitted tiers", () => {
    const { tiers: _tiers, ...noTiers } = validDef;
    expect(() => validateProviderDefinition(noTiers, "ext")).not.toThrow();
  });

  it("rejects non-object input", () => {
    expect(() => validateProviderDefinition("string", "ext")).toThrow(
      InvalidProviderDefinitionError,
    );
    expect(() => validateProviderDefinition(null, "ext")).toThrow(InvalidProviderDefinitionError);
  });

  it("rejects empty id", () => {
    expect(() => validateProviderDefinition({ ...validDef, id: "" }, "ext")).toThrow(/id/);
  });

  it("rejects non-function create", () => {
    expect(() => validateProviderDefinition({ ...validDef, create: "nope" }, "ext")).toThrow(
      /create/,
    );
  });

  it("rejects wrong-typed envKeyName", () => {
    expect(() => validateProviderDefinition({ ...validDef, envKeyName: 42 }, "ext")).toThrow(
      /envKeyName/,
    );
  });

  it("rejects malformed tiers (missing tier)", () => {
    expect(() =>
      validateProviderDefinition({ ...validDef, tiers: { fast: "a", balanced: "b" } }, "ext"),
    ).toThrow(/deep/);
  });

  it("reports the extensionId in the error message", () => {
    try {
      validateProviderDefinition({}, "mistral-ext");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidProviderDefinitionError);
      expect((err as Error).message).toMatch(/\[mistral-ext\]/);
    }
  });
});
