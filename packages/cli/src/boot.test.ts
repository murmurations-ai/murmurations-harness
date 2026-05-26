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
  isOrphanedSchedule,
  makeAgentId,
  makeWakeId,
  registeredAgentFromLoadedIdentity,
  roleFrontmatterSchema,
  WakeCostBuilder,
  type IdentityChain,
  type LoadedAgentIdentity,
} from "@murmurations-ai/core";

import {
  deriveSubscriptionCliPermissionMode,
  makeDaemonHook,
  sanitizeForTerminal,
} from "./boot.js";

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

describe("sanitizeForTerminal (harness#380 review hardening)", () => {
  it("strips C0 controls and DEL", () => {
    expect(sanitizeForTerminal("a\x00b\x1bc\x7fd")).toBe("a?b?c?d");
  });

  it("strips C1 controls including 8-bit CSI (\\x9b)", () => {
    // \x9b renders as ESC [ in xterm / Terminal.app — leaving it
    // unfiltered would let a malicious dir name inject color/cursor codes.
    expect(sanitizeForTerminal("a\x80b\x9bc\x9fd")).toBe("a?b?c?d");
  });

  it("strips Unicode bidi overrides (CVE-2021-42574 Trojan Source)", () => {
    // U+202E (RIGHT-TO-LEFT OVERRIDE) is the classic Trojan Source primitive:
    // a directory named `agent-‮dm.elor` renders as `agent-role.md`.
    const tricked = "agent-‮dm.elor";
    expect(sanitizeForTerminal(tricked)).toBe("agent-?dm.elor");
    // Also covers isolates U+2066-U+2069.
    expect(sanitizeForTerminal("⁦hidden⁩")).toBe("?hidden?");
  });

  it("strips zero-width and format characters", () => {
    // U+200B zero-width space — invisible filename padding.
    expect(sanitizeForTerminal("foo​bar")).toBe("foo?bar");
    // U+FEFF BOM — also invisible.
    expect(sanitizeForTerminal("﻿foo")).toBe("?foo");
  });

  it("strips line/paragraph separators", () => {
    // U+2028 / U+2029 break terminal line accounting in some renderers.
    expect(sanitizeForTerminal("a b c")).toBe("a?b?c");
  });

  it("passes through safe ASCII unchanged", () => {
    expect(sanitizeForTerminal("agent-name_42.dir")).toBe("agent-name_42.dir");
  });

  it("passes through ordinary Unicode unchanged", () => {
    // CJK + accented letters are not security-relevant — keep them.
    expect(sanitizeForTerminal("agent-名前-é")).toBe("agent-名前-é");
  });
});

describe("deriveSubscriptionCliPermissionMode (harness#392)", () => {
  // Minimal RegisteredAgent factory — only `githubWriteScopes` is read by
  // the helper, so we synthesise a fixture that fills exactly that shape.
  const makeAgent = (
    branchCommits: readonly { readonly repo: string; readonly paths: readonly string[] }[],
  ): Parameters<typeof deriveSubscriptionCliPermissionMode>[0] => {
    return {
      agentId: "test-agent",
      displayName: "Test",
      modelTier: "balanced",
      maxWallClockMs: 10_000,
      identity: {
        agentId: makeAgentId("test-agent"),
        layers: [],
        frontmatter: {
          agentId: makeAgentId("test-agent"),
          name: "test",
          modelTier: "balanced",
          groupMemberships: [],
        },
      },
      githubWriteScopes: {
        issueComments: [],
        branchCommits,
        labels: [],
        issues: [],
      },
      trigger: { kind: "interval", intervalMs: 60_000 },
      groupMemberships: [],
    } as unknown as Parameters<typeof deriveSubscriptionCliPermissionMode>[0];
  };

  it("operator-set permissionMode wins, even when branch_commits is non-empty", () => {
    const agent = makeAgent([{ repo: "org/repo", paths: ["drafts/**"] }]);
    expect(deriveSubscriptionCliPermissionMode(agent, "restricted")).toBe("restricted");
    expect(deriveSubscriptionCliPermissionMode(agent, "operator-approved")).toBe(
      "operator-approved",
    );
    expect(deriveSubscriptionCliPermissionMode(agent, "trusted")).toBe("trusted");
  });

  it("auto-elevates to trusted when permissionMode is unset AND branch_commits has paths", () => {
    const agent = makeAgent([{ repo: "org/repo", paths: ["drafts/**", "pipeline/**"] }]);
    expect(deriveSubscriptionCliPermissionMode(agent, undefined)).toBe("trusted");
  });

  it("returns undefined when permissionMode is unset AND no branch_commits", () => {
    const agent = makeAgent([]);
    expect(deriveSubscriptionCliPermissionMode(agent, undefined)).toBeUndefined();
  });

  it("returns undefined when branch_commits entries exist but all have empty paths", () => {
    // Edge case: operator declared the repo block but no paths. Treat as
    // no write intent — don't auto-elevate.
    const agent = makeAgent([{ repo: "org/repo", paths: [] }]);
    expect(deriveSubscriptionCliPermissionMode(agent, undefined)).toBeUndefined();
  });

  it("auto-elevates when at least one branch_commits entry has paths (mixed case)", () => {
    const agent = makeAgent([
      { repo: "org/empty-repo", paths: [] },
      { repo: "org/real-repo", paths: ["src/**"] },
    ]);
    expect(deriveSubscriptionCliPermissionMode(agent, undefined)).toBe("trusted");
  });
});
