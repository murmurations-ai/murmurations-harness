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

// CF-E (harness#277): scrub credentials from the inherited env before any
// server code runs. The MCP config's `env` field is additive — the parent
// Spirit process env (including provider API keys) leaks in. We only need
// MURMURATION_ROOT to reach the daemon socket; strip the rest.
const CREDENTIAL_PATTERN = /API_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIAL/i;
for (const key of Object.keys(process.env)) {
  if (CREDENTIAL_PATTERN.test(key)) {
    Reflect.deleteProperty(process.env, key);
  }
}

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
