/**
 * Skill scanner tests — Three-Tier Progressive Disclosure.
 *
 * Tests SKILL.md parsing, directory scanning, XML formatting,
 * and prompt block generation.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { scanSkills, formatSkillsXml, formatSkillsPromptBlock } from "./index.js";
import type { SkillEntry } from "./index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let skillsDir: string;

const writeSkill = async (subdir: string, content: string): Promise<void> => {
  const dir = join(skillsDir, subdir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), content, "utf8");
};

beforeEach(async () => {
  skillsDir = await mkdtemp(join(tmpdir(), "skills-test-"));
});

afterEach(async () => {
  if (skillsDir) await rm(skillsDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// scanSkills
// ---------------------------------------------------------------------------

describe("scanSkills", () => {
  it("returns empty array for nonexistent directory", async () => {
    const skills = await scanSkills("/tmp/__nonexistent_skills_dir__");
    expect(skills).toEqual([]);
  });

  it("returns empty array for empty directory", async () => {
    const skills = await scanSkills(skillsDir);
    expect(skills).toEqual([]);
  });

  it("parses a single SKILL.md with name and description", async () => {
    await writeSkill(
      "my-skill",
      `---
name: my-skill
description: A test skill for doing things.
---

# My Skill

Full instructions here.
`,
    );

    const skills = await scanSkills(skillsDir);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe("my-skill");
    expect(skills[0]!.description).toBe("A test skill for doing things.");
    expect(skills[0]!.location).toContain("my-skill/SKILL.md");
  });

  it("scans multiple skills recursively and sorts by name", async () => {
    await writeSkill(
      "zeta-skill",
      `---
name: zeta-skill
description: The last skill alphabetically.
---
# Zeta
`,
    );
    await writeSkill(
      "alpha-skill",
      `---
name: alpha-skill
description: The first skill alphabetically.
---
# Alpha
`,
    );
    await writeSkill(
      "nested/deep/beta-skill",
      `---
name: beta-skill
description: A deeply nested skill.
---
# Beta
`,
    );

    const skills = await scanSkills(skillsDir);
    expect(skills).toHaveLength(3);
    expect(skills.map((s) => s.name)).toEqual(["alpha-skill", "beta-skill", "zeta-skill"]);
  });

  it("skips SKILL.md without name in frontmatter", async () => {
    await writeSkill(
      "no-name",
      `---
description: Missing the name field.
---
# No Name
`,
    );

    const skills = await scanSkills(skillsDir);
    expect(skills).toEqual([]);
  });

  it("skips SKILL.md without frontmatter", async () => {
    await writeSkill("no-frontmatter", "# Just Markdown\n\nNo frontmatter block.");
    const skills = await scanSkills(skillsDir);
    expect(skills).toEqual([]);
  });

  it("handles description-only frontmatter (no name) gracefully", async () => {
    await writeSkill(
      "desc-only",
      `---
description: Has description but no name.
---
# Desc Only
`,
    );
    const skills = await scanSkills(skillsDir);
    expect(skills).toEqual([]);
  });

  it("returns absolute paths in location", async () => {
    await writeSkill(
      "abs-path",
      `---
name: abs-path-skill
description: Test absolute path resolution.
---
`,
    );
    const skills = await scanSkills(skillsDir);
    expect(skills[0]!.location).toMatch(/^\//); // starts with /
    expect(skills[0]!.location).toContain("abs-path/SKILL.md");
  });
});

// ---------------------------------------------------------------------------
// formatSkillsXml
// ---------------------------------------------------------------------------

describe("formatSkillsXml", () => {
  it("returns empty string for no skills", () => {
    expect(formatSkillsXml([])).toBe("");
  });

  it("formats single skill as XML", () => {
    const skills: SkillEntry[] = [
      { name: "test-skill", description: "A test.", location: "/path/to/SKILL.md" },
    ];
    const xml = formatSkillsXml(skills);
    expect(xml).toContain("<available_skills>");
    expect(xml).toContain("<name>test-skill</name>");
    expect(xml).toContain("<description>A test.</description>");
    expect(xml).toContain("<location>/path/to/SKILL.md</location>");
    expect(xml).toContain("</available_skills>");
  });

  it("formats multiple skills", () => {
    const skills: SkillEntry[] = [
      { name: "skill-a", description: "First.", location: "/a/SKILL.md" },
      { name: "skill-b", description: "Second.", location: "/b/SKILL.md" },
    ];
    const xml = formatSkillsXml(skills);
    expect(xml).toContain("<name>skill-a</name>");
    expect(xml).toContain("<name>skill-b</name>");
  });

  it("escapes XML special characters", () => {
    const skills: SkillEntry[] = [
      { name: "a&b", description: "x < y > z", location: "/path/SKILL.md" },
    ];
    const xml = formatSkillsXml(skills);
    expect(xml).toContain("a&amp;b");
    expect(xml).toContain("x &lt; y &gt; z");
  });
});

// ---------------------------------------------------------------------------
// formatSkillsPromptBlock
// ---------------------------------------------------------------------------

describe("formatSkillsPromptBlock", () => {
  it("returns empty string for no skills", () => {
    expect(formatSkillsPromptBlock([])).toBe("");
  });

  it("includes instruction text and XML block", () => {
    const skills: SkillEntry[] = [
      {
        name: "s3-governance",
        description: "S3 governance patterns.",
        location: "/skills/SKILL.md",
      },
    ];
    const block = formatSkillsPromptBlock(skills);
    expect(block).toContain("## Available Skills");
    expect(block).toContain("scan the skills below");
    expect(block).toContain("`read` tool");
    expect(block).toContain("<available_skills>");
    expect(block).toContain("s3-governance");
  });
});
