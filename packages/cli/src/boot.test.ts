/**
 * Tests for boot.ts exported helpers. Today this file only covers
 * `makeDaemonHook` — the rest of `boot.ts` is exercised through the
 * daemon test suite and integration paths.
 *
 * Also covers the daemon→aggregator wiring: verifies that
 * `registeredAgentFromLoadedIdentity` derives the correct membership-aware
 * `anyLabel` routing set (QA #2, harness#338).
 */

import { describe, it, expect } from "vitest";

import {
  makeAgentId,
  makeWakeId,
  registeredAgentFromLoadedIdentity,
  roleFrontmatterSchema,
  WakeCostBuilder,
  type IdentityChain,
  type LoadedAgentIdentity,
} from "@murmurations-ai/core";

import { isOrphanedSchedule, makeDaemonHook } from "./boot.js";

describe("makeDaemonHook", () => {
  const builder = (): WakeCostBuilder =>
    WakeCostBuilder.start({
      wakeId: makeWakeId("test-wake"),
      agentId: makeAgentId("test-agent"),
      modelTier: "balanced",
      groupIds: [],
    });

  const fakeLogger = (): {
    warn: (event: string, fields?: Record<string, unknown>) => void;
    calls: { event: string; fields?: Record<string, unknown> }[];
  } => {
    const calls: { event: string; fields?: Record<string, unknown> }[] = [];
    return {
      warn: (event, fields) => {
        if (fields !== undefined) calls.push({ event, fields });
        else calls.push({ event });
      },
      calls,
    };
  };

  it("prices a known model and does not warn", () => {
    const log = fakeLogger();
    const hook = makeDaemonHook(builder(), log);
    hook.onLlmCall({
      provider: "openai",
      model: "gpt-5.5",
      inputTokens: 1_000,
      outputTokens: 1_000,
    });
    expect(log.calls).toHaveLength(0);
  });

  it("warns once for an unknown model, then dedupes", () => {
    const log = fakeLogger();
    const hook = makeDaemonHook(builder(), log);
    for (let i = 0; i < 5; i++) {
      hook.onLlmCall({
        provider: "openai",
        model: "gpt-5.99-imaginary",
        inputTokens: 100,
        outputTokens: 100,
      });
    }
    expect(log.calls).toHaveLength(1);
    expect(log.calls[0]?.event).toBe("daemon.cost.pricing.unknown");
    expect(log.calls[0]?.fields).toMatchObject({
      provider: "openai",
      model: "gpt-5.99-imaginary",
      code: "unknown-model",
    });
  });

  it("warns separately for each unknown (provider, model) pair", () => {
    const log = fakeLogger();
    const hook = makeDaemonHook(builder(), log);
    hook.onLlmCall({
      provider: "openai",
      model: "fake-a",
      inputTokens: 1,
      outputTokens: 1,
    });
    hook.onLlmCall({
      provider: "anthropic",
      model: "fake-b",
      inputTokens: 1,
      outputTokens: 1,
    });
    hook.onLlmCall({
      provider: "openai",
      model: "fake-a",
      inputTokens: 1,
      outputTokens: 1,
    });
    expect(log.calls).toHaveLength(2);
  });

  it("does not throw when no logger is supplied (boot validation pass)", () => {
    const hook = makeDaemonHook(builder());
    expect(() =>
      hook.onLlmCall({
        provider: "openai",
        model: "fake",
        inputTokens: 1,
        outputTokens: 1,
      }),
    ).not.toThrow();
  });

  it("still records token counts when pricing is unknown (cost as 0)", () => {
    const log = fakeLogger();
    const b = builder();
    const hook = makeDaemonHook(b, log);
    hook.onLlmCall({
      provider: "openai",
      model: "fake",
      inputTokens: 7_000,
      outputTokens: 1_500,
    });
    const record = b.finalize(new Date());
    expect(record.llm.inputTokens).toBe(7_000);
    expect(record.llm.outputTokens).toBe(1_500);
    expect(record.llm.costMicros.value).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// QA #2 (harness#338): daemon→aggregator routing-label wiring
//
// Verifies that registeredAgentFromLoadedIdentity derives the correct
// membership-aware anyLabel OR-set so that a future boot.ts refactor that
// drops the derivation step is caught by CI rather than silently regressing
// to the harness#331 bug class.
// ---------------------------------------------------------------------------

const makeMinimalChain = (agentId: string): IdentityChain => ({
  agentId: makeAgentId(agentId),
  layers: [],
  frontmatter: {
    agentId: makeAgentId(agentId),
    name: agentId,
    modelTier: "balanced",
    groupMemberships: [],
  },
});

const makeLoadedIdentity = (
  agentId: string,
  groups: readonly string[],
  anyLabelOverride?: readonly string[],
): LoadedAgentIdentity => ({
  agentId: makeAgentId(agentId),
  chain: makeMinimalChain(agentId),
  frontmatter: roleFrontmatterSchema.parse({
    agent_id: agentId,
    name: agentId,
    model_tier: "balanced",
    group_memberships: groups,
    signals: {
      sources: ["github-issue"],
      github_scopes: [
        {
          owner: "acme",
          repo: "signals",
          filter: {
            state: "all",
            ...(anyLabelOverride !== undefined ? { any_label: anyLabelOverride } : {}),
          },
        },
      ],
    },
  }),
});

const INTERVAL_TRIGGER = { kind: "interval" as const, intervalMs: 60_000 };

describe("registeredAgentFromLoadedIdentity — routing label wiring (QA #2, harness#338)", () => {
  it("agent with group membership receives derived anyLabel including group scope", () => {
    const loaded = makeLoadedIdentity("agent-a", ["partnership"]);
    const registered = registeredAgentFromLoadedIdentity(loaded, INTERVAL_TRIGGER);

    const anyLabel = registered.signalScopes?.githubScopes?.[0]?.filter.anyLabel;
    expect(anyLabel).toBeDefined();
    expect(anyLabel).toContain("assigned:agent-a");
    expect(anyLabel).toContain("scope:agent:agent-a");
    expect(anyLabel).toContain("scope:group:partnership");
    expect(anyLabel).toContain("scope:all");
  });

  it("agent without group memberships receives derived anyLabel without group scopes", () => {
    const loaded = makeLoadedIdentity("agent-b", []);
    const registered = registeredAgentFromLoadedIdentity(loaded, INTERVAL_TRIGGER);

    const anyLabel = registered.signalScopes?.githubScopes?.[0]?.filter.anyLabel;
    expect(anyLabel).toBeDefined();
    expect(anyLabel).toContain("assigned:agent-b");
    expect(anyLabel).toContain("scope:agent:agent-b");
    expect(anyLabel).toContain("scope:all");
    expect(anyLabel?.some((l) => l.startsWith("scope:group:"))).toBe(false);
  });

  it("operator-supplied any_label in role.md overrides the daemon-derived default", () => {
    const customLabels = ["custom-label", "my-special-routing"];
    const loaded = makeLoadedIdentity("agent-c", ["engineering"], customLabels);
    const registered = registeredAgentFromLoadedIdentity(loaded, INTERVAL_TRIGGER);

    const anyLabel = registered.signalScopes?.githubScopes?.[0]?.filter.anyLabel;
    expect(anyLabel).toEqual(customLabels);
    // derived labels should NOT be present when operator overrides
    expect(anyLabel).not.toContain("scope:group:engineering");
    expect(anyLabel).not.toContain("assigned:agent-c");
  });
});

describe("isOrphanedSchedule (harness#380)", () => {
  const baseLoaded = (fallback?: LoadedAgentIdentity["fallback"]): LoadedAgentIdentity => ({
    agentId: makeAgentId("test"),
    chain: makeMinimalChain("test"),
    frontmatter: roleFrontmatterSchema.parse({
      agent_id: "test",
      name: "test",
      model_tier: "balanced",
      group_memberships: [],
      signals: { sources: ["github-issue"], github_scopes: [] },
    }),
    ...(fallback !== undefined ? { fallback } : {}),
  });

  it("returns false for a fully-loaded agent (no fallback)", () => {
    expect(isOrphanedSchedule(baseLoaded())).toBe(false);
  });

  it("returns true when role.md is in the missing-files list", () => {
    expect(
      isOrphanedSchedule(
        baseLoaded({
          reason: "missing-files",
          missingFiles: ["role.md"],
        }),
      ),
    ).toBe(true);
  });

  it("returns true when both role.md and soul.md are missing", () => {
    expect(
      isOrphanedSchedule(
        baseLoaded({
          reason: "missing-files",
          missingFiles: ["soul.md", "role.md"],
        }),
      ),
    ).toBe(true);
  });

  it("returns false when only soul.md is missing (operator iterating)", () => {
    expect(
      isOrphanedSchedule(
        baseLoaded({
          reason: "missing-files",
          missingFiles: ["soul.md"],
        }),
      ),
    ).toBe(false);
  });

  it("returns false for missing-frontmatter fallback (role.md exists)", () => {
    expect(
      isOrphanedSchedule(
        baseLoaded({
          reason: "missing-frontmatter",
          missingFiles: [],
        }),
      ),
    ).toBe(false);
  });

  it("returns false for invalid-frontmatter fallback (role.md exists)", () => {
    expect(
      isOrphanedSchedule(
        baseLoaded({
          reason: "invalid-frontmatter",
          missingFiles: [],
          detail: "YAML parse failed",
        }),
      ),
    ).toBe(false);
  });
});
