/**
 * McpToolLoader — connects to MCP servers via stdio transport,
 * discovers tools, and converts them to ToolDefinition[] for the
 * Vercel AI SDK generateText() tool calling loop.
 *
 * ADR-0020 Phase 3: MCP integration.
 *
 * Key responsibilities:
 * - Spawns MCP server processes via StdioClientTransport
 * - Lists tools from each server
 * - Wraps MCP JSON Schema → Vercel AI SDK jsonSchema()
 * - Wraps callTool() as ToolDefinition.execute()
 * - Cleans up all connections on close()
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { jsonSchema } from "ai";
import type { ToolDefinition } from "@murmurations-ai/llm";

/**
 * Expand `~` (home directory) and `${VAR}` / `$VAR` env-var references in
 * a path string so MCP server commands declared in role.md can be portable
 * across users and platforms. Bare command names (no path separators) are
 * returned unchanged so they continue to resolve via the system PATH —
 * which is the recommended portable form.
 *
 * Examples:
 *   "jdocmunch-mcp"                              → "jdocmunch-mcp"
 *   "~/Code/jmunch-mcp/.venv/bin/jmunch-mcp"     → "/Users/foo/Code/.../jmunch-mcp"
 *   "${HOME}/Code/jmunch-mcp/.venv/bin/...mcp"   → same
 *   "/abs/path/binary"                           → unchanged
 *
 * Live failure case 2026-04-30: agent role.md files baked in
 * `/home/nnishigaya/...` Linux-only paths that ENOENT'd on macOS.
 */
export const expandPath = (raw: string): string => {
  let s = raw;
  if (s.startsWith("~/") || s === "~") {
    s = s === "~" ? homedir() : join(homedir(), s.slice(2));
  }
  // Expand ${VAR} and $VAR_NAME tokens. Unset variables expand to "" so
  // an unintended ${TYPO} produces an obviously-broken path that fails
  // loudly at spawn rather than silently substituting something else.
  s = s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    return process.env[name] ?? "";
  });
  s = s.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => {
    return process.env[name] ?? "";
  });
  return s;
};

const CLIENT_VERSION = ((): string => {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(here, "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
  return pkg.version;
})();

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Configuration for a single MCP server (from agent role.md frontmatter). */
export interface McpServerConfig {
  readonly name: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /** Working directory for the spawned process. */
  readonly cwd?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract text from MCP callTool result.content (typed as unknown). @internal */
export const extractTextContent = (raw: unknown): string => {
  if (!Array.isArray(raw)) return JSON.stringify(raw);
  const items = raw as readonly Record<string, unknown>[];
  const texts: string[] = [];
  for (const c of items) {
    if (c.type === "text" && typeof c.text === "string") {
      texts.push(c.text);
    }
  }
  return texts.length > 0 ? texts.join("\n") : JSON.stringify(raw);
};

// ---------------------------------------------------------------------------
// McpToolLoader
// ---------------------------------------------------------------------------

export class McpToolLoader {
  readonly #clients = new Map<string, { client: Client; transport: StdioClientTransport }>();

  /**
   * Connect to the listed MCP servers, discover their tools, and return
   * a flat array of ToolDefinition objects ready for generateText().
   *
   * Each tool name is prefixed with the server name to avoid collisions
   * (e.g. "filesystem__read_file").
   */
  async loadTools(
    servers: readonly McpServerConfig[],
    parentEnv?: Readonly<Record<string, string>>,
  ): Promise<ToolDefinition[]> {
    const allTools: ToolDefinition[] = [];

    for (const server of servers) {
      const { client, transport } = await this.#connect(server, parentEnv);
      const { tools } = await client.listTools();

      for (const mcpTool of tools) {
        const toolName = `${server.name}__${mcpTool.name}`;
        const boundClient = client;

        allTools.push({
          name: toolName,
          description: mcpTool.description ?? "",
          parameters: jsonSchema(mcpTool.inputSchema),
          execute: async (input: Record<string, unknown>): Promise<unknown> => {
            const result = await boundClient.callTool({
              name: mcpTool.name,
              arguments: input,
            });
            // Extract text content; fall back to JSON for non-text responses
            return extractTextContent(result.content);
          },
        });
      }

      this.#clients.set(server.name, { client, transport });
    }

    return allTools;
  }

  /** Disconnect all MCP clients and kill spawned processes. */
  async close(): Promise<void> {
    const closeTasks = [...this.#clients.values()].map(async ({ client, transport }) => {
      try {
        await client.close();
      } catch {
        // Best-effort — process may already be dead
      }
      try {
        await transport.close();
      } catch {
        // Best-effort
      }
    });
    await Promise.allSettled(closeTasks);
    this.#clients.clear();
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  async #connect(
    server: McpServerConfig,
    parentEnv?: Readonly<Record<string, string>>,
  ): Promise<{ client: Client; transport: StdioClientTransport }> {
    // Merge parent environment (resolved secrets) with server-specific env.
    // Server env wins on conflict.
    const env: Record<string, string> = {
      ...(parentEnv ?? {}),
      ...(server.env ?? {}),
    };

    // Expand `~` and `${VAR}` in the command, args, and cwd so role.md
    // can declare portable paths that resolve against the operator's
    // current shell environment instead of baking in absolute paths
    // tied to one developer's home directory or OS.
    const expandedCommand = expandPath(server.command);
    const expandedArgs = (server.args ?? []).map(expandPath);
    const expandedCwd = server.cwd !== undefined ? expandPath(server.cwd) : undefined;
    const transport = new StdioClientTransport({
      command: expandedCommand,
      args: [...expandedArgs],
      env,
      ...(expandedCwd !== undefined ? { cwd: expandedCwd } : {}),
      stderr: "pipe", // Don't pollute daemon stderr
    });

    const client = new Client({
      name: "murmurations-harness",
      version: CLIENT_VERSION,
    });

    await client.connect(transport);
    return { client, transport };
  }
}
