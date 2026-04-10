#!/usr/bin/env node
/**
 * `murmuration dashboard` entry point.
 *
 * Usage:
 *   murmuration-dashboard --root ../my-murmuration
 *   murmuration-dashboard               # defaults to cwd
 */

import { startDashboard } from "./dashboard.js";

const args = process.argv.slice(2);
let rootDir = ".";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--root") {
    rootDir = args[i + 1] ?? ".";
    i++;
  }
}

startDashboard(rootDir).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`murmuration-dashboard: fatal: ${message}\n`);
  process.exit(1);
});
