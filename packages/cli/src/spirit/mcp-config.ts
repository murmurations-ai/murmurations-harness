/**
 * Spirit MCP config writer — produces the JSON file that subscription-CLI
 * subprocesses load (via `--mcp-config <path>` for claude) so they can
 * call harness-internal tools (status, agents, wake, directive, etc.)
 * over MCP stdio.
 *
 * The config points each spawned CLI subprocess at `mcp-bin.js`, which
 * runs the Spirit MCP server (`runSpiritMcpServer`) and attaches to the
 * daemon socket via `MURMURATION_ROOT`. Tool implementations are reused
 * verbatim from `./tools.ts` — same daemon-RPC contract, no logic
 * duplication.
 *
 * Three callers consume this module:
 *
 * 1. **Spirit interactive REPL** (`./client.ts`) — when the operator
 *    runs `murmuration attach` against a subscription-CLI murmuration.
 * 2. **Daemon-spawned solo wakes** (`../boot.ts`) — when an agent's
 *    role.md (or harness.yaml) pins `provider: subscription-cli`.
 *    Without this wiring, daemon wakes ran text-only and 5 of 6 EP
 *    engineering agents flagged the missing tool surface as a TENSION
 *    (harness#291).
 * 3. **Per-agent wakes with role.md `tools.mcp`** (`../boot.ts`) — agents
 *    that declare external MCP servers (e.g. jcodemunch-mcp, jdocmunch-mcp)
 *    get a merged config that includes both the Spirit bridge and their
 *    declared servers (harness#355).
 *
 * Today only claude-cli supports `--mcp-config`. Codex and gemini have
 * MCP support on different surfaces — handled in their respective
 * adapters, not here.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Minimal shape of an agent-declared MCP server from role.md `tools.mcp`. */
export interface AgentMcpServer {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

/** Build the Spirit bridge server entry (shared between all callers). */
const spiritBridgeEntry = (rootDir: string) => {
  const here = dirname(fileURLToPath(import.meta.url));
  const mcpBinPath = join(here, "mcp-bin.js");
  return {
    command: "node",
    args: [mcpBinPath],
    env: { MURMURATION_ROOT: rootDir },
  };
};

/**
 * Write Spirit's MCP config under `<rootDir>/.murmuration/spirit-mcp.json`.
 * Contains only the harness-internal Spirit bridge server.
 *
 * Returns the absolute path. Idempotent — overwrites each call.
 */
export const writeSpiritMcpConfig = (rootDir: string): string => {
  const configDir = join(rootDir, ".murmuration");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "spirit-mcp.json");
  const config = {
    mcpServers: { "murmuration-spirit": spiritBridgeEntry(rootDir) },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  return configPath;
};

/**
 * Write a per-agent MCP config under
 * `<rootDir>/.murmuration/agent-mcp-<agentId>.json`.
 *
 * Merges the Spirit bridge server with any MCP servers declared in the
 * agent's role.md `tools.mcp` block (harness#355). When `extraServers` is
 * empty the result is identical to `writeSpiritMcpConfig` but written to a
 * separate file so agent and Spirit configs don't stomp each other.
 *
 * Returns the absolute path. Idempotent — overwrites each call.
 */
export const writeAgentMcpConfig = (
  rootDir: string,
  agentId: string,
  extraServers: readonly AgentMcpServer[],
): string => {
  const configDir = join(rootDir, ".murmuration");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, `agent-mcp-${agentId}.json`);

  const mcpServers: Record<string, object> = {
    "murmuration-spirit": spiritBridgeEntry(rootDir),
  };
  for (const s of extraServers) {
    mcpServers[s.name] = {
      command: s.command,
      args: s.args,
      ...(s.env !== undefined ? { env: s.env } : {}),
      ...(s.cwd !== undefined ? { cwd: s.cwd } : {}),
    };
  }

  writeFileSync(configPath, JSON.stringify({ mcpServers }, null, 2), "utf8");
  return configPath;
};
