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
 * Two callers consume this module:
 *
 * 1. **Spirit interactive REPL** (`./client.ts`) — when the operator
 *    runs `murmuration attach` against a subscription-CLI murmuration.
 * 2. **Daemon-spawned solo wakes** (`../boot.ts`) — when an agent's
 *    role.md (or harness.yaml) pins `provider: subscription-cli`.
 *    Without this wiring, daemon wakes ran text-only and 5 of 6 EP
 *    engineering agents flagged the missing tool surface as a TENSION
 *    (harness#291).
 *
 * Today only claude-cli supports `--mcp-config`. Codex and gemini have
 * MCP support on different surfaces — handled in their respective
 * adapters, not here.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Write Spirit's MCP config under `<rootDir>/.murmuration/spirit-mcp.json`.
 * The CLI subprocess spawns `node <mcp-bin.js>` with `MURMURATION_ROOT`
 * set; the spawned process attaches to the daemon socket and serves
 * Spirit's tools over MCP stdio.
 *
 * Returns the absolute path to the written config so the caller can
 * pass it via `--mcp-config <path>` (claude). Idempotent — overwrites
 * the file each call (the contents are pure functions of `rootDir`).
 */
export const writeSpiritMcpConfig = (rootDir: string): string => {
  const configDir = join(rootDir, ".murmuration");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "spirit-mcp.json");

  const here = dirname(fileURLToPath(import.meta.url));
  const mcpBinPath = join(here, "mcp-bin.js");

  const config = {
    mcpServers: {
      "murmuration-spirit": {
        command: "node",
        args: [mcpBinPath],
        env: { MURMURATION_ROOT: rootDir },
      },
    },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  return configPath;
};
