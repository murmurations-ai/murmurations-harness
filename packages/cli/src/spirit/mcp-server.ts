/**
 * Spirit MCP server — exposes Spirit's 9 harness-internal tools as an
 * MCP server over stdio so subscription-CLI sessions (claude/codex/gemini)
 * can call them.
 *
 * Why this exists:
 *
 * Subscription-CLI providers route through the operator's local AI CLI
 * (claude/codex/gemini), each of which runs its own tool loop with its
 * own tool surface. They cannot honor the harness-defined ToolDefinition
 * objects we pass via Vercel SDK to the API path. But all three CLIs
 * support MCP — so we re-host the same Spirit tools (status, agents,
 * groups, events, read_file, list_dir, load_skill, wake, directive)
 * as an MCP server and configure the subscription CLI to load it.
 *
 * Lifecycle: Spirit spawns this module as a Node subprocess (separate
 * from the subscription CLI subprocess) and writes an MCP config file
 * pointing the CLI at it. The MCP server runs forever until its parent
 * (Spirit, via signals) terminates it. Each tool call opens a fresh
 * daemon-socket RPC; we don't share a long-lived socket because daemon
 * RPC is short-call by design.
 *
 * Tool implementations are reused verbatim from `./tools.ts` — same
 * code path, same path-safety rules, same daemon-RPC contract. The
 * MCP server is a transport adapter, not a logic re-implementation.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { daemonRpc } from "../daemon-client.js";

import { buildSpiritTools } from "./tools.js";

interface SocketResponse {
  readonly id: string;
  readonly result?: unknown;
  readonly error?: string;
}

/**
 * Build a daemon-RPC `send` adapter for the MCP server. Each call opens
 * a fresh socket connection; we don't pool because the existing
 * `daemonRpc` helper is single-shot by design (5s timeout, destroy on
 * settle). Errors are normalized to the SocketResponse shape that
 * `tools.ts` already handles.
 */
const buildMcpSend = (
  rootDir: string,
): ((method: string, params?: Record<string, unknown>) => Promise<SocketResponse>) => {
  let counter = 0;
  return async (method, params) => {
    counter += 1;
    const id = `mcp-${String(counter)}`;
    try {
      const result = await daemonRpc(rootDir, method, params);
      return { id, result };
    } catch (err) {
      return { id, error: err instanceof Error ? err.message : String(err) };
    }
  };
};

/**
 * Run the Spirit MCP server, hosting all tools from `buildSpiritTools`
 * as MCP-callable tools over stdio. Returns a promise that resolves
 * when the transport closes (parent kills the subprocess).
 */
export const runSpiritMcpServer = async (config: { readonly rootDir: string }): Promise<void> => {
  const send = buildMcpSend(config.rootDir);
  const tools = buildSpiritTools({ rootDir: config.rootDir, send });

  const server = new McpServer(
    { name: "spirit", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  for (const tool of tools) {
    // `buildSpiritTools()` returns `readonly SpiritTool[]` (CF-D, harness#283),
    // where `parameters` is statically typed `z.ZodObject<z.ZodRawShape>`.
    // The MCP SDK's registerTool wants the raw shape; we read it directly.
    // Non-object schemas are a compile error at the tool definition site.
    const shape = tool.parameters.shape;

    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: shape,
      },
      async (input: unknown): Promise<{ content: { type: "text"; text: string }[] }> => {
        const result = await tool.execute(input as Record<string, unknown>);
        const text = typeof result === "string" ? result : JSON.stringify(result);
        return { content: [{ type: "text", text }] };
      },
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // The transport runs until the parent closes stdin; we keep this
  // promise pending until then so the caller can `await` cleanup.
  await new Promise<void>((resolve) => {
    transport.onclose = (): void => resolve();
  });
};
