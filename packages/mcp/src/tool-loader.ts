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

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { jsonSchema } from "ai";
import type { ToolDefinition } from "@murmurations-ai/llm";

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

    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args ? [...server.args] : [],
      env,
      ...(server.cwd ? { cwd: server.cwd } : {}),
      stderr: "pipe", // Don't pollute daemon stderr
    });

    const client = new Client({
      name: "murmurations-harness",
      version: "0.3.7",
    });

    await client.connect(transport);
    return { client, transport };
  }
}
