/**
 * User configuration — ~/.murmuration/config.toml
 *
 * Minimal TOML parser for the config subset we need (flat key-value
 * pairs under [sections]). No external dependencies.
 *
 * ADR-0018 §7: Configuration file.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MurmurationConfig {
  readonly ui: {
    readonly leader: string;
    readonly prompt: string;
    readonly color: "auto" | "always" | "never";
  };
  readonly keys: Readonly<Record<string, string>>;
  readonly aliases: Readonly<Record<string, string>>;
  readonly sessions: {
    readonly pinned: readonly string[];
  };
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: MurmurationConfig = {
  ui: {
    leader: "C-a",
    prompt: "{name}> ",
    color: "auto",
  },
  keys: {
    "C-a d": ":detach",
    "C-a s": ":switch",
    "C-a a": ":agent",
    "C-a g": ":group",
    "C-a w": ":wake",
    "C-a c": ":convene",
    "C-a e": ":events --follow",
    "C-a /": ":search",
    "C-a ?": ":help",
    "C-a q": ":quit",
  },
  aliases: {},
  sessions: { pinned: [] },
};

// ---------------------------------------------------------------------------
// Minimal TOML parser (subset: flat sections with string/array values)
// ---------------------------------------------------------------------------

const parseMiniToml = (content: string): Record<string, Record<string, string | string[]>> => {
  const result: Record<string, Record<string, string | string[]>> = {};
  let currentSection = "__root__";

  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    // Section header: [section]
    const sectionMatch = /^\[([a-zA-Z_.-]+)\]$/.exec(line);
    if (sectionMatch?.[1]) {
      currentSection = sectionMatch[1];
      result[currentSection] ??= {};
      continue;
    }

    // Key = value
    const kvMatch = /^"?([^"=]+)"?\s*=\s*(.+)$/.exec(line);
    if (kvMatch?.[1] && kvMatch[2]) {
      const key = kvMatch[1].trim().replace(/^"|"$/g, "");
      const rawVal = kvMatch[2].trim();

      const section = result[currentSection] ?? {};
      result[currentSection] = section;

      // Array: ["a", "b"]
      if (rawVal.startsWith("[")) {
        const items = rawVal
          .replace(/^\[|\]$/g, "")
          .split(",")
          .map((s) => s.trim().replace(/^"|"$/g, ""))
          .filter(Boolean);
        section[key] = items;
      } else {
        // String: "value" or bare value
        section[key] = rawVal.replace(/^"|"$/g, "");
      }
    }
  }
  return result;
};

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

const CONFIG_PATH = join(homedir(), ".murmuration", "config.toml");

export const loadConfig = (): MurmurationConfig => {
  if (!existsSync(CONFIG_PATH)) return DEFAULT_CONFIG;

  try {
    const content = readFileSync(CONFIG_PATH, "utf8");
    const parsed = parseMiniToml(content);

    const ui = parsed.ui ?? {};
    const keys = parsed.keys ?? {};
    const aliases = parsed.aliases ?? {};
    const sessions = parsed.sessions ?? {};

    return {
      ui: {
        leader: typeof ui.leader === "string" ? ui.leader : DEFAULT_CONFIG.ui.leader,
        prompt: typeof ui.prompt === "string" ? ui.prompt : DEFAULT_CONFIG.ui.prompt,
        color:
          ui.color === "auto" || ui.color === "always" || ui.color === "never"
            ? ui.color
            : DEFAULT_CONFIG.ui.color,
      },
      keys: {
        ...DEFAULT_CONFIG.keys,
        ...(Object.fromEntries(
          Object.entries(keys).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        ) as Record<string, string>),
      },
      aliases: Object.fromEntries(
        Object.entries(aliases).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ) as Record<string, string>,
      sessions: {
        pinned: Array.isArray(sessions.pinned) ? sessions.pinned : DEFAULT_CONFIG.sessions.pinned,
      },
    };
  } catch {
    return DEFAULT_CONFIG;
  }
};

/** Get the config file path for display purposes. */
export const configPath = (): string => CONFIG_PATH;
