/**
 * Phase 1 Spirit tools — auto-allow ring only.
 *
 * Each tool wraps either:
 *   (a) a daemon socket RPC via the `send` function threaded in from
 *       the REPL attach loop, or
 *   (b) a filesystem read guarded by path-safety rules.
 *
 * Includes basic mutations (write_file) so agents can generate artifacts.
 *
 * Tools return strings because the LLM consumes the result as text
 * anyway. JSON is stringified; filesystem reads return raw bytes.
 */

import { readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
import { join, resolve, relative, basename, dirname } from "node:path";

import type { ToolDefinition } from "@murmurations-ai/llm";
import { z } from "zod";

import { spiritSkillsDir } from "./system-prompt.js";

// ---------------------------------------------------------------------------
// Socket response shape shared with attach.ts
// ---------------------------------------------------------------------------

interface SocketResponse {
  readonly id: string;
  readonly result?: unknown;
  readonly error?: string;
}

type Send = (method: string, params?: Record<string, unknown>) => Promise<SocketResponse>;

interface ToolContext {
  readonly send: Send;
  readonly rootDir: string;
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

const BLOCKED_PATH_PATTERNS = [/\.env$/i, /\.env\./i, /(^|\/)\.env$/i];

class PathSafetyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PathSafetyError";
  }
}

/**
 * Resolve `path` under `rootDir` and refuse any escape. Also refuses
 * reads of `.env*` files. Returns the absolute path safe to open.
 */
const safePath = (rootDir: string, path: string): string => {
  const abs = resolve(rootDir, path);
  const rel = relative(rootDir, abs);
  if (rel.startsWith("..") || rel === "..") {
    throw new PathSafetyError(`path "${path}" escapes the murmuration root`);
  }
  const base = basename(abs);
  for (const pattern of BLOCKED_PATH_PATTERNS) {
    if (pattern.test(base)) {
      throw new PathSafetyError(`reading "${path}" is not allowed (contains secrets)`);
    }
  }
  return abs;
};

// ---------------------------------------------------------------------------
// Response normalization
// ---------------------------------------------------------------------------

const formatSocketResponse = (resp: SocketResponse): string => {
  if (resp.error !== undefined) return `daemon error: ${resp.error}`;
  if (resp.result === undefined) return "(no result)";
  return JSON.stringify(resp.result, null, 2);
};

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const buildSpiritTools = (ctx: ToolContext): readonly ToolDefinition[] => {
  const { send, rootDir } = ctx;

  const statusTool: ToolDefinition = {
    name: "status",
    description:
      "Get the daemon's current status: version, PID, governance model, agent count, pending governance items, in-flight meetings.",
    parameters: z.object({}),
    execute: async () => formatSocketResponse(await send("status")),
  };

  const agentsTool: ToolDefinition = {
    name: "agents",
    description:
      "List registered agents with their state (idle/running/failed), total wakes, total artifacts, idle-wake rate, and group memberships.",
    parameters: z.object({}),
    execute: async () => formatSocketResponse(await send("agents.list")),
  };

  const groupsTool: ToolDefinition = {
    name: "groups",
    description:
      "List groups with member counts. Use when the operator asks about circles, teams, or group structure.",
    parameters: z.object({}),
    execute: async () => formatSocketResponse(await send("groups.list")),
  };

  const eventsTool: ToolDefinition = {
    name: "events",
    description:
      "Fetch recent daemon events (wake fires, governance transitions, meeting completions). Use for diagnosing why something did or didn't happen.",
    parameters: z.object({
      limit: z
        .number()
        .int()
        .positive()
        .max(100)
        .optional()
        .describe("Max events to return. Default: 20."),
    }),
    execute: async (input) => {
      const { limit } = input as { limit?: number };
      const params = limit !== undefined ? { limit } : {};
      return formatSocketResponse(await send("events.history", params));
    },
  };

  const readFileTool: ToolDefinition = {
    name: "read_file",
    description:
      "Read a file in the murmuration root. Use for inspecting agent souls, role.md, harness.yaml, group docs, meeting minutes, etc. Paths are relative to the murmuration root. `.env*` files are blocked.",
    parameters: z.object({
      path: z.string().describe("Path relative to the murmuration root."),
    }),
    execute: async (input) => {
      const { path } = input as { path: string };
      try {
        const abs = safePath(rootDir, path);
        return await readFile(abs, "utf8");
      } catch (err) {
        if (err instanceof PathSafetyError) return err.message;
        return `read_file error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };

  const listDirTool: ToolDefinition = {
    name: "list_dir",
    description:
      "Enumerate entries in a directory under the murmuration root. Returns a simple list with `[dir]` or `[file]` markers.",
    parameters: z.object({
      path: z
        .string()
        .describe("Directory path relative to the murmuration root. Use '.' for root."),
    }),
    execute: async (input) => {
      const { path } = input as { path: string };
      try {
        const abs = safePath(rootDir, path || ".");
        const entries = await readdir(abs);
        const lines: string[] = [];
        for (const entry of entries) {
          try {
            const stats = await stat(join(abs, entry));
            lines.push(`${stats.isDirectory() ? "[dir]" : "[file]"} ${entry}`);
          } catch {
            lines.push(`[?]   ${entry}`);
          }
        }
        return lines.join("\n");
      } catch (err) {
        if (err instanceof PathSafetyError) return err.message;
        return `list_dir error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };

  const loadSkillTool: ToolDefinition = {
    name: "load_skill",
    description:
      "Load a Spirit skill file by name (e.g. 'agent-anatomy', 'governance-models'). See the skills index in the system prompt for what's available.",
    parameters: z.object({
      name: z.string().describe("Skill name without the .md extension."),
    }),
    execute: async (input) => {
      const { name } = input as { name: string };
      if (!/^[a-z0-9-]+$/.test(name)) {
        return `load_skill error: invalid skill name "${name}" (expected kebab-case)`;
      }
      try {
        return await readFile(join(spiritSkillsDir(), `${name}.md`), "utf8");
      } catch {
        return `load_skill error: skill "${name}" not found`;
      }
    },
  };

  const wakeTool: ToolDefinition = {
    name: "wake",
    description:
      "Trigger an immediate wake for one agent. Equivalent to the operator typing `:wake <agent>`. Wakes are billable — use on clear operator intent.",
    parameters: z.object({
      agent_id: z.string().describe("The agentId to wake."),
    }),
    execute: async (input) => {
      const { agent_id } = input as { agent_id: string };
      return formatSocketResponse(await send("wake-now", { agentId: agent_id }));
    },
  };

  const directiveTool: ToolDefinition = {
    name: "directive",
    description:
      "Send a Source directive to an agent, a group, or all agents. Creates a coordination item that agents will see as a signal on their next wake.",
    parameters: z.object({
      scope: z.enum(["agent", "group", "all"]).describe("Who receives the directive."),
      target: z
        .string()
        .optional()
        .describe(
          "For scope=agent or scope=group, the agent-id or group-id. Omitted for scope=all.",
        ),
      message: z.string().describe("The directive body."),
    }),
    execute: async (input) => {
      const { scope, target, message } = input as {
        scope: "agent" | "group" | "all";
        target?: string;
        message: string;
      };
      if (scope === "agent") {
        if (!target) return "directive error: scope=agent requires target";
        return formatSocketResponse(await send("directive", { scope: "--agent", target, message }));
      }
      if (scope === "group") {
        if (!target) return "directive error: scope=group requires target";
        return formatSocketResponse(await send("directive", { scope: "--group", target, message }));
      }
      return formatSocketResponse(await send("directive", { scope: "--all", message }));
    },
  };

  const conveneTool: ToolDefinition = {
    name: "convene",
    description:
      "Convene a group meeting. Triggers an LLM-backed meeting with real cost. Operator intent must be explicit.",
    parameters: z.object({
      group_id: z.string().describe("Group to convene."),
      kind: z
        .enum(["operational", "governance", "retrospective"])
        .optional()
        .describe("Meeting kind. Default: operational."),
    }),
    execute: async (input) => {
      const { group_id, kind } = input as {
        group_id: string;
        kind?: "operational" | "governance" | "retrospective";
      };
      const params = kind !== undefined ? { groupId: group_id, kind } : { groupId: group_id };
      return formatSocketResponse(await send("group-wake", params));
    },
  };

  const writeFileTool: ToolDefinition = {
    name: "write_file",
    description:
      "Write content to a file in the murmuration root. Creates directories if they do not exist. Use for creating artifacts, drafting memories, or writing context files. Paths are relative to the murmuration root. Overwrites existing files.",
    parameters: z.object({
      path: z.string().describe("Path relative to the murmuration root."),
      content: z.string().describe("Content to write."),
    }),
    execute: async (input) => {
      const { path, content } = input as { path: string; content: string };
      try {
        const abs = safePath(rootDir, path);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content, "utf8");
        return `Successfully wrote file ${path}`;
      } catch (err) {
        if (err instanceof PathSafetyError) return err.message;
        return `write_file error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };

  return [
    statusTool,
    agentsTool,
    groupsTool,
    eventsTool,
    readFileTool,
    listDirTool,
    writeFileTool,
    loadSkillTool,
    wakeTool,
    directiveTool,
    conveneTool,
  ];
};
