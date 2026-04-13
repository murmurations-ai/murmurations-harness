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

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { runBacklog } from "./backlog.js";
import { bootDaemon } from "./boot.js";
import { runGroupWakeCommand } from "./group-wake.js";
import { runDirective } from "./directive.js";
import { runInit } from "./init.js";

const argv = process.argv.slice(2);
const command = argv[0];

/** Stop a running daemon by reading its pidfile and sending SIGTERM. */
const stopDaemon = async (rootDir: string): Promise<void> => {
  const pidfile = resolve(rootDir, ".murmuration", "daemon.pid");
  if (!existsSync(pidfile)) {
    console.error(
      "murmuration stop: no running daemon found (no pidfile at .murmuration/daemon.pid)",
    );
    process.exit(1);
  }
  const pid = parseInt(readFileSync(pidfile, "utf8").trim(), 10);
  if (isNaN(pid)) {
    console.error("murmuration stop: invalid pidfile content");
    process.exit(1);
  }
  try {
    process.kill(pid, "SIGTERM");
    console.log(`murmuration stop: sent SIGTERM to daemon (PID ${String(pid)})`);
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === "ESRCH") {
      console.log(
        `murmuration stop: daemon (PID ${String(pid)}) is not running — cleaning up stale pidfile`,
      );
      try {
        await (await import("node:fs/promises")).unlink(pidfile);
      } catch {
        /* ok */
      }
    } else {
      console.error(
        `murmuration stop: failed to send SIGTERM to PID ${String(pid)} — ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  }
};

/** Show daemon status from pidfile + agent state store. */
const showStatus = async (rootDir: string): Promise<void> => {
  const pidfile = resolve(rootDir, ".murmuration", "daemon.pid");
  const { HARNESS_VERSION } = await import("@murmuration/core");
  console.log(`murmuration-harness v${HARNESS_VERSION}`);

  if (!existsSync(pidfile)) {
    console.log("Daemon: not running");
    return;
  }
  const pid = parseInt(readFileSync(pidfile, "utf8").trim(), 10);
  let running = false;
  try {
    process.kill(pid, 0); // signal 0 = check if process exists
    running = true;
  } catch {
    /* not running */
  }
  console.log(
    `Daemon: ${running ? `running (PID ${String(pid)})` : "not running (stale pidfile)"}`,
  );

  // Show agent summary from state store
  const { AgentStateStore } = await import("@murmuration/core");
  const store = new AgentStateStore({ persistDir: resolve(rootDir, ".murmuration", "agents") });
  const loaded = await store.load();
  if (loaded > 0) {
    const agents = store.getAllAgents();
    console.log(`Agents: ${String(agents.length)} registered`);
    for (const a of agents) {
      const idle =
        a.totalWakes > 0
          ? `${String(Math.round((a.idleWakes / a.totalWakes) * 100))}% idle`
          : "no wakes";
      console.log(
        `  ${a.agentId.padEnd(25)} ${a.currentState.padEnd(12)} ${String(a.totalWakes).padStart(3)} wakes  ${String(a.totalArtifacts).padStart(3)} artifacts  ${idle}`,
      );
    }
  }
};

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
  murmuration status [--root <path>]     Show daemon status and agent summary
  murmuration stop [--root <path>]      Stop the running daemon gracefully
  murmuration restart [--root <path>]   Stop and restart the daemon (picks up new code)

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
    case "stop": {
      const rootIdx3 = argv.indexOf("--root");
      const rootDir3 = (rootIdx3 >= 0 ? argv[rootIdx3 + 1] : undefined) ?? ".";
      await stopDaemon(rootDir3);
      break;
    }
    case "restart": {
      const rootIdx4 = argv.indexOf("--root");
      const rootDir4 = (rootIdx4 >= 0 ? argv[rootIdx4 + 1] : undefined) ?? ".";
      await stopDaemon(rootDir4);
      // Small delay to let the daemon finish cleanup
      await new Promise((r) => setTimeout(r, 1000));
      // Re-exec start with the original args (minus "restart" → "start")
      const restartArgs = argv.slice(1);
      await bootDaemon({
        ...(rootDir4 !== "." ? { rootDir: rootDir4 } : {}),
        ...(restartArgs.includes("--agent")
          ? { agentDir: restartArgs[restartArgs.indexOf("--agent") + 1] }
          : {}),
        ...(restartArgs.includes("--dry-run") ? { dryRun: true } : {}),
        ...(restartArgs.includes("--governance")
          ? { governancePath: restartArgs[restartArgs.indexOf("--governance") + 1] }
          : {}),
      });
      break;
    }
    case "status": {
      const rootIdx5 = argv.indexOf("--root");
      const rootDir5 = (rootIdx5 >= 0 ? argv[rootIdx5 + 1] : undefined) ?? ".";
      await showStatus(rootDir5);
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
