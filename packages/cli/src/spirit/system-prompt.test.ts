/**
 * System-prompt augmentation tests — Workstream O.
 *
 * The Spirit system prompt always includes the bundled SKILLS.md
 * index. When `rootDir` is supplied AND that murmuration has a non-
 * empty MEMORY.md, the prompt also embeds the memory index so the
 * LLM sees what's available without an explicit recall.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SpiritMemory } from "./memory.js";
import { buildSpiritSystemPrompt } from "./system-prompt.js";

describe("buildSpiritSystemPrompt (Workstream O)", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "spirit-prompt-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("teaches the four-type memory taxonomy", async () => {
    const prompt = await buildSpiritSystemPrompt();
    expect(prompt).toContain("user");
    expect(prompt).toContain("feedback");
    expect(prompt).toContain("project");
    expect(prompt).toContain("reference");
    expect(prompt.toLowerCase()).toContain("memory");
  });

  it("does not include the saved-memories section when no memories exist", async () => {
    const prompt = await buildSpiritSystemPrompt(root);
    expect(prompt).not.toContain("## Saved memories");
  });

  it("includes the saved-memories section once a memory is saved", async () => {
    const mem = new SpiritMemory(root);
    await mem.remember({
      type: "user",
      name: "user_role",
      description: "Source is in Pacific time",
      body: "Standup 7am.",
    });
    const prompt = await buildSpiritSystemPrompt(root);
    expect(prompt).toContain("## Saved memories");
    expect(prompt).toContain("user_role");
    expect(prompt).toContain("Pacific time");
  });
});
