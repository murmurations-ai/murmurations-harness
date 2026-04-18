/**
 * Built-in filesystem extension — read/write/edit files within the
 * murmuration root.
 *
 * Agents that declare this plugin in their `role.md` gain four tools:
 *   write_file(path, content)   — create or overwrite; parent dirs
 *                                 created; .bak saved on overwrite
 *   read_file(path)             — read UTF-8 text
 *   edit_file(path, find, replace) — exact-string replacement; .bak saved
 *   list_dir(path)              — enumerate entries with [dir]/[file] tags
 *
 * Safety:
 *   - All paths are resolved relative to the murmuration root and
 *     refused if they escape it (no `..` traversal).
 *   - Any basename matching `.env*` is refused (secrets).
 *
 * Declare in `role.md`:
 *   plugins:
 *     - provider: "@murmurations-ai/files"
 *
 * This is an ADR-0023 OpenClaw-compatible plugin. The ADR-0025 Phase 3
 * pattern means agents only see these tools if they declare the plugin
 * (per-agent gating, v0.4.2+). Empty `plugins:` continues to see all
 * loaded plugins for backward compat.
 */

import { existsSync, promises as fs } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

import { z } from "zod";

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

const BLOCKED_PATH_PATTERNS = [/\.env$/i, /\.env\./i, /(^|\/)\.env$/i];

/**
 * Resolve `path` under `rootDir` and refuse any escape. Also refuses
 * any basename matching `.env*`. Returns the absolute path safe to open.
 */
const safePath = (rootDir, path) => {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("path must be a non-empty string");
  }
  const abs = resolve(rootDir, path);
  const rel = relative(rootDir, abs);
  if (rel.startsWith("..") || rel === "..") {
    throw new Error(`path "${path}" escapes the murmuration root`);
  }
  const base = basename(abs);
  for (const p of BLOCKED_PATH_PATTERNS) {
    if (p.test(base)) {
      throw new Error(`"${path}" is blocked (contains secrets)`);
    }
  }
  return abs;
};

/**
 * If `abs` exists, copy its current content to `abs + ".bak"` so the
 * operator can recover from an unintended overwrite via the REPL
 * `:undo` verb or manual revert. Silently no-ops when the file is new.
 */
const backupIfExists = async (abs) => {
  if (!existsSync(abs)) return;
  try {
    const original = await fs.readFile(abs, "utf8");
    await fs.writeFile(abs + ".bak", original, "utf8");
  } catch {
    // Best-effort — don't block the write on backup failure.
  }
};

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

/** @type {import("@murmurations-ai/core").ExtensionEntry} */
export default {
  id: "files",
  name: "Filesystem",
  description: "Read, write, and edit files within the murmuration root.",

  register(api) {
    const root = api.rootDir;

    api.registerTool({
      name: "write_file",
      description:
        "Create or overwrite a file at `path` (relative to the murmuration root). Parent directories are created if missing. If the file already exists, its current contents are saved to `<path>.bak` before overwriting. Paths outside the root or matching `.env*` are refused.",
      parameters: z.object({
        path: z.string().describe("File path relative to the murmuration root."),
        content: z.string().describe("The file content to write (UTF-8)."),
      }),
      execute: async ({ path, content }) => {
        try {
          const abs = safePath(root, path);
          await fs.mkdir(dirname(abs), { recursive: true });
          await backupIfExists(abs);
          await fs.writeFile(abs, content, "utf8");
          return `wrote ${path} (${String(content.length)} bytes)`;
        } catch (err) {
          return `write_file error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });

    api.registerTool({
      name: "read_file",
      description:
        "Read the UTF-8 content of `path` (relative to the murmuration root). Paths outside the root or matching `.env*` are refused.",
      parameters: z.object({
        path: z.string().describe("File path relative to the murmuration root."),
      }),
      execute: async ({ path }) => {
        try {
          const abs = safePath(root, path);
          return await fs.readFile(abs, "utf8");
        } catch (err) {
          return `read_file error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });

    api.registerTool({
      name: "edit_file",
      description:
        "Replace `find` with `replace` in an existing file. `find` must appear EXACTLY ONCE — if it appears zero or multiple times, the edit is refused. The original file is saved to `<path>.bak` before writing.",
      parameters: z.object({
        path: z.string().describe("File path relative to the murmuration root."),
        find: z.string().describe("The exact string to replace (must appear exactly once)."),
        replace: z.string().describe("The replacement string."),
      }),
      execute: async ({ path, find, replace }) => {
        try {
          const abs = safePath(root, path);
          const content = await fs.readFile(abs, "utf8");
          const first = content.indexOf(find);
          if (first === -1) {
            return `edit_file error: \`find\` string not found in ${path}`;
          }
          const next = content.indexOf(find, first + find.length);
          if (next !== -1) {
            return `edit_file error: \`find\` appears multiple times in ${path} — make it more specific`;
          }
          await backupIfExists(abs);
          const updated = content.slice(0, first) + replace + content.slice(first + find.length);
          await fs.writeFile(abs, updated, "utf8");
          return `edited ${path} (replaced 1 occurrence, ${String(find.length)} → ${String(replace.length)} chars)`;
        } catch (err) {
          return `edit_file error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });

    api.registerTool({
      name: "list_dir",
      description:
        "List entries in a directory relative to the murmuration root. Returns a newline-separated list with `[dir]` or `[file]` markers. Use `.` for the root.",
      parameters: z.object({
        path: z
          .string()
          .describe("Directory path relative to the murmuration root. Use '.' for root."),
      }),
      execute: async ({ path }) => {
        try {
          const abs = safePath(root, path && path.length > 0 ? path : ".");
          const entries = await fs.readdir(abs);
          const lines = [];
          for (const entry of entries) {
            try {
              const stats = await fs.stat(join(abs, entry));
              lines.push(`${stats.isDirectory() ? "[dir]" : "[file]"} ${entry}`);
            } catch {
              lines.push(`[?]   ${entry}`);
            }
          }
          return lines.join("\n");
        } catch (err) {
          return `list_dir error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });
  },
};
