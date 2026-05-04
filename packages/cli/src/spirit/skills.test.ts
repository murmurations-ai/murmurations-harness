/**
 * SpiritSkillsOverlay tests — Workstream R.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SpiritSkillsOverlay } from "./skills.js";

describe("SpiritSkillsOverlay (Workstream R)", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "spirit-skills-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("readIndex returns empty when nothing is installed", async () => {
    const overlay = new SpiritSkillsOverlay(root);
    expect(await overlay.readIndex()).toBe("");
    expect(await overlay.read("anything")).toBeNull();
    expect(await overlay.list()).toEqual([]);
  });

  it("install writes the body file and registers an index entry", async () => {
    const overlay = new SpiritSkillsOverlay(root);
    await overlay.install({
      name: "pricing-context",
      description: "Cross-link to the pricing decision in proposal-2026-05-04",
      body: "# Pricing\n\n- Always reference proposal-2026-05-04-priorities.\n",
    });

    expect(existsSync(join(overlay.dir, "pricing-context.md"))).toBe(true);
    expect(existsSync(overlay.indexPath)).toBe(true);

    const index = await overlay.readIndex();
    expect(index).toContain("# Per-murmuration Spirit skills");
    expect(index).toContain("- `pricing-context` —");
    expect(index).toContain("proposal-2026-05-04");

    const body = await overlay.read("pricing-context");
    expect(body).toContain("# Pricing");
    expect(body).toContain("proposal-2026-05-04-priorities");
  });

  it("list returns installed skill names sorted, excluding SKILLS.md", async () => {
    const overlay = new SpiritSkillsOverlay(root);
    await overlay.install({ name: "zeta", description: "z", body: "z" });
    await overlay.install({ name: "alpha", description: "a", body: "a" });
    expect(await overlay.list()).toEqual(["alpha", "zeta"]);
  });

  it("rejects invalid skill names", async () => {
    const overlay = new SpiritSkillsOverlay(root);
    await expect(
      overlay.install({ name: "bad name", description: "x", body: "y" }),
    ).rejects.toThrow(/invalid skill name/);
    await expect(
      overlay.install({ name: "../escape", description: "x", body: "y" }),
    ).rejects.toThrow(/invalid skill name/);
  });

  it("re-installing the same name overwrites the body and refreshes the index", async () => {
    const overlay = new SpiritSkillsOverlay(root);
    await overlay.install({ name: "foo", description: "old", body: "old body" });
    await overlay.install({ name: "foo", description: "new", body: "new body" });

    expect(readFileSync(join(overlay.dir, "foo.md"), "utf8")).toBe("new body");
    const index = await overlay.readIndex();
    const fooLines = index.split("\n").filter((l) => l.includes("`foo`"));
    expect(fooLines).toHaveLength(1);
    expect(fooLines[0]).toContain("new");
  });

  it("hand-dropped skill files are visible without re-installing", async () => {
    const overlay = new SpiritSkillsOverlay(root);
    mkdirSync(overlay.dir, { recursive: true });
    writeFileSync(join(overlay.dir, "manual.md"), "# Manual\n", "utf8");
    expect(await overlay.read("manual")).toContain("# Manual");
    expect(await overlay.list()).toContain("manual");
  });
});
