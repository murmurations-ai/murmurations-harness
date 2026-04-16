/**
 * @murmurations-ai/mcp
 *
 * MCP tool loader for the Murmuration Harness. Connects to MCP
 * servers and converts their tools to LLM-compatible ToolDefinition[].
 * See ADR-0020 Phase 3 for rationale.
 */

export { McpToolLoader } from "./tool-loader.js";
export type { McpServerConfig } from "./tool-loader.js";
