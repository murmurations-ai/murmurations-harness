#!/usr/bin/env node
/**
 * `murmuration` CLI entry point.
 *
 * Phase 1A shipped only `start` and it was hardcoded to the hello-world
 * example. Phase 2D3 extends `start` with:
 *
 *   --root <path>   identity root directory (defaults to the bundled
 *                   hello-world example)
 *   --agent <id>    agent directory under <root>/agents/ (defaults to
 *                   "hello-world")
 *   --dry-run       construct every per-agent GithubClient WITHOUT
 *                   writeScopes, so mutations default-deny at the
 *                   client layer per ADR-0017 §4 (Phase 2C6 gate)
 */

import { bootDaemon } from "./boot.js";

const argv = process.argv.slice(2);
const command = argv[0];

interface StartArgs {
  readonly rootDir: string | undefined;
  readonly agentDir: string | undefined;
  readonly dryRun: boolean;
  readonly once: boolean;
}

const parseStartArgs = (rest: readonly string[]): StartArgs => {
  let rootDir: string | undefined;
  let agentDir: string | undefined;
  let dryRun = false;
  let once = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--root") {
      const next = rest[i + 1];
      if (next === undefined) throw new Error("--root requires a value");
      rootDir = next;
      i++;
    } else if (arg === "--agent") {
      const next = rest[i + 1];
      if (next === undefined) throw new Error("--agent requires a value");
      agentDir = next;
      i++;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--once") {
      once = true;
    } else {
      throw new Error(`unknown argument: ${arg ?? "(undefined)"}`);
    }
  }
  return { rootDir, agentDir, dryRun, once };
};

const usage = (): string =>
  `
murmuration — Murmuration Harness CLI

Usage:
  murmuration start [options]   Boot the daemon (Phase 2D)
  murmuration status            (Phase 1B) Print daemon status
  murmuration stop              (Phase 1B) Send SIGTERM to a running daemon
  murmuration init              (Phase 6) Run /init-murmuration interview

start options:
  --root <path>    Identity root directory (default: bundled hello-world example)
  --agent <id>     Agent dir under <root>/agents/ (default: all agents when
                   --root is set, "hello-world" when --root is omitted)
  --dry-run        Construct every GithubClient without writeScopes so
                   all mutations default-deny at the client layer
  --once           Exit cleanly after the first wake of any agent completes

Examples:
  murmuration start                                          # hello-world only
  murmuration start --root ../my-murmuration                 # all agents
  murmuration start --root ../my-murmuration --agent my-bot  # one agent
  murmuration start --root ../my-murmuration --dry-run       # all, no writes
`.trimStart();

const main = async (): Promise<void> => {
  switch (command) {
    case "start": {
      const args = parseStartArgs(argv.slice(1));
      await bootDaemon({
        ...(args.rootDir !== undefined ? { rootDir: args.rootDir } : {}),
        ...(args.agentDir !== undefined ? { agentDir: args.agentDir } : {}),
        ...(args.dryRun ? { dryRun: true } : {}),
        ...(args.once ? { once: true } : {}),
      });
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
      process.stdout.write("murmuration 0.0.0 (phase-2d)\n");
      break;
    }
    case "status":
    case "stop":
    case "init": {
      process.stderr.write(`murmuration: \`${command}\` is not yet implemented.\n`);
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
