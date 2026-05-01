/**
 * Tests for cli-detect — the subscription-CLI auto-detection helpers
 * that drive `murmuration init`'s recommended-default LLM choice.
 *
 * `detectInstalledClis` shells out to `spawnSync`, so its behavior on
 * any CI runner depends on what binaries that runner has installed.
 * Don't pin to "claude is detected" or similar — instead, assert the
 * shape of the result and the deterministic behavior of the formatter.
 */

import { describe, expect, it } from "vitest";

import { detectInstalledClis, formatDetectionSummary, type CliPresence } from "./cli-detect.js";

describe("detectInstalledClis", () => {
  it("returns one entry per known subscription CLI", () => {
    const result = detectInstalledClis();
    expect(result.clis).toHaveLength(3);
    expect(result.clis.map((c) => c.cli).sort()).toEqual(["claude", "codex", "gemini"]);
  });

  it("each entry has a default model and provider id", () => {
    const result = detectInstalledClis();
    for (const c of result.clis) {
      expect(c.defaultModel.length).toBeGreaterThan(0);
      expect(c.providerId).toMatch(/-cli$/);
    }
  });

  it("anyAvailable matches at least one cli.available", () => {
    const result = detectInstalledClis();
    const someAvailable = result.clis.some((c) => c.available);
    expect(result.anyAvailable).toBe(someAvailable);
  });

  it("recommended is null iff no CLI is available", () => {
    const result = detectInstalledClis();
    if (result.anyAvailable) {
      expect(result.recommended).not.toBeNull();
      expect(result.recommended?.available).toBe(true);
    } else {
      expect(result.recommended).toBeNull();
    }
  });

  it("recommended preference order is claude → codex → gemini", () => {
    // We can't predict which CLIs are installed, but we can assert the
    // tie-breaking: if claude is available, recommended must be claude.
    const result = detectInstalledClis();
    if (!result.anyAvailable) return;
    const claude = result.clis.find((c) => c.cli === "claude");
    const codex = result.clis.find((c) => c.cli === "codex");
    if (claude?.available) {
      expect(result.recommended?.cli).toBe("claude");
    } else if (codex?.available) {
      expect(result.recommended?.cli).toBe("codex");
    } else {
      expect(result.recommended?.cli).toBe("gemini");
    }
  });
});

describe("formatDetectionSummary", () => {
  const providerIdFor = (cli: CliPresence["cli"]): CliPresence["providerId"] => {
    if (cli === "claude") return "claude-cli";
    if (cli === "codex") return "codex-cli";
    return "gemini-cli";
  };
  const present = (cli: CliPresence["cli"], version: string): CliPresence => ({
    cli,
    available: true,
    version,
    defaultModel: "test",
    providerId: providerIdFor(cli),
  });
  const absent = (cli: CliPresence["cli"]): CliPresence => ({
    cli,
    available: false,
    version: null,
    defaultModel: "test",
    providerId: providerIdFor(cli),
  });

  it("reports '(none detected)' when nothing is installed", () => {
    const summary = formatDetectionSummary({
      clis: [absent("claude"), absent("codex"), absent("gemini")],
      anyAvailable: false,
      recommended: null,
    });
    expect(summary).toBe("(none detected)");
  });

  it("lists installed CLIs with versions, comma-separated", () => {
    const summary = formatDetectionSummary({
      clis: [present("claude", "2.0.31"), absent("codex"), present("gemini", "0.21.0")],
      anyAvailable: true,
      recommended: present("claude", "2.0.31"),
    });
    expect(summary).toBe("claude (2.0.31), gemini (0.21.0)");
  });

  it("substitutes 'version unknown' when version is null", () => {
    const summary = formatDetectionSummary({
      clis: [
        {
          cli: "claude",
          available: true,
          version: null,
          defaultModel: "test",
          providerId: "claude-cli",
        },
      ],
      anyAvailable: true,
      recommended: null,
    });
    expect(summary).toContain("version unknown");
  });
});
