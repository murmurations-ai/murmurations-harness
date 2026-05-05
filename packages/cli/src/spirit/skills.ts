/**
 * Per-murmuration Spirit skills overlay — Workstream R.
 *
 * Operators can install skills at `<root>/.murmuration/spirit/skills/`
 * to teach this Spirit operator-specific patterns without forking the
 * harness. The overlay shadows the bundled skills shipped with the
 * binary: when both the per-murmuration and bundled skills define
 * the same name, per-murmuration wins.
 *
 * Files:
 *   <root>/.murmuration/spirit/skills/SKILLS.md    operator-installed index
 *   <root>/.murmuration/spirit/skills/*.md         operator-installed bodies
 *
 * Skills are markdown — no runtime, no sandbox. The overlay loads at
 * attach time and `load_skill` checks per-murmuration first.
 *
 * @see docs/specs/0002-spirit-meta-agent.md §5 Workstream R
 * @see docs/adr/0043-spirit-as-meta-agent.md §Part 3
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Collapse newlines + control chars in a single-line index entry so the
 *  description can't break out of the SKILLS.md row or the
 *  &lt;operator_skill_index&gt; container in Spirit's system prompt. Mirrors
 *  the same helper in memory.ts. */
const sanitizeDescription = (input: string): string =>
  // eslint-disable-next-line no-control-regex
  input.replace(/[\x00-\x1f]+/g, " ").trim();

const skillsDirOf = (rootDir: string): string => join(rootDir, ".murmuration", "spirit", "skills");
const indexPathOf = (rootDir: string): string => join(skillsDirOf(rootDir), "SKILLS.md");

export class SpiritSkillsOverlay {
  readonly #rootDir: string;

  public constructor(rootDir: string) {
    this.#rootDir = rootDir;
  }

  public get dir(): string {
    return skillsDirOf(this.#rootDir);
  }

  public get indexPath(): string {
    return indexPathOf(this.#rootDir);
  }

  /**
   * Read the per-murmuration SKILLS.md index. Returns empty string when
   * the operator hasn't installed any skills yet.
   */
  public async readIndex(): Promise<string> {
    try {
      return await readFile(this.indexPath, "utf8");
    } catch {
      return "";
    }
  }

  /**
   * Install or replace a skill. Validates the name (kebab-case, no
   * extension), writes the body, and refreshes the index entry.
   */
  public async install(input: {
    readonly name: string;
    readonly description: string;
    readonly body: string;
  }): Promise<void> {
    if (!SKILL_NAME_RE.test(input.name)) {
      throw new Error(`invalid skill name "${input.name}" — expected kebab-case`);
    }
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, `${input.name}.md`), input.body, "utf8");
    await this.#updateIndexEntry(input.name, input.description);
  }

  /**
   * Read the body of a per-murmuration skill by name. Returns null when
   * the skill is not installed (caller should then fall back to bundled).
   */
  public async read(name: string): Promise<string | null> {
    if (!SKILL_NAME_RE.test(name)) return null;
    const path = join(this.dir, `${name}.md`);
    try {
      return await readFile(path, "utf8");
    } catch {
      return null;
    }
  }

  /**
   * List per-murmuration skill names (without `.md`). Excludes the
   * SKILLS.md index. Returns empty array on missing dir.
   */
  public async list(): Promise<readonly string[]> {
    if (!existsSync(this.dir)) return [];
    try {
      const entries = await readdir(this.dir);
      return entries
        .filter((f) => f.endsWith(".md") && f !== "SKILLS.md")
        .map((f) => f.replace(/\.md$/, ""))
        .sort();
    } catch {
      return [];
    }
  }

  async #updateIndexEntry(name: string, description: string): Promise<void> {
    const entry = `- \`${name}\` — ${sanitizeDescription(description)}`;
    let lines: string[] = [];
    try {
      const existing = await readFile(this.indexPath, "utf8");
      lines = existing.split("\n").filter((l) => l.trim().length > 0 && !l.startsWith("# "));
    } catch {
      /* missing — start fresh */
    }
    const filtered = lines.filter((l) => !l.startsWith(`- \`${name}\``));
    filtered.push(entry);
    filtered.sort();
    const header =
      "# Per-murmuration Spirit skills\n\nOperator-installed skills for this murmuration. Shadow bundled skills with the same name.\n\n";
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.indexPath, header + filtered.join("\n") + "\n", "utf8");
  }
}
