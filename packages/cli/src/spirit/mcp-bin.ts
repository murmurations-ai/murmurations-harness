#!/usr/bin/env node
/**
 * Spirit MCP server bin entry — spawned as a subprocess by the
 * subscription CLI (claude/codex/gemini) when Spirit attaches to a
 * murmuration that uses subscription-cli.
 *
 * Reads `MURMURATION_ROOT` from env (set by Spirit at spawn time) and
 * starts the MCP server bound to that murmuration's daemon socket.
 *
 * Stdio is the MCP transport (JSON-RPC framed lines on stdin/stdout),
 * so this entry must NEVER write debug logs to stdout — only stderr.
 */

import { runSpiritMcpServer } from "./mcp-server.js";

const main = async (): Promise<void> => {
  const rootDir = process.env.MURMURATION_ROOT;
  if (!rootDir) {
    process.stderr.write(
      "spirit-mcp: MURMURATION_ROOT env var is required (parent Spirit didn't set it)\n",
    );
    process.exit(2);
  }
  try {
    await runSpiritMcpServer({ rootDir });
  } catch (err) {
    process.stderr.write(
      `spirit-mcp: server crashed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
};

void main();
