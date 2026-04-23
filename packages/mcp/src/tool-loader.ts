import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { jsonSchema } from "ai";
import type { ToolDefinition } from "@murmurations-ai/llm";

export interface McpServerConfig {
  readonly name: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

export const extractTextContent = (raw: unknown): string => {
  if (typeof raw !== "object" || raw === null) return JSON.stringify(raw);
  const r = raw as { content?: { type?: string; text?: string }[] };
  if (!Array.isArray(r.content)) return JSON.stringify(raw);
  const textBlocks = r.content.filter((c) => c.type === "text").map((c) => c.text ?? "");
  return textBlocks.join("\n");
};

export class McpToolLoader {
  readonly #clients = new Map<string, { client: Client; transport: StdioClientTransport }>();

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
            return extractTextContent(result);
          },
        });
      }
      this.#clients.set(server.name, { client, transport });
    }
    return allTools;
  }

  async close(): Promise<void> {
    const closeTasks = [...this.#clients.values()].map(async ({ client, transport }) => {
      try {
        await client.close();
      } catch {
        // Best-effort
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

  async #connect(
    server: McpServerConfig,
    parentEnv?: Readonly<Record<string, string>>,
  ): Promise<{ client: Client; transport: StdioClientTransport }> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    Object.assign(env, parentEnv ?? {});

    // Evaluate shell-variable syntax in server.env
    if (server.env) {
      for (const [k, v] of Object.entries(server.env)) {
        if (v.startsWith("$")) {
          const varName = v.substring(1);
          if (parentEnv && parentEnv[varName] !== undefined) {
            env[k] = parentEnv[varName];
          } else if (process.env[varName] !== undefined) {
            env[k] = process.env[varName];
          } else {
            env[k] = v;
          }
        } else {
          env[k] = v;
        }
      }
    }

    // Hardcode fallback for @modelcontextprotocol/server-github
    if (env["GITHUB_TOKEN"] && !env["GITHUB_PERSONAL_ACCESS_TOKEN"]) {
      env["GITHUB_PERSONAL_ACCESS_TOKEN"] = env["GITHUB_TOKEN"];
    }

    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args ? [...server.args] : [],
      env,
      ...(server.cwd ? { cwd: server.cwd } : {}),
      stderr: "pipe",
    });

    const client = new Client({
      name: "murmurations-harness",
      version: "0.4.3",
    });

    await client.connect(transport);
    return { client, transport };
  }
}
