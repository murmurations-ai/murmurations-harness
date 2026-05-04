/**
 * Spirit memory storage tests — Workstream O.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SpiritMemory } from "./memory.js";

describe("SpiritMemory", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "spirit-memory-"));
  });

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("readIndex returns empty string before any memory exists", async () => {
    const mem = new SpiritMemory(root);
    expect(await mem.readIndex()).toBe("");
  });

  it("remember writes file with frontmatter and updates the index", async () => {
    const mem = new SpiritMemory(root);
    await mem.remember({
      type: "user",
      name: "user_role",
      description: "Source is a knowledge-business operator in Pacific time",
      body: "Wakes 5:55am, runs daily standup at 7am.",
    });

    const filePath = join(mem.dir, "user_role.md");
    expect(existsSync(filePath)).toBe(true);
    const fileContent = readFileSync(filePath, "utf8");
    expect(fileContent).toContain("name: user_role");
    expect(fileContent).toContain("type: user");
    expect(fileContent).toContain("description: Source is a knowledge-business operator");
    expect(fileContent).toContain("Wakes 5:55am");

    const index = await mem.readIndex();
    expect(index).toContain("- [user_role](user_role.md)");
    expect(index).toContain("Pacific time");
  });

  it("rejects invalid memory names", async () => {
    const mem = new SpiritMemory(root);
    await expect(
      mem.remember({ type: "user", name: "bad name with spaces", description: "x", body: "y" }),
    ).rejects.toThrow(/invalid memory name/);
    await expect(
      mem.remember({ type: "user", name: "../escape", description: "x", body: "y" }),
    ).rejects.toThrow(/invalid memory name/);
  });

  it("forget removes file + index entry, idempotent on missing", async () => {
    const mem = new SpiritMemory(root);
    await mem.remember({ type: "user", name: "tmp", description: "tmp", body: "tmp" });
    expect(existsSync(join(mem.dir, "tmp.md"))).toBe(true);

    const result = await mem.forget("tmp");
    expect(result.removed).toBe(true);
    expect(existsSync(join(mem.dir, "tmp.md"))).toBe(false);

    const idx = await mem.readIndex();
    expect(idx).not.toContain("tmp");

    const second = await mem.forget("tmp");
    expect(second.removed).toBe(false);
  });

  it("recall with no query returns every memory", async () => {
    const mem = new SpiritMemory(root);
    await mem.remember({ type: "user", name: "a", description: "alpha", body: "first" });
    await mem.remember({ type: "feedback", name: "b", description: "beta", body: "second" });

    const all = await mem.recall();
    expect(all).toHaveLength(2);
    expect(all.map((h) => h.name).sort()).toEqual(["a", "b"]);
    expect(all.find((h) => h.name === "b")?.type).toBe("feedback");
  });

  it("recall with query case-insensitively matches name + description + body", async () => {
    const mem = new SpiritMemory(root);
    await mem.remember({
      type: "project",
      name: "release_v07",
      description: "v0.7.0 ships agent improvements",
      body: "PR #311 holds until Spirit work lands.",
    });
    await mem.remember({
      type: "reference",
      name: "vault",
      description: "external runbook",
      body: "lives in Xeeban-AI vault under Knowledge Business.",
    });

    expect((await mem.recall("v0.7")).map((h) => h.name)).toEqual(["release_v07"]);
    expect((await mem.recall("VAULT")).map((h) => h.name)).toEqual(["vault"]);
    expect((await mem.recall("PR #311")).map((h) => h.name)).toEqual(["release_v07"]);
    expect(await mem.recall("nope-no-match")).toEqual([]);
  });

  it("read returns a parsed MemoryFile", async () => {
    const mem = new SpiritMemory(root);
    await mem.remember({ type: "user", name: "x", description: "d", body: "body line" });
    const got = await mem.read("x");
    expect(got).not.toBeNull();
    expect(got?.type).toBe("user");
    expect(got?.description).toBe("d");
    expect(got?.body).toContain("body line");
  });

  it("read returns null on missing or invalid name", async () => {
    const mem = new SpiritMemory(root);
    expect(await mem.read("does-not-exist")).toBeNull();
    expect(await mem.read("../escape")).toBeNull();
  });

  it("resetAll removes every memory and the index", async () => {
    const mem = new SpiritMemory(root);
    await mem.remember({ type: "user", name: "a", description: "alpha", body: "x" });
    await mem.remember({ type: "user", name: "b", description: "beta", body: "y" });

    const result = await mem.resetAll();
    expect(result.cleared).toBeGreaterThanOrEqual(2);
    expect(await mem.readIndex()).toBe("");
    expect(await mem.recall()).toEqual([]);
  });

  it("remember on an existing name overwrites the file and refreshes the index entry", async () => {
    const mem = new SpiritMemory(root);
    await mem.remember({ type: "user", name: "p", description: "first", body: "old" });
    await mem.remember({ type: "user", name: "p", description: "second", body: "new" });

    const got = await mem.read("p");
    expect(got?.description).toBe("second");
    expect(got?.body).toContain("new");

    const idx = await mem.readIndex();
    // Only one entry — old one is replaced.
    const matches = idx.split("\n").filter((l) => l.includes("[p]"));
    expect(matches).toHaveLength(1);
    expect(matches[0]).toContain("second");
  });

  it("truncates the index above 200 lines with a footer", async () => {
    const mem = new SpiritMemory(root);
    for (let i = 0; i < 210; i++) {
      await mem.remember({
        type: "project",
        name: `entry${String(i)}`,
        description: `entry ${String(i)}`,
        body: "x",
      });
    }
    const idx = await mem.readIndex();
    expect(idx).toContain("older entries truncated");
  });
});
