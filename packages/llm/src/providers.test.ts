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
  InvalidProviderDefinitionError,
  ProviderRegistry,
  createDefaultRegistry,
  defaultRegistry,
  seedDefaultRegistry,
  validateProviderDefinition,
} from "./providers.js";
import type { ProviderDefinition } from "./providers.js";
import { providerEnvKeyName } from "./adapters/provider-registry.js";
import { resolveModelForTier, lookupTierTable } from "./tiers.js";

// Test fixtures — the llm package ships no built-ins of its own. These
// mirror the shapes the CLI would seed for provider-integration tests.
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

describe("createDefaultRegistry", () => {
  it("returns an empty registry (Phase 3: built-ins live in the CLI)", () => {
    const r = createDefaultRegistry();
    expect(r.list()).toHaveLength(0);
  });
});

describe("defaultRegistry singleton", () => {
  it("returns the same instance on repeated calls", () => {
    const a = defaultRegistry();
    const b = defaultRegistry();
    expect(a).toBe(b);
  });

  it("starts empty and is populated on demand via seedDefaultRegistry", () => {
    // The singleton may carry state seeded by earlier tests — drain/reset
    // isn't exposed. Instead, confirm that after we explicitly seed, the
    // provider is reachable. Idempotent: repeat seeds don't throw.
    seedDefaultRegistry([TEST_GEMINI]);
    expect(defaultRegistry().has("gemini")).toBe(true);
    seedDefaultRegistry([TEST_GEMINI]); // idempotent
  });
});

describe("seedDefaultRegistry", () => {
  it("adds providers without duplicating existing ones", () => {
    seedDefaultRegistry([TEST_ANTHROPIC]);
    expect(defaultRegistry().has("anthropic")).toBe(true);
    seedDefaultRegistry([TEST_ANTHROPIC, TEST_OLLAMA]);
    expect(defaultRegistry().has("ollama")).toBe(true);
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

describe("Back-compat shims (require seeded defaultRegistry)", () => {
  // The shims delegate to the default singleton, which the CLI seeds
  // with built-in providers at startup. Tests seed explicitly.

  it("providerEnvKeyName returns the seeded registry's env-key", () => {
    seedDefaultRegistry([TEST_GEMINI, TEST_ANTHROPIC, TEST_OLLAMA]);
    expect(providerEnvKeyName("gemini")).toBe("GEMINI_API_KEY");
    expect(providerEnvKeyName("anthropic")).toBe("ANTHROPIC_API_KEY");
    // Keyless providers: the shim collapses null → undefined for legacy parity.
    expect(providerEnvKeyName("ollama")).toBeUndefined();
    expect(providerEnvKeyName("unknown-provider")).toBeUndefined();
  });

  it("resolveModelForTier consults the seeded registry", () => {
    seedDefaultRegistry([TEST_GEMINI, TEST_ANTHROPIC]);
    expect(resolveModelForTier("gemini", "balanced")).toBe("gemini-2.5-pro");
    expect(resolveModelForTier("anthropic", "fast")).toBe("claude-sonnet-4-5-20250929");
  });

  it("resolveModelForTier throws loudly for providers not in the registry", () => {
    expect(() => resolveModelForTier("never-registered", "balanced")).toThrow(/no tier/);
  });

  it("lookupTierTable returns a snapshot of the provider's tiers", () => {
    seedDefaultRegistry([TEST_GEMINI]);
    const table = lookupTierTable("gemini");
    expect(table?.balanced).toBe("gemini-2.5-pro");
  });

  it("lookupTierTable returns undefined for unregistered providers", () => {
    expect(lookupTierTable("never-registered")).toBeUndefined();
  });
});
