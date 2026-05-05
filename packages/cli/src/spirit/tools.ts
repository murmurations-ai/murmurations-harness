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

import { SpiritMemory, type MemoryType } from "./memory.js";
import { describeMurmuration } from "./overview.js";
import { SpiritSkillsOverlay } from "./skills.js";
import { buildReport, type ReportScope } from "./reports.js";
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

// Filenames Spirit refuses to touch via either read_file or write_file.
// `basename`-tested, so directory parts are not considered.
const BLOCKED_BASENAME_PATTERNS = [/\.env$/i, /\.env\./i];

class PathSafetyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PathSafetyError";
  }
}

/**
 * Resolve `path` under `rootDir` and refuse any escape. Refuses any
 * `.env*` file in either direction. For writes, additionally refuses
 * anything under `.murmuration/` — that subtree is daemon-authored
 * runtime state; Spirit may read it but never write into it.
 */
const safePath = (rootDir: string, path: string, mode: "read" | "write" = "read"): string => {
  const abs = resolve(rootDir, path);
  const rel = relative(rootDir, abs);
  if (rel.startsWith("..") || rel === "..") {
    throw new PathSafetyError(`path "${path}" escapes the murmuration root`);
  }
  const base = basename(abs);
  for (const pattern of BLOCKED_BASENAME_PATTERNS) {
    if (pattern.test(base)) {
      throw new PathSafetyError(`access to "${path}" is not allowed (contains secrets)`);
    }
  }
  if (mode === "write") {
    // Use platform-correct separator handling: relative() on POSIX returns
    // forward slashes; the leading-segment check works either way.
    if (
      rel === ".murmuration" ||
      rel.startsWith(".murmuration/") ||
      rel.startsWith(".murmuration\\")
    ) {
      throw new PathSafetyError(
        `writing under ".murmuration/" is not allowed — that subtree is daemon-authored runtime state`,
      );
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

  // v0.7.0 [R]: per-murmuration skill overlay. Operator-installed skills
  // shadow bundled skills with the same name; absent from the overlay,
  // we fall back to the bundled `spiritSkillsDir()`.
  const skillsOverlay = new SpiritSkillsOverlay(rootDir);

  const loadSkillTool: SpiritTool = {
    name: "load_skill",
    description:
      "Load a Spirit skill file by name (e.g. 'agent-anatomy', 'governance-models'). Per-murmuration skills installed at .murmuration/spirit/skills/ are checked first; bundled skills are the fallback. The response prefixes [per-murmuration] or [bundled] so you know which body you got.",
    parameters: z.object({
      name: z.string().describe("Skill name without the .md extension."),
    }),
    execute: async (input) => {
      const { name } = input as { name: string };
      if (!/^[a-z0-9-]+$/.test(name)) {
        return `load_skill error: invalid skill name "${name}" (expected kebab-case)`;
      }
      const overlay = await skillsOverlay.read(name);
      if (overlay !== null) return `[per-murmuration]\n\n${overlay}`;
      try {
        const bundled = await readFile(join(spiritSkillsDir(), `${name}.md`), "utf8");
        return `[bundled]\n\n${bundled}`;
      } catch {
        return `load_skill error: skill "${name}" not found`;
      }
    },
  };

  const installSkillTool: SpiritTool = {
    name: "install_skill",
    description:
      "Install a Spirit skill at .murmuration/spirit/skills/<name>.md and register it in SKILLS.md. Body is markdown — no runtime, no sandbox. Per-murmuration skills shadow bundled skills with the same name. Use to teach this Spirit operator-specific patterns (e.g. 'pricing-context') without forking the harness.",
    parameters: z.object({
      name: z.string().describe("Skill name (kebab-case, no extension)."),
      description: z
        .string()
        .describe("One-line summary used in the per-murmuration SKILLS.md index."),
      body: z.string().describe("Skill body (markdown)."),
    }),
    execute: async (input) => {
      const { name, description, body } = input as {
        name: string;
        description: string;
        body: string;
      };
      try {
        await skillsOverlay.install({ name, description, body });
        return `Installed skill "${name}" at ${skillsOverlay.dir}/${name}.md. Loadable via load_skill on next attach (also visible right now to the same Spirit instance).`;
      } catch (err) {
        return `install_skill error: ${err instanceof Error ? err.message : String(err)}`;
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
        const abs = safePath(rootDir, path, "write");
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
  // Spirit memory tools (Workstream O)
  //
  // remember/forget/recall over per-murmuration memory at
  // <root>/.murmuration/spirit/memory/. The index (MEMORY.md) is also
  // injected into the Spirit system prompt at attach so the LLM sees
  // available memories without an explicit recall.
  // ------------------------------------------------------------------------
  const memory = new SpiritMemory(rootDir);

  const rememberTool: SpiritTool = {
    name: "remember",
    description:
      "Save a memory file under .murmuration/spirit/memory/. Types: 'user' (facts about Source), 'feedback' (corrections/validations), 'project' (what's happening in this murmuration), 'reference' (pointers to external systems). Use the same taxonomy as Claude Code's auto-memory.",
    parameters: z.object({
      type: z
        .enum(["user", "feedback", "project", "reference"])
        .describe("Memory type — see tool description for when to use each."),
      name: z
        .string()
        .describe(
          "Memory name (kebab-case, no extension). Convention: prefix with type, e.g. user_role, feedback_testing, project_v07_release.",
        ),
      description: z
        .string()
        .describe("One-line summary used in the index — be specific about when this is relevant."),
      body: z.string().describe("Memory body (markdown)."),
    }),
    execute: async (input) => {
      const { type, name, description, body } = input as {
        type: MemoryType;
        name: string;
        description: string;
        body: string;
      };
      try {
        await memory.remember({ type, name, description, body });
        return `Saved memory "${name}" (${type}). Visible in MEMORY.md and recall().`;
      } catch (err) {
        return `remember error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };

  const forgetTool: SpiritTool = {
    name: "forget",
    description:
      "Delete a memory file by name. Removes both the .md file and its line in MEMORY.md. Idempotent — silently no-ops on missing memories.",
    parameters: z.object({
      name: z.string().describe("Memory name (no extension)."),
    }),
    execute: async (input) => {
      const { name } = input as { name: string };
      try {
        const result = await memory.forget(name);
        return result.removed ? `Removed memory "${name}".` : `No memory named "${name}".`;
      } catch (err) {
        return `forget error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };

  const recallTool: SpiritTool = {
    name: "recall",
    description:
      "Search Spirit memory. With no query, returns a summary of every memory file. With a query, returns case-insensitive substring matches across name, description, and body — each with a snippet around the hit.",
    parameters: z.object({
      query: z
        .string()
        .optional()
        .describe(
          "Optional case-insensitive substring. Omit to list all memories with their descriptions.",
        ),
    }),
    execute: async (input) => {
      const { query } = input as { query?: string };
      try {
        const hits = await memory.recall(query);
        if (hits.length === 0) {
          return query !== undefined
            ? `No memories matched "${query}".`
            : `No memories yet — use \`remember\` or \`:remember\` to save one.`;
        }
        return hits
          .map(
            (h) =>
              `- [${h.type}] ${h.name} — ${h.description}\n  ${h.snippet.replace(/\n/g, "\n  ")}`,
          )
          .join("\n\n");
      } catch (err) {
        return `recall error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };

  // ------------------------------------------------------------------------
  // Reporting surface (Workstream Q)
  //
  // report(scope) is the only LLM-facing surface — `health`, `activity`,
  // `attention`, or `all`. The standalone `metrics` and `attention_queue`
  // tools collapsed into this one (review feedback #10): fewer tool
  // descriptions = cheaper turns, and `report(scope: "health")` /
  // `report(scope: "attention")` already cover the same ground.
  // ------------------------------------------------------------------------
  const reportTool: SpiritTool = {
    name: "report",
    description:
      "One-call murmuration report. Scope 'health' = metrics; 'activity' = recent daemon events or last digests; 'attention' = the attention queue; 'all' = everything. Defaults to 'all'.",
    parameters: z.object({
      scope: z
        .enum(["health", "activity", "attention", "all"])
        .optional()
        .describe("Report scope. Default: all."),
    }),
    execute: async (input) => {
      const { scope } = input as { scope?: ReportScope };
      try {
        return await buildReport({ rootDir, send, scope: scope ?? "all" });
      } catch (err) {
        return `report error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };

  // ------------------------------------------------------------------------
  // Murmuration overview (Workstream P)
  //
  // describe_murmuration walks harness.yaml + soul.md + agents/* + groups/*
  // and returns a structured overview. Result is auto-cached as a project
  // memory; cache invalidates if any source file's mtime is newer.
  // ------------------------------------------------------------------------
  const describeMurmurationTool: SpiritTool = {
    name: "describe_murmuration",
    description:
      "Return a structured overview of this murmuration: governance model, agents (with tier + wake schedule + group membership), groups (with members + facilitator), and the murmuration's purpose. Walks the source files on every call — cheap enough to use freely.",
    parameters: z.object({}),
    execute: async () => {
      try {
        const result = await describeMurmuration(rootDir);
        return result.markdown;
      } catch (err) {
        return `describe_murmuration error: ${err instanceof Error ? err.message : String(err)}`;
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
      if (repo !== undefined && !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
        return Promise.resolve(
          `close_issue error: invalid repo "${repo}" — expected owner/repo (alphanumerics + . _ - only).`,
        );
      }
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
    installSkillTool,
    wakeTool,
    directiveTool,
    conveneTool,
    rememberTool,
    forgetTool,
    recallTool,
    describeMurmurationTool,
    reportTool,
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
