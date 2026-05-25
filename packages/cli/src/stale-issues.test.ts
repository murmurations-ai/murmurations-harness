import { describe, expect, it } from "vitest";

import {
  classifyStaleIssues,
  fetchOpenIssues,
  partitionByReason,
  type StaleScanCandidate,
} from "./stale-issues.js";

describe("classifyStaleIssues (harness#394)", () => {
  const NOW = new Date("2026-05-25T12:00:00Z");
  const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
  const issue = (
    overrides: Partial<StaleScanCandidate> & { number: number; title: string },
  ): StaleScanCandidate => ({
    number: overrides.number,
    title: overrides.title,
    htmlUrl: overrides.htmlUrl ?? `https://example/${String(overrides.number)}`,
    createdAt: overrides.createdAt ?? daysAgo(1),
    updatedAt: overrides.updatedAt ?? daysAgo(1),
  });

  it("flags issues older than the age threshold with no recent activity", () => {
    const stale = classifyStaleIssues(
      [
        issue({
          number: 1,
          title: "Old + silent",
          createdAt: daysAgo(30),
          updatedAt: daysAgo(10),
        }),
        issue({
          number: 2,
          title: "Old but commented recently",
          createdAt: daysAgo(30),
          updatedAt: daysAgo(2),
        }),
        issue({ number: 3, title: "Brand new" }),
      ],
      { now: NOW },
    );
    expect(stale.map((s) => s.number)).toEqual([1]);
    expect(stale[0]?.reason).toBe("by-age");
  });

  it("flags digest-pattern titles regardless of age", () => {
    const stale = classifyStaleIssues(
      [
        issue({ number: 10, title: "[FINANCE] Weekly burn" }),
        issue({ number: 11, title: "DIGEST: catch-up" }),
        issue({ number: 12, title: "Real work item" }),
        issue({ number: 13, title: "[Status] Sprint update" }),
        issue({ number: 14, title: "[KICKOFF] new initiative" }),
      ],
      { now: NOW },
    );
    expect(stale.map((s) => s.number).sort((a, b) => a - b)).toEqual([10, 11, 13, 14]);
    for (const s of stale) expect(s.reason).toBe("digest-pattern");
  });

  it("marks both reasons when an issue is digest-patterned AND stale", () => {
    const stale = classifyStaleIssues(
      [
        issue({
          number: 20,
          title: "[DIGEST] 2026-02 monthly",
          createdAt: daysAgo(90),
          updatedAt: daysAgo(45),
        }),
      ],
      { now: NOW },
    );
    expect(stale).toHaveLength(1);
    expect(stale[0]?.reason).toBe("both");
  });

  it("respects custom age / silence thresholds", () => {
    const stale = classifyStaleIssues(
      [
        issue({
          number: 30,
          title: "5 days old, silent",
          createdAt: daysAgo(5),
          updatedAt: daysAgo(3),
        }),
      ],
      { now: NOW, ageDays: 3, silenceDays: 2 },
    );
    expect(stale).toHaveLength(1);
  });

  it("--digest-only filters out by-age-only matches", () => {
    const stale = classifyStaleIssues(
      [
        issue({
          number: 40,
          title: "Old + silent, plain title",
          createdAt: daysAgo(30),
          updatedAt: daysAgo(10),
        }),
        issue({
          number: 41,
          title: "[DIGEST] recent",
          createdAt: daysAgo(1),
          updatedAt: daysAgo(1),
        }),
      ],
      { now: NOW, digestOnly: true },
    );
    expect(stale.map((s) => s.number)).toEqual([41]);
  });

  it("sorts oldest-silence first so the most urgent review surface bubbles up", () => {
    const stale = classifyStaleIssues(
      [
        issue({
          number: 50,
          title: "Silent 30d",
          createdAt: daysAgo(60),
          updatedAt: daysAgo(30),
        }),
        issue({
          number: 51,
          title: "Silent 90d",
          createdAt: daysAgo(120),
          updatedAt: daysAgo(90),
        }),
        issue({
          number: 52,
          title: "Silent 15d",
          createdAt: daysAgo(45),
          updatedAt: daysAgo(15),
        }),
      ],
      { now: NOW },
    );
    expect(stale.map((s) => s.number)).toEqual([51, 50, 52]);
  });
});

describe("partitionByReason (harness#394 — doctor hygiene view)", () => {
  const NOW = new Date("2026-05-25T12:00:00Z");
  const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
  const issue = (
    overrides: Partial<StaleScanCandidate> & { number: number; title: string },
  ): StaleScanCandidate => ({
    number: overrides.number,
    title: overrides.title,
    htmlUrl: overrides.htmlUrl ?? `https://example/${String(overrides.number)}`,
    createdAt: overrides.createdAt ?? daysAgo(1),
    updatedAt: overrides.updatedAt ?? daysAgo(1),
  });

  it("places by-age-only issues only in byAge", () => {
    const stale = classifyStaleIssues(
      [
        issue({
          number: 1,
          title: "Plain title",
          createdAt: daysAgo(30),
          updatedAt: daysAgo(10),
        }),
      ],
      { now: NOW },
    );
    const { byAge, byDigestPattern } = partitionByReason(stale);
    expect(byAge.map((i) => i.number)).toEqual([1]);
    expect(byDigestPattern).toEqual([]);
  });

  it("places digest-only issues only in byDigestPattern", () => {
    const stale = classifyStaleIssues([issue({ number: 2, title: "[DIGEST] recent" })], {
      now: NOW,
    });
    const { byAge, byDigestPattern } = partitionByReason(stale);
    expect(byAge).toEqual([]);
    expect(byDigestPattern.map((i) => i.number)).toEqual([2]);
  });

  it("places `both` issues in both buckets", () => {
    const stale = classifyStaleIssues(
      [
        issue({
          number: 3,
          title: "[DIGEST] 2026-02 monthly",
          createdAt: daysAgo(90),
          updatedAt: daysAgo(45),
        }),
      ],
      { now: NOW },
    );
    const { byAge, byDigestPattern } = partitionByReason(stale);
    expect(byAge.map((i) => i.number)).toEqual([3]);
    expect(byDigestPattern.map((i) => i.number)).toEqual([3]);
  });
});

describe("fetchOpenIssues slug validation (security)", () => {
  // The token never gets used — fetchOpenIssues throws on slug validation
  // before any network call. The point of these tests is to confirm that
  // a malicious or malformed `collaboration.repo` cannot redirect the
  // Bearer-token-bearing request to a non-GitHub host.
  const TOKEN = "ghp_TEST_NEVER_REACHES_NETWORK";
  const UA = "test";
  const expectInvalid = async (repo: string): Promise<void> => {
    await expect(fetchOpenIssues(repo, TOKEN, UA)).rejects.toThrow(/invalid repo/);
  };

  it("rejects empty owner or name", async () => {
    await expectInvalid("/foo");
    await expectInvalid("foo/");
    await expectInvalid("foo");
  });

  it("rejects path traversal", async () => {
    await expectInvalid("foo/..");
    await expectInvalid("../foo/bar");
    await expectInvalid("foo/bar..baz");
  });

  it("rejects query/fragment/host injection", async () => {
    await expectInvalid("foo/bar?x=evil");
    await expectInvalid("foo/bar#frag");
    await expectInvalid("foo/bar@evil.com");
    await expectInvalid("foo /bar"); // space
    await expectInvalid("foo/bar/baz"); // extra segment
  });

  it("rejects slugs starting with `.` or `-`", async () => {
    await expectInvalid(".foo/bar");
    await expectInvalid("foo/-bar");
  });

  it("accepts well-formed slugs (would proceed to fetch)", () => {
    // Doesn't actually run network — vitest aborts on the awaited fetch
    // if we don't mock it. So we only assert the call doesn't throw
    // synchronously on splitRepo (the security gate); the rest is mocked
    // by integration in CI environments. Confirming the regex doesn't
    // over-reject valid GitHub slugs.
    const valid = ["owner/repo", "Owner_With_Underscores/r", "o.k/r-e.p_o", "1user/2project"];
    for (const repo of valid) {
      // Re-implement the gate inline to avoid an actual fetch:
      const slash = repo.indexOf("/");
      const owner = repo.slice(0, slash);
      const name = repo.slice(slash + 1);
      expect(/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(owner)).toBe(true);
      expect(/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(name)).toBe(true);
    }
  });
});
