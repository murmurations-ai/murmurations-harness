import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detectExistingState } from "./init.js";

describe("detectExistingState (v0.5.0 Milestone 2)", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "init-state-"));
  });

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("returns empty-or-missing for a nonexistent path", () => {
    const result = detectExistingState(join(dir, "does-not-exist"));
    expect(result.kind).toBe("empty-or-missing");
  });

  it("returns empty-or-missing for an empty directory", () => {
    const result = detectExistingState(dir);
    expect(result.kind).toBe("empty-or-missing");
  });

  it("returns current when both murmuration/ and agents/ exist (ADR-0026)", async () => {
    await mkdir(join(dir, "murmuration"), { recursive: true });
    await mkdir(join(dir, "agents"), { recursive: true });
    const result = detectExistingState(dir);
    expect(result.kind).toBe("current");
    expect(result.signals).toEqual(
      expect.arrayContaining([
        expect.stringContaining("murmuration/"),
        expect.stringContaining("agents/"),
      ]),
    );
  });

  it("returns legacy-circles when governance/circles/ exists but governance/groups/ doesn't", async () => {
    await mkdir(join(dir, "governance", "circles"), { recursive: true });
    await writeFile(join(dir, "governance", "circles", "example.md"), "# Example\n", "utf8");
    const result = detectExistingState(dir);
    expect(result.kind).toBe("legacy-circles");
    expect(result.signals.some((s) => s.includes("circles/"))).toBe(true);
  });

  it("returns current when both governance/circles/ and governance/groups/ coexist + murmuration/ + agents/", async () => {
    await mkdir(join(dir, "murmuration"), { recursive: true });
    await mkdir(join(dir, "agents"), { recursive: true });
    await mkdir(join(dir, "governance", "circles"), { recursive: true });
    await mkdir(join(dir, "governance", "groups"), { recursive: true });
    const result = detectExistingState(dir);
    expect(result.kind).toBe("current");
  });

  it("returns partial when murmuration/ exists but agents/ doesn't", async () => {
    await mkdir(join(dir, "murmuration"), { recursive: true });
    const result = detectExistingState(dir);
    expect(result.kind).toBe("partial");
    expect(result.signals.some((s) => s.includes("murmuration/"))).toBe(true);
  });

  it("returns partial when agents/ exists but murmuration/ doesn't", async () => {
    await mkdir(join(dir, "agents"), { recursive: true });
    const result = detectExistingState(dir);
    expect(result.kind).toBe("partial");
  });
});
