#!/usr/bin/env node
/**
 * `murmuration` CLI entry point.
 *
 * Phase 1A: `start` is the only functional command. Every other command
 * prints a helpful error and exits non-zero.
 */

import { bootHelloWorldDaemon } from "./boot.js";

const argv = process.argv.slice(2);
const command = argv[0];

const usage = (): string =>
  `
murmuration — Murmuration Harness CLI

Usage:
  murmuration start       Boot the daemon (Phase 1A: hello-world agent)
  murmuration status      (Phase 1B) Print daemon status
  murmuration stop        (Phase 1B) Send SIGTERM to a running daemon
  murmuration init        (Phase 6) Run /init-murmuration interview

Phase 1A supports only \`start\`. See docs/PHASE-1-PLAN.md.
`.trimStart();

const main = async (): Promise<void> => {
  switch (command) {
    case "start": {
      await bootHelloWorldDaemon();
      break;
    }
    case undefined:
    case "-h":
    case "--help":
    case "help": {
      process.stdout.write(usage());
      break;
    }
    case "--version":
    case "-v":
    case "version": {
      process.stdout.write("murmuration 0.0.0 (phase-1a)\n");
      break;
    }
    case "status":
    case "stop":
    case "init": {
      process.stderr.write(`murmuration: \`${command}\` is not yet implemented in Phase 1A.\n`);
      process.stderr.write(usage());
      process.exit(2);
      break;
    }
    default: {
      process.stderr.write(`murmuration: unknown command \`${command}\`\n\n`);
      process.stderr.write(usage());
      process.exit(2);
    }
  }
};

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`murmuration: fatal: ${message}\n`);
  process.exit(1);
});
