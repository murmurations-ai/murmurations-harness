/**
 * ProviderRegistry — unit tests (ADR-0025).
 *
 * Covers the pure-JS surface: registration, duplicate detection,
 * env-key lookup, tier resolution, back-compat shims, and the built-in
 * default registry. The Vercel SDK `create` factories are not
 * exercised here (they're thin wrappers around third-party SDKs).
 */

import { describe, expect, it } from "vitest";

import {
  BUILT_IN_PROVIDERS,
  InvalidProviderDefinitionError,
  ProviderRegistry,
  createDefaultRegistry,
  defaultRegistry,
  validateProviderDefinition,
} from "./providers.js";
import { KNOWN_PROVIDERS } from "./types.js";
import { providerEnvKeyName } from "./adapters/provider-registry.js";
import { MODEL_TIER_TABLE, resolveModelForTier } from "./tiers.js";

describe("ProviderRegistry", () => {
  it("starts empty", () => {
    const r = new ProviderRegistry();
    expect(r.list()).toHaveLength(0);
    expect(r.has("gemini")).toBe(false);
    expect(r.get("gemini")).toBeUndefined();
  });

  it("registers and retrieves providers", () => {
    const r = new ProviderRegistry();
    r.register({
      id: "mistral",
      displayName: "Mistral",
      envKeyName: "MISTRAL_API_KEY",
      tiers: { fast: "mistral-small", balanced: "mistral-large", deep: "mistral-large" },
      create: () => Promise.resolve({} as never),
    });
    expect(r.has("mistral")).toBe(true);
    expect(r.get("mistral")?.displayName).toBe("Mistral");
    expect(r.list()).toHaveLength(1);
  });

  it("throws on duplicate registration", () => {
    const r = new ProviderRegistry();
    const def = {
      id: "x",
      displayName: "X",
      envKeyName: null,
      create: () => Promise.resolve({} as never),
    };
    r.register(def);
    expect(() => r.register(def)).toThrow(/already registered/);
  });

  it("envKeyName returns the registered key, null for keyless, undefined for unknown", () => {
    const r = new ProviderRegistry();
    r.register({
      id: "with-key",
      displayName: "With Key",
      envKeyName: "WITH_KEY_API_KEY",
      create: () => Promise.resolve({} as never),
    });
    r.register({
      id: "keyless",
      displayName: "Keyless",
      envKeyName: null,
      create: () => Promise.resolve({} as never),
    });
    expect(r.envKeyName("with-key")).toBe("WITH_KEY_API_KEY");
    expect(r.envKeyName("keyless")).toBeNull();
    expect(r.envKeyName("unknown")).toBeUndefined();
  });

  it("resolveModelForTier returns tier mapping or undefined", () => {
    const r = new ProviderRegistry();
    r.register({
      id: "tiered",
      displayName: "Tiered",
      envKeyName: null,
      tiers: { fast: "f", balanced: "b", deep: "d" },
      create: () => Promise.resolve({} as never),
    });
    r.register({
      id: "untiered",
      displayName: "Untiered",
      envKeyName: null,
      create: () => Promise.resolve({} as never),
    });
    expect(r.resolveModelForTier("tiered", "balanced")).toBe("b");
    expect(r.resolveModelForTier("untiered", "balanced")).toBeUndefined();
    expect(r.resolveModelForTier("unknown", "balanced")).toBeUndefined();
  });
});

describe("Built-in providers", () => {
  it("BUILT_IN_PROVIDERS covers all KNOWN_PROVIDERS", () => {
    const ids = BUILT_IN_PROVIDERS.map((p) => p.id);
    expect(ids.sort()).toEqual([...KNOWN_PROVIDERS].sort());
  });

  it("createDefaultRegistry registers all four built-ins", () => {
    const r = createDefaultRegistry();
    for (const id of KNOWN_PROVIDERS) {
      expect(r.has(id)).toBe(true);
      expect(r.get(id)?.displayName).toBeTruthy();
    }
  });

  it("each built-in has the expected env-key convention", () => {
    const r = createDefaultRegistry();
    expect(r.envKeyName("gemini")).toBe("GEMINI_API_KEY");
    expect(r.envKeyName("anthropic")).toBe("ANTHROPIC_API_KEY");
    expect(r.envKeyName("openai")).toBe("OPENAI_API_KEY");
    expect(r.envKeyName("ollama")).toBeNull();
  });

  it("each built-in exposes fast/balanced/deep tiers", () => {
    const r = createDefaultRegistry();
    for (const id of KNOWN_PROVIDERS) {
      expect(r.resolveModelForTier(id, "fast")).toBeTruthy();
      expect(r.resolveModelForTier(id, "balanced")).toBeTruthy();
      expect(r.resolveModelForTier(id, "deep")).toBeTruthy();
    }
  });
});

describe("Default (singleton) registry", () => {
  it("returns the same instance on repeated calls", () => {
    const a = defaultRegistry();
    const b = defaultRegistry();
    expect(a).toBe(b);
  });

  it("is pre-populated with built-ins", () => {
    expect(defaultRegistry().has("anthropic")).toBe(true);
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

describe("Back-compat shims", () => {
  it("providerEnvKeyName returns the same value as the registry", () => {
    expect(providerEnvKeyName("gemini")).toBe("GEMINI_API_KEY");
    expect(providerEnvKeyName("anthropic")).toBe("ANTHROPIC_API_KEY");
    // Ollama is keyless — shim collapses null → undefined for legacy parity.
    expect(providerEnvKeyName("ollama")).toBeUndefined();
    expect(providerEnvKeyName("unknown-provider")).toBeUndefined();
  });

  it("resolveModelForTier returns the same model as the registry", () => {
    expect(resolveModelForTier("gemini", "balanced")).toBe("gemini-2.5-pro");
    expect(resolveModelForTier("anthropic", "fast")).toBe("claude-sonnet-4-5-20250929");
  });

  it("resolveModelForTier throws loudly for unknown providers", () => {
    expect(() => resolveModelForTier("unknown", "balanced")).toThrow(/no tier/);
  });

  it("MODEL_TIER_TABLE mirrors the built-in tier tables", () => {
    expect(MODEL_TIER_TABLE.gemini.balanced).toBe("gemini-2.5-pro");
    expect(MODEL_TIER_TABLE.anthropic.fast).toBe("claude-sonnet-4-5-20250929");
  });
});
