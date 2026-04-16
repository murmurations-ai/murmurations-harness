/**
 * Skill scanner — Three-Tier Progressive Disclosure (AgentSkills.io).
 *
 * Tier 1 (startup): Scan `skills/` for SKILL.md files, extract name +
 *   description from YAML frontmatter, inject `<available_skills>` XML
 *   into agent system prompts.
 * Tier 2 (triggered): Agent reads full SKILL.md via MCP `read_file` tool
 *   when a task matches a skill's description.
 * Tier 3 (deep dive): Agent reads supplementary files referenced in
 *   SKILL.md only as needed.
 *
 * This module implements Tier 1 — the scanner and XML formatter.
 * 100% interoperable with OpenClaw and Claude Code SKILL.md format.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import matter from "gray-matter";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A discovered skill from a SKILL.md file. */
export interface SkillEntry {
  /** Skill name from frontmatter. */
  readonly name: string;
  /** Short description defining when to trigger. */
  readonly description: string;
  /** Absolute path to the SKILL.md file. */
  readonly location: string;
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

/**
 * Recursively scan a directory for SKILL.md files and extract frontmatter.
 *
 * @param skillsDir — absolute path to the skills/ directory
 * @returns discovered skills sorted by name
 */
export async function scanSkills(skillsDir: string): Promise<SkillEntry[]> {
  const entries: SkillEntry[] = [];

  try {
    await stat(skillsDir);
  } catch {
    return entries; // directory doesn't exist — no skills
  }

  await scanRecursive(skillsDir, entries);
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

async function scanRecursive(dir: string, entries: SkillEntry[]): Promise<void> {
  let items: string[];
  try {
    items = await readdir(dir);
  } catch {
    return;
  }

  for (const item of items) {
    const fullPath = join(dir, item);
    try {
      const s = await stat(fullPath);
      if (s.isDirectory()) {
        await scanRecursive(fullPath, entries);
      } else if (item === "SKILL.md") {
        const entry = await parseSkillFile(fullPath);
        if (entry) entries.push(entry);
      }
    } catch {
      // Skip unreadable entries
    }
  }
}

async function parseSkillFile(filePath: string): Promise<SkillEntry | null> {
  try {
    const content = await readFile(filePath, "utf8");
    const { data } = matter(content);

    const name = typeof data.name === "string" ? data.name.trim() : "";
    const description = typeof data.description === "string" ? data.description.trim() : "";

    if (!name) return null; // name is required

    return {
      name,
      description,
      location: resolve(filePath),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// XML formatter
// ---------------------------------------------------------------------------

/**
 * Format discovered skills as an `<available_skills>` XML block for
 * injection into agent system prompts.
 *
 * Returns empty string if no skills are available.
 */
export function formatSkillsXml(skills: readonly SkillEntry[]): string {
  if (skills.length === 0) return "";

  const items = skills
    .map(
      (s) =>
        `  <skill>\n    <name>${escapeXml(s.name)}</name>\n    <description>${escapeXml(s.description)}</description>\n    <location>${escapeXml(s.location)}</location>\n  </skill>`,
    )
    .join("\n");

  return `<available_skills>\n${items}\n</available_skills>`;
}

/**
 * Format the full system prompt appendix: XML block + instruction.
 *
 * Returns empty string if no skills are available.
 */
export function formatSkillsPromptBlock(skills: readonly SkillEntry[]): string {
  const xml = formatSkillsXml(skills);
  if (!xml) return "";

  return `\n\n---\n\n## Available Skills\n\nBefore replying, scan the skills below. If a skill's description matches your current task, use the \`read\` tool to load the full instructions from its \`<location>\` path, then follow those instructions.\n\n${xml}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
