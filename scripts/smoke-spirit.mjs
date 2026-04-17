#!/usr/bin/env node
/**
 * Spirit smoke test — connects to a running daemon via the Unix socket,
 * initializes a Spirit session, fires one or more turns, and prints the
 * result. Bypasses the REPL's readline so we can drive it from a pipe.
 *
 * Usage:
 *   node scripts/smoke-spirit.mjs <root-dir> <question>
 */

import { createConnection } from "node:net";
import { resolve, join } from "node:path";

import { initSpiritSession } from "../packages/cli/dist/spirit/index.js";

const [, , rootArg, ...questionParts] = process.argv;
const question = questionParts.join(" ");
if (!rootArg || !question) {
  console.error("usage: node scripts/smoke-spirit.mjs <root-dir> <question>");
  process.exit(2);
}

const rootDir = resolve(rootArg);
const socketPath = join(rootDir, ".murmuration", "daemon.sock");
const conn = createConnection(socketPath);

let requestId = 0;
const pending = new Map();

let buffer = "";
conn.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if ("id" in msg && pending.has(msg.id)) {
        const cb = pending.get(msg.id);
        pending.delete(msg.id);
        cb(msg);
      }
    } catch {
      /* event or malformed — skip */
    }
  }
});

const send = (method, params) =>
  new Promise((res) => {
    const id = String(++requestId);
    pending.set(id, res);
    conn.write(JSON.stringify({ id, method, ...(params ? { params } : {}) }) + "\n");
  });

await new Promise((r) => conn.once("connect", r));

try {
  console.log(`[smoke] initializing Spirit against ${rootDir}`);
  const spirit = await initSpiritSession({ rootDir, send });
  console.log(`[smoke] provider=${spirit.provider} model=${spirit.model}`);
  console.log(`[smoke] turn: ${JSON.stringify(question)}\n`);

  const result = await spirit.turn(question);
  console.log("---RESPONSE---");
  console.log(result.content);
  console.log("---META---");
  console.log(
    `tokens: ${result.inputTokens} in / ${result.outputTokens} out, ${result.toolCallCount} tool calls, ~$${result.estimatedCostUsd.toFixed(4)}`,
  );
} catch (err) {
  console.error(`[smoke] failed: ${err?.message ?? err}`);
  process.exit(1);
} finally {
  conn.destroy();
}
