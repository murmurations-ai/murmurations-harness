/**
 * Spirit memory — Workstream O.
 *
 * Per-murmuration memory store. Mirrors ADR-0029 (agent memory) for
 * Spirit, scoped to `<root>/.murmuration/spirit/memory/`. The shape +
 * autosave taxonomy (user / feedback / project / reference) come
 * verbatim from Claude Code's auto-memory system so operators
 * transitioning between the two surfaces don't have to learn a new
 * vocabulary.
 *
 * Files:
 *   MEMORY.md        — index, always loaded into the Spirit system prompt
 *   {type}_*.md      — memory bodies, lazy-loaded by name
 *
 * This module owns no LLM logic — it's a pure storage + index surface.
 * Tools wrap it (remember/forget/recall) and the Spirit client embeds
 * the index in the system prompt at attach.
 *
 * @see docs/specs/0002-spirit-meta-agent.md §5 Workstream O
 * @see docs/adr/0043-spirit-as-meta-agent.md §Part 2
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type MemoryType = "user" | "feedback" | "project" | "reference";

export interface MemoryFile {
  readonly name: string;
  readonly type: MemoryType;
  readonly description: string;
  readonly body: string;
}

export interface RecallHit {
  readonly name: string;
  readonly type: MemoryType;
  readonly description: string;
  readonly snippet: string;
}

const MEMORY_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const RESERVED_NAMES = new Set([
  "con",
  "aux",
  "nul",
  "prn",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);
const MAX_INDEX_LINES = 200;

const isValidName = (name: string): boolean =>
  MEMORY_NAME_RE.test(name) && !RESERVED_NAMES.has(name);

/** Collapse newlines + control chars in a single-line YAML scalar so the
 *  description can't break out of frontmatter or inject extra keys. */
const sanitizeDescription = (input: string): string =>
  // eslint-disable-next-line no-control-regex
  input.replace(/[\x00-\x1f]+/g, " ").trim();

const memoryDirOf = (rootDir: string): string => join(rootDir, ".murmuration", "spirit", "memory");
const indexPathOf = (rootDir: string): string => join(memoryDirOf(rootDir), "MEMORY.md");
const fileNameOf = (name: string): string => `${name}.md`;

export class SpiritMemory {
  readonly #rootDir: string;

  public constructor(rootDir: string) {
    this.#rootDir = rootDir;
  }

  public get dir(): string {
    return memoryDirOf(this.#rootDir);
  }

  public get indexPath(): string {
    return indexPathOf(this.#rootDir);
  }

  /**
   * Read the index. Returns empty string when the index doesn't exist
   * yet — callers (Spirit system prompt, recall tool) treat that as
   * "no memories accumulated yet."
   */
  public async readIndex(): Promise<string> {
    try {
      const content = await readFile(this.indexPath, "utf8");
      return truncateIndex(content);
    } catch {
      return "";
    }
  }

  /**
   * Write a new memory file and update the index. The frontmatter
   * matches Claude Code's auto-memory format so operators can hand-edit
   * the files using the same conventions.
   */
  public async remember(input: {
    readonly type: MemoryType;
    readonly name: string;
    readonly description: string;
    readonly body: string;
  }): Promise<void> {
    if (!isValidName(input.name)) {
      throw new Error(
        `invalid memory name "${input.name}" — use lowercase letters, digits, hyphens, underscores; reserved names are rejected`,
      );
    }
    const description = sanitizeDescription(input.description);
    await mkdir(this.dir, { recursive: true });
    const filePath = join(this.dir, fileNameOf(input.name));
    const content = `---
name: ${input.name}
description: ${description}
type: ${input.type}
---

${input.body.trimEnd()}
`;
    await writeFile(filePath, content, "utf8");
    await this.#updateIndexEntry(input.name, description);
  }

  /**
   * Remove a memory by name. Idempotent — silently no-ops when the
   * file doesn't exist.
   */
  public async forget(name: string): Promise<{ readonly removed: boolean }> {
    if (!isValidName(name)) {
      throw new Error(`invalid memory name "${name}"`);
    }
    const filePath = join(this.dir, fileNameOf(name));
    if (!existsSync(filePath)) return { removed: false };
    await rm(filePath, { force: true });
    await this.#removeIndexEntry(name);
    return { removed: true };
  }

  /**
   * Read one memory file by name. Returns null when missing.
   */
  public async read(name: string): Promise<MemoryFile | null> {
    if (!isValidName(name)) return null;
    const filePath = join(this.dir, fileNameOf(name));
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch {
      return null;
    }
    return parseMemoryFile(name, content);
  }

  /**
   * Search memory files for a query (case-insensitive substring) or
   * return the index when no query is given. Bounded by the on-disk
   * file count — Spirit memory is intentionally small (operators
   * curate), so we don't paginate.
   */
  public async recall(query?: string): Promise<RecallHit[]> {
    if (!existsSync(this.dir)) return [];

    let files: string[];
    try {
      files = (await readdir(this.dir))
        .filter((f) => f.endsWith(".md") && f !== "MEMORY.md")
        .sort();
    } catch {
      return [];
    }

    const hits: RecallHit[] = [];
    for (const f of files) {
      const name = f.replace(/\.md$/, "");
      const memory = await this.read(name);
      if (!memory) continue;
      if (query !== undefined) {
        const q = query.toLowerCase();
        if (
          !memory.body.toLowerCase().includes(q) &&
          !memory.description.toLowerCase().includes(q) &&
          !memory.name.toLowerCase().includes(q)
        ) {
          continue;
        }
      }
      hits.push({
        name: memory.name,
        type: memory.type,
        description: memory.description,
        snippet: snippet(memory.body, query),
      });
    }
    return hits;
  }

  /**
   * Remove every memory file and the index. Used by `:reset memory`.
   * Idempotent on a missing/empty directory. Returns per-file failures
   * so the REPL can surface partial-reset state instead of silently
   * reporting an inflated count.
   */
  public async resetAll(): Promise<{
    readonly cleared: number;
    readonly failed: readonly string[];
  }> {
    if (!existsSync(this.dir)) return { cleared: 0, failed: [] };
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch (err) {
      return {
        cleared: 0,
        failed: [`<readdir>: ${err instanceof Error ? err.message : String(err)}`],
      };
    }
    let cleared = 0;
    const failed: string[] = [];
    for (const f of files) {
      try {
        await rm(join(this.dir, f), { force: true });
        cleared++;
      } catch (err) {
        failed.push(`${f}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { cleared, failed };
  }

  // ---------------------------------------------------------------------------
  // Index maintenance
  // ---------------------------------------------------------------------------

  async #updateIndexEntry(name: string, description: string): Promise<void> {
    const fileName = fileNameOf(name);
    const entry = `- [${name}](${fileName}) — ${description.replace(/\n.*/s, "")}`;
    let lines: string[] = [];
    try {
      const existing = await readFile(this.indexPath, "utf8");
      lines = existing.split("\n").filter((l) => l.length > 0);
    } catch {
      /* missing file — start fresh */
    }
    const filtered = lines.filter((l) => !l.startsWith(`- [${name}]`));
    filtered.push(entry);
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.indexPath, filtered.join("\n") + "\n", "utf8");
  }

  async #removeIndexEntry(name: string): Promise<void> {
    let existing: string;
    try {
      existing = await readFile(this.indexPath, "utf8");
    } catch {
      return;
    }
    const lines = existing.split("\n").filter((l) => l.length > 0);
    const filtered = lines.filter((l) => !l.startsWith(`- [${name}]`));
    if (filtered.length === 0) {
      await rm(this.indexPath, { force: true });
      return;
    }
    await writeFile(this.indexPath, filtered.join("\n") + "\n", "utf8");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const truncateIndex = (content: string): string => {
  const lines = content.split("\n");
  if (lines.length <= MAX_INDEX_LINES) return content;
  const kept = lines.slice(0, MAX_INDEX_LINES);
  return (
    kept.join("\n") +
    `\n\n_(showing ${String(MAX_INDEX_LINES)} of ${String(lines.length)} index lines — older entries truncated)_\n`
  );
};

const parseMemoryFile = (name: string, content: string): MemoryFile | null => {
  const fmMatch = /^---\n([\s\S]*?)\n---\n?/m.exec(content);
  if (!fmMatch) return null;
  const fm = fmMatch[1] ?? "";
  const body = content.slice(fmMatch[0].length).trim();
  const typeMatch = /^type:\s*(user|feedback|project|reference)\s*$/m.exec(fm);
  const descMatch = /^description:\s*(.*)$/m.exec(fm);
  if (!typeMatch || !descMatch) return null;
  return {
    name,
    type: typeMatch[1] as MemoryType,
    description: descMatch[1]?.trim() ?? "",
    body,
  };
};

const snippet = (body: string, query?: string): string => {
  const trimmed = body.trim();
  if (query === undefined) return trimmed.slice(0, 200);
  const idx = trimmed.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return trimmed.slice(0, 200);
  const start = Math.max(0, idx - 50);
  const end = Math.min(trimmed.length, idx + query.length + 100);
  const lead = start > 0 ? "…" : "";
  const tail = end < trimmed.length ? "…" : "";
  return `${lead}${trimmed.slice(start, end)}${tail}`;
};
