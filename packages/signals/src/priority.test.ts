import { describe, expect, it } from "vitest";

import type { Signal } from "@murmurations-ai/core";

import {
  DEFAULT_TIER_CAPS,
  DEFAULT_TOTAL_CAP,
  bumpTier,
  classifyTier,
  composeBundle,
  filterDoneItems,
  type ClassifierContext,
  type PriorityTier,
} from "./priority.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const wakeStartedAt = new Date("2026-05-04T18:00:00Z");

const baseCtx = (overrides: Partial<ClassifierContext> = {}): ClassifierContext => ({
  selfAgentId: "research-agent",
  wakeStartedAt,
  isFacilitator: false,
  activeConsentRoundIssueNumbers: new Set<number>(),
  issuesFiledBySelf: new Set<number>(),
  ...overrides,
});

let nextId = 0;
const issue = (
  overrides: {
    readonly title?: string;
    readonly labels?: readonly string[];
    readonly number?: number;
    readonly fetchedAtAgeDays?: number;
  } = {},
): Signal => {
  const ageMs = (overrides.fetchedAtAgeDays ?? 0) * 24 * 60 * 60 * 1000;
  return {
    kind: "github-issue",
    id: `gh-${String(nextId++)}`,
    trust: "trusted",
    fetchedAt: new Date(wakeStartedAt.getTime() - ageMs),
    number: overrides.number ?? 100,
    title: overrides.title ?? "[TENSION] something is wrong",
    url: "https://example.com",
    labels: overrides.labels ?? [],
    excerpt: "",
  };
};

// ---------------------------------------------------------------------------
// classifyTier
// ---------------------------------------------------------------------------

describe("classifyTier — critical", () => {
  it("priority:critical label always wins", () => {
    expect(classifyTier(issue({ labels: ["priority:critical", "priority:low"] }), baseCtx())).toBe(
      "critical",
    );
  });

  it("source-directive + tier:consent in last 24h is critical", () => {
    const sig = issue({
      labels: ["source-directive", "tier:consent"],
      fetchedAtAgeDays: 0.5,
    });
    expect(classifyTier(sig, baseCtx())).toBe("critical");
  });

  it("source-directive + tier:consent older than 24h is NOT critical", () => {
    const sig = issue({
      labels: ["source-directive", "tier:consent"],
      title: "[DIRECTIVE] strategy",
      fetchedAtAgeDays: 2,
    });
    // Falls through to NORMAL (no [DIRECTIVE] assigned-self in 7d, no other tier match).
    expect(classifyTier(sig, baseCtx())).toBe("normal");
  });

  it("awaiting:source-close is critical for facilitator only", () => {
    const sig = issue({ labels: ["awaiting:source-close"] });
    expect(classifyTier(sig, baseCtx({ isFacilitator: true }))).toBe("critical");
    expect(classifyTier(sig, baseCtx({ isFacilitator: false }))).toBe("low");
  });
});

describe("classifyTier — high", () => {
  it("active consent round the agent is named in is high", () => {
    const sig = issue({ number: 552 });
    const ctx = baseCtx({ activeConsentRoundIssueNumbers: new Set([552]) });
    expect(classifyTier(sig, ctx)).toBe("high");
  });

  it("[DIRECTIVE] with assigned:<self> filed in last 7d is high", () => {
    const sig = issue({
      title: "[DIRECTIVE] something",
      labels: ["assigned:research-agent"],
      fetchedAtAgeDays: 3,
    });
    expect(classifyTier(sig, baseCtx())).toBe("high");
  });

  it("[DIRECTIVE] assigned:<self> older than 7d falls out of high", () => {
    const sig = issue({
      title: "[DIRECTIVE] something",
      labels: ["assigned:research-agent"],
      fetchedAtAgeDays: 10,
    });
    // 7d high-window expired but not aged out (>14d) → default normal.
    expect(classifyTier(sig, baseCtx())).toBe("normal");
  });

  it("[DIRECTIVE] assigned:<self> older than 14d is low", () => {
    const sig = issue({
      title: "[DIRECTIVE] ancient",
      labels: ["assigned:research-agent"],
      fetchedAtAgeDays: 20,
    });
    expect(classifyTier(sig, baseCtx())).toBe("low");
  });

  it("[OPERATIONAL MEETING] assigned:<self> is high", () => {
    const sig = issue({
      title: "[OPERATIONAL MEETING] 2026-W18",
      labels: ["assigned:research-agent"],
    });
    expect(classifyTier(sig, baseCtx())).toBe("high");
  });

  it("[GOVERNANCE MEETING] without assigned:<self> is normal", () => {
    const sig = issue({
      title: "[GOVERNANCE MEETING] consent round",
    });
    expect(classifyTier(sig, baseCtx())).toBe("normal");
  });
});

describe("classifyTier — low", () => {
  it("priority:low label is low", () => {
    expect(classifyTier(issue({ labels: ["priority:low"] }), baseCtx())).toBe("low");
  });

  it("issue older than 14d (no recent activity) is low", () => {
    const sig = issue({ fetchedAtAgeDays: 20 });
    expect(classifyTier(sig, baseCtx())).toBe("low");
  });
});

describe("classifyTier — normal (default)", () => {
  it("[TENSION] filed by self with no other signals is normal", () => {
    const sig = issue({
      title: "[TENSION] research can't access X",
      number: 600,
    });
    const ctx = baseCtx({ issuesFiledBySelf: new Set([600]) });
    expect(classifyTier(sig, ctx)).toBe("normal");
  });

  it("non-issue signals default to normal", () => {
    const note: Signal = {
      kind: "private-note",
      id: "pn-1",
      trust: "trusted",
      fetchedAt: wakeStartedAt,
      path: "notes/x.md",
      summary: "test",
    };
    expect(classifyTier(note, baseCtx())).toBe("normal");
  });
});

// ---------------------------------------------------------------------------
// bumpTier
// ---------------------------------------------------------------------------

describe("bumpTier", () => {
  it("zero skips returns the input tier", () => {
    expect(bumpTier("normal", 0)).toBe("normal");
    expect(bumpTier("critical", 0)).toBe("critical");
  });

  it("each skip raises one tier", () => {
    expect(bumpTier("low", 1)).toBe("normal");
    expect(bumpTier("normal", 1)).toBe("high");
    expect(bumpTier("high", 1)).toBe("critical");
  });

  it("multi-skip composes", () => {
    expect(bumpTier("low", 2)).toBe("high");
    expect(bumpTier("low", 3)).toBe("critical");
    expect(bumpTier("normal", 2)).toBe("critical");
  });

  it("caps at critical", () => {
    expect(bumpTier("critical", 1)).toBe("critical");
    expect(bumpTier("critical", 5)).toBe("critical");
    expect(bumpTier("normal", 10)).toBe("critical");
  });
});

// ---------------------------------------------------------------------------
// composeBundle
// ---------------------------------------------------------------------------

describe("composeBundle", () => {
  it("respects per-tier caps for non-low tiers", () => {
    const sigs: Signal[] = [
      ...Array.from({ length: 10 }, () => issue({ labels: ["priority:critical"] })),
    ];
    const r = composeBundle(sigs, baseCtx());
    // 10 candidates, all critical, but cap is 5.
    expect(r.counts.critical).toBe(DEFAULT_TIER_CAPS.critical);
    expect(r.signals).toHaveLength(DEFAULT_TIER_CAPS.critical);
    expect(r.droppedCount).toBe(5);
  });

  it("low fills with whatever budget remains", () => {
    const sigs: Signal[] = [
      ...Array.from({ length: 5 }, () => issue({ labels: ["priority:critical"] })),
      ...Array.from({ length: 12 }, () => issue({ labels: ["priority:low"] })),
    ];
    const r = composeBundle(sigs, baseCtx());
    // critical takes 5; total cap is 15; low fills 10 of the 12 candidates.
    expect(r.counts.critical).toBe(5);
    expect(r.counts.low).toBe(10);
    expect(r.signals).toHaveLength(DEFAULT_TOTAL_CAP);
  });

  it("respects total cap across tiers", () => {
    const sigs: Signal[] = [
      ...Array.from({ length: 6 }, () => issue({ labels: ["priority:critical"] })),
      ...Array.from({ length: 10 }, (_, i) => issue({ number: 1000 + i, fetchedAtAgeDays: 1 })),
    ];
    const r = composeBundle(sigs, baseCtx(), { totalCap: 8 });
    expect(r.signals.length).toBeLessThanOrEqual(8);
    // critical takes 5, normal takes 3 to fill the cap.
    expect(r.counts.critical).toBe(5);
    expect(r.counts.normal).toBe(3);
  });

  it("preserves input order within a tier", () => {
    const a = issue({ number: 1, labels: ["priority:critical"] });
    const b = issue({ number: 2, labels: ["priority:critical"] });
    const c = issue({ number: 3, labels: ["priority:critical"] });
    const r = composeBundle([a, b, c], baseCtx());
    expect(r.signals.map((s) => (s.kind === "github-issue" ? s.number : -1))).toEqual([1, 2, 3]);
  });

  it("droppedCount reflects what didn't make it in", () => {
    const sigs: Signal[] = Array.from({ length: 20 }, () =>
      issue({ labels: ["priority:critical"] }),
    );
    const r = composeBundle(sigs, baseCtx());
    expect(r.signals.length + r.droppedCount).toBe(sigs.length);
    expect(r.signals).toHaveLength(DEFAULT_TIER_CAPS.critical);
  });

  it("default total cap is 15", () => {
    expect(DEFAULT_TOTAL_CAP).toBe(15);
  });

  it("emits items in tier order critical → high → normal → low", () => {
    const ctx = baseCtx({ activeConsentRoundIssueNumbers: new Set([200]) });
    const critical = issue({ number: 1, labels: ["priority:critical"] });
    const high = issue({ number: 200 });
    const normal = issue({ number: 300, fetchedAtAgeDays: 1 });
    const low = issue({ number: 400, labels: ["priority:low"] });
    // Pass them out of order to verify reordering works.
    const r = composeBundle([low, normal, high, critical], ctx);
    const numbers = r.signals.map((s) => (s.kind === "github-issue" ? s.number : -1));
    expect(numbers).toEqual([1, 200, 300, 400]);
  });

  it("a real EP-shaped agent bundle reflects expected priorities", () => {
    // Simulates a wake where the agent has:
    //   - 1 critical source-directive (fresh, tier:consent)
    //   - 1 active consent round they're named in (high)
    //   - 1 fresh assigned [DIRECTIVE] (high)
    //   - 2 aged [DIRECTIVE]s 8-13d (normal — out of high window, not yet low)
    //   - 2 own [TENSION]s (normal)
    //   - 8 stale issues from >14d (low)
    const ctx = baseCtx({
      activeConsentRoundIssueNumbers: new Set([900]),
      issuesFiledBySelf: new Set([700, 701]),
    });
    const sigs: Signal[] = [
      issue({
        number: 800,
        title: "[DIRECTIVE] strategy pivot",
        labels: ["source-directive", "tier:consent"],
        fetchedAtAgeDays: 0.5,
      }),
      issue({ number: 900, title: "[PROPOSAL] ratify pricing" }),
      issue({
        number: 850,
        title: "[DIRECTIVE] new tool",
        labels: ["assigned:research-agent"],
        fetchedAtAgeDays: 2,
      }),
      issue({
        number: 851,
        title: "[DIRECTIVE] old tool",
        labels: ["assigned:research-agent"],
        fetchedAtAgeDays: 9,
      }),
      issue({
        number: 852,
        title: "[DIRECTIVE] older tool",
        labels: ["assigned:research-agent"],
        fetchedAtAgeDays: 12,
      }),
      issue({ number: 700, title: "[TENSION] missing data" }),
      issue({ number: 701, title: "[TENSION] missing context" }),
      ...Array.from({ length: 8 }, (_, i) => issue({ number: 1000 + i, fetchedAtAgeDays: 30 })),
    ];
    const r = composeBundle(sigs, ctx);
    expect(r.counts.critical).toBe(1); // #800
    expect(r.counts.high).toBe(2); // #900 (consent round) + #850 (fresh directive)
    expect(r.counts.normal).toBe(4); // #851, #852, #700, #701 (capped at 4)
    // Total respects 15 cap; low fills the remaining 8 slots.
    expect(r.signals.length).toBe(DEFAULT_TOTAL_CAP);
    expect(r.counts.low).toBe(8);
    // First entry must be the critical one.
    const firstNumber = r.signals[0]?.kind === "github-issue" ? r.signals[0].number : -1;
    expect(firstNumber).toBe(800);
  });
});

// ---------------------------------------------------------------------------
// filterDoneItems
// ---------------------------------------------------------------------------

describe("filterDoneItems", () => {
  it("excludes signals whose id is in the done set", () => {
    const a = issue({ number: 1 });
    const b = issue({ number: 2 });
    const c = issue({ number: 3 });
    const done = new Set([a.id, c.id]);
    expect(filterDoneItems([a, b, c], done)).toEqual([b]);
  });

  it("returns all when done set is empty", () => {
    const sigs = [issue(), issue(), issue()];
    expect(filterDoneItems(sigs, new Set())).toEqual(sigs);
  });

  it("done items don't appear in tier counts after filter", () => {
    const a = issue({ number: 1, labels: ["priority:critical"] });
    const b = issue({ number: 2, labels: ["priority:critical"] });
    const filtered = filterDoneItems([a, b], new Set([a.id]));
    const r = composeBundle(filtered, baseCtx());
    expect(r.counts.critical).toBe(1);
    expect(r.signals).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// PriorityTier sanity
// ---------------------------------------------------------------------------

describe("PriorityTier", () => {
  it("has the four canonical tiers", () => {
    const tiers: PriorityTier[] = ["critical", "high", "normal", "low"];
    expect(tiers).toHaveLength(4);
  });
});
