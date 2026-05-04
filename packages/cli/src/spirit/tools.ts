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
// Strict tool type for Spirit — ADR-0038 CF-D (harness#283)
// ---------------------------------------------------------------------------
//
// Spirit's tools must use `z.object(...)` for `parameters` because the MCP
// transport (mcp-server.ts) unwraps `.shape` to construct MCP `inputSchema`.
// We narrow the type at this consumer site rather than tightening the public
// `ToolDefinition` in @murmurations-ai/llm — extension- and MCP-loaded tools
// keep `parameters: unknown` because they may carry an ai-sdk `Schema<T>`
// from `jsonSchema(...)` rather than a Zod object. Inline narrowing here
// makes Spirit's invariant a compile error at the tool definition site
// without breaking the broader contract.

type SpiritTool = ToolDefinition & {
  readonly parameters: z.ZodObject<z.ZodRawShape>;
};

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

export const buildSpiritTools = (ctx: ToolContext): readonly SpiritTool[] => {
  const { send, rootDir } = ctx;

  const statusTool: SpiritTool = {
    name: "status",
    description:
      "Get the daemon's current status: version, PID, governance model, agent count, pending governance items, in-flight meetings.",
    parameters: z.object({}),
    execute: async () => formatSocketResponse(await send("status")),
  };

  const agentsTool: SpiritTool = {
    name: "agents",
    description:
      "List registered agents with their state (idle/running/failed), total wakes, total artifacts, idle-wake rate, and group memberships.",
    parameters: z.object({}),
    execute: async () => formatSocketResponse(await send("agents.list")),
  };

  const groupsTool: SpiritTool = {
    name: "groups",
    description:
      "List groups with member counts. Use when the operator asks about circles, teams, or group structure.",
    parameters: z.object({}),
    execute: async () => formatSocketResponse(await send("groups.list")),
  };

  const eventsTool: SpiritTool = {
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

  const readFileTool: SpiritTool = {
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

  const listDirTool: SpiritTool = {
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

  const loadSkillTool: SpiritTool = {
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

  const wakeTool: SpiritTool = {
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

  const directiveTool: SpiritTool = {
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

  const conveneTool: SpiritTool = {
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

  const writeFileTool: SpiritTool = {
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

  // ------------------------------------------------------------------------
  // Facilitator-related tools (Workstream K3)
  //
  // Source-facing surfaces for v0.7.0 effectiveness work — read-only
  // disk queries that do not require the daemon. Items requiring
  // GitHub state (label queries, issue mutations) defer to the
  // operator's `gh` CLI with a generated command, since Spirit does
  // not currently hold a GitHub client. A daemon-RPC version is
  // planned as a follow-up.
  // ------------------------------------------------------------------------

  const getFacilitatorLogTool: SpiritTool = {
    name: "get_facilitator_log",
    description:
      "Read the most recent facilitator-agent wake digest from disk (or a specific date if given). Returns the full digest body — transitions, closures, retries, escalations. Use to scan what the facilitator did on its latest pass.",
    parameters: z.object({
      date: z
        .string()
        .optional()
        .describe("Optional YYYY-MM-DD date to fetch. Defaults to the most recent wake."),
    }),
    execute: async (input) => {
      const { date } = input as { date?: string };
      try {
        return await readLatestFacilitatorDigest(rootDir, date);
      } catch (err) {
        return `get_facilitator_log error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };

  const getAgreementTool: SpiritTool = {
    name: "get_agreement",
    description:
      "Fetch a governance agreement (item) by id from the on-disk store at .murmuration/governance/items.jsonl. Returns JSON with current state, history, and reviewAt. Use after `convene` to confirm a decision was recorded.",
    parameters: z.object({
      id: z.string().describe("Governance item id (e.g. 'proposal-2026-05-04-priorities')."),
    }),
    execute: async (input) => {
      const { id } = input as { id: string };
      try {
        const item = await readGovernanceItem(rootDir, id);
        if (!item) return `get_agreement: no item with id "${id}"`;
        return JSON.stringify(item, null, 2);
      } catch (err) {
        return `get_agreement error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };

  const listAwaitingSourceCloseTool: SpiritTool = {
    name: "list_awaiting_source_close",
    description:
      'List GitHub issues the facilitator has flagged as awaiting Source action (label `awaiting:source-close`). Best-effort disk scan: parses the most recent facilitator-agent digest for the awaiting-close section. For an authoritative live query, run: `gh issue list --label "awaiting:source-close" --repo <owner>/<repo>`.',
    parameters: z.object({}),
    execute: async () => {
      try {
        const digest = await readLatestFacilitatorDigest(rootDir);
        return extractAwaitingCloseSection(digest);
      } catch (err) {
        return `list_awaiting_source_close error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };

  const closeIssueTool: SpiritTool = {
    name: "close_issue",
    description:
      "Source-side close from the REPL. Spirit does not currently hold a GitHub write client — this tool returns the exact `gh issue close` invocation to run, including the closing comment. Run it with `:!` or paste it into a terminal.",
    parameters: z.object({
      number: z.number().int().positive().describe("Issue number to close."),
      reason: z.string().describe("Closing comment / decision summary."),
      repo: z
        .string()
        .optional()
        .describe("owner/repo. If omitted, gh uses the current working directory's repo."),
    }),
    execute: (input) => {
      const { number, reason, repo } = input as { number: number; reason: string; repo?: string };
      const escaped = reason.replace(/'/g, "'\\''");
      const repoArg = repo ? ` --repo ${repo}` : "";
      const cmd = `gh issue close ${String(number)}${repoArg} --comment '${escaped}'`;
      return Promise.resolve(
        `Run this to close the issue (Spirit can't mutate GitHub directly yet):\n\n  ${cmd}\n`,
      );
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
    getFacilitatorLogTool,
    getAgreementTool,
    listAwaitingSourceCloseTool,
    closeIssueTool,
  ];
};

// ---------------------------------------------------------------------------
// Workstream K3 — disk readers backing the facilitator-related tools
// ---------------------------------------------------------------------------

const readLatestFacilitatorDigest = async (rootDir: string, date?: string): Promise<string> => {
  const facilitatorDir = join(rootDir, "runs", "facilitator-agent");
  let dayDirs: string[];
  try {
    const entries = await readdir(facilitatorDir, { withFileTypes: true });
    dayDirs = entries
      .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return "(facilitator-agent has no runs yet — start the daemon and wait for its first wake)";
  }
  if (dayDirs.length === 0) {
    return "(facilitator-agent has no wake digests yet)";
  }

  const targetDay = date ?? dayDirs[dayDirs.length - 1] ?? "";
  const dayPath = join(facilitatorDir, targetDay);

  let digestFiles: string[];
  try {
    const dayEntries = await readdir(dayPath);
    digestFiles = dayEntries.filter((f) => f.startsWith("digest-") && f.endsWith(".md")).sort();
  } catch {
    return `(no digests found for ${targetDay})`;
  }
  if (digestFiles.length === 0) {
    return `(no digests found for ${targetDay})`;
  }

  const latest = digestFiles[digestFiles.length - 1] ?? "";
  return await readFile(join(dayPath, latest), "utf8");
};

interface RawGovernanceItem {
  readonly id?: unknown;
  readonly kind?: unknown;
  readonly currentState?: unknown;
  readonly createdBy?: { readonly value?: unknown };
  readonly createdAt?: unknown;
  readonly reviewAt?: unknown;
  readonly history?: readonly unknown[];
}

const readGovernanceItem = async (
  rootDir: string,
  id: string,
): Promise<RawGovernanceItem | null> => {
  const path = join(rootDir, ".murmuration", "governance", "items.jsonl");
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return null;
  }
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as RawGovernanceItem;
      if (parsed.id === id) return parsed;
    } catch {
      /* skip malformed line */
    }
  }
  return null;
};

const extractAwaitingCloseSection = (digest: string): string => {
  if (digest.startsWith("(")) return digest;

  const lines = digest.split("\n");
  const collected: string[] = [];
  let inSection = false;
  for (const line of lines) {
    const isHeader = /^#{1,6}\s/.test(line);
    if (isHeader) {
      const lower = line.toLowerCase();
      if (lower.includes("awaiting") && lower.includes("source")) {
        inSection = true;
        collected.push(line);
        continue;
      }
      if (inSection) break;
    }
    if (inSection) collected.push(line);
  }

  if (collected.length === 0) {
    return "(no 'awaiting source' section in the latest facilitator digest — check `gh issue list --label \"awaiting:source-close\"` for live state)";
  }
  return collected.join("\n").trim();
};
