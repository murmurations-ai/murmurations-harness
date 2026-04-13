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

import { runBacklog } from "./backlog.js";
import { bootDaemon } from "./boot.js";
import { runGroupWakeCommand } from "./group-wake.js";
import { runDirective } from "./directive.js";
import { runInit } from "./init.js";

const argv = process.argv.slice(2);
const command = argv[0];

interface StartArgs {
  readonly rootDir: string | undefined;
  readonly agentDir: string | undefined;
  readonly dryRun: boolean;
  readonly once: boolean;
  readonly now: boolean;
  readonly governancePath: string | undefined;
}

const parseStartArgs = (rest: readonly string[]): StartArgs => {
  let rootDir: string | undefined;
  let agentDir: string | undefined;
  let dryRun = false;
  let once = false;
  let now = false;
  let governancePath: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--governance") {
      const next = rest[i + 1];
      if (next === undefined) throw new Error("--governance requires a module path");
      governancePath = next;
      i++;
    } else if (arg === "--root") {
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
    } else if (arg === "--now") {
      now = true;
    } else {
      throw new Error(`unknown argument: ${arg ?? "(undefined)"}`);
    }
  }
  return { rootDir, agentDir, dryRun, once, now, governancePath };
};

const usage = (): string =>
  `
murmuration — Murmuration Harness CLI

Usage:
  murmuration start [options]           Boot the daemon
  murmuration init [dir]                Create a new murmuration (interactive)
  murmuration directive [options] "msg" Send a directive to agents/groups
  murmuration directive --list          Show all directives and responses
  murmuration group-wake [options]     Convene a group meeting (on demand)
  murmuration backlog [options]         View/refresh a group's GitHub work queue
  murmuration status                    (future) Print daemon status
  murmuration stop                      (future) Send SIGTERM to a running daemon

start options:
  --root <path>    Identity root directory (default: bundled hello-world example)
  --agent <id>     Agent dir under <root>/agents/ (default: all agents when
                   --root is set, "hello-world" when --root is omitted)
  --dry-run        Construct every GithubClient without writeScopes so
                   all mutations default-deny at the client layer
  --once           Exit cleanly after the first wake of any agent completes
  --now            Trigger an immediate wake (overrides cron/interval schedule)
  --governance <path>  Path to a governance plugin module (default: no-op).
                   The module must export a GovernancePlugin as default.

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
        ...(args.now ? { now: true, once: true } : {}),
        ...(args.governancePath !== undefined ? { governancePath: args.governancePath } : {}),
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
      const { HARNESS_VERSION } = await import("@murmuration/core");
      process.stdout.write(`murmuration-harness v${HARNESS_VERSION}\n`);
      break;
    }
    case "init": {
      await runInit(argv[1]);
      break;
    }
    case "backlog": {
      const rootIdxB = argv.indexOf("--root");
      const rootDirB = (rootIdxB >= 0 ? argv[rootIdxB + 1] : undefined) ?? ".";
      await runBacklog(argv.slice(1), rootDirB);
      break;
    }
    case "group-wake": {
      const rootIdx2 = argv.indexOf("--root");
      const rootDir2 = (rootIdx2 >= 0 ? argv[rootIdx2 + 1] : undefined) ?? ".";
      await runGroupWakeCommand(argv.slice(1), rootDir2);
      break;
    }
    case "directive": {
      const rootIdx = argv.indexOf("--root");
      const rootDir = (rootIdx >= 0 ? argv[rootIdx + 1] : undefined) ?? ".";
      await runDirective(argv.slice(1), rootDir);
      break;
    }
    case "status":
    case "stop": {
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
