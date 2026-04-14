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

import { runAttach } from "./attach.js";
import { runBacklog } from "./backlog.js";
import { bootDaemon } from "./boot.js";
import { runGroupWakeCommand } from "./group-wake.js";
import { runDirective } from "./directive.js";
import { runInit } from "./init.js";
import {
  listSessions,
  registerSession,
  resolveSessionRoot,
  unregisterSession,
} from "./sessions.js";

const argv = process.argv.slice(2);
const command = argv[0];

/** Resolve root dir from --root or --name (session registry). */
const resolveRoot = (args: readonly string[], fallback = "."): string => {
  const rootIdx = args.indexOf("--root");
  if (rootIdx >= 0) {
    const val = args[rootIdx + 1];
    return val ?? fallback;
  }
  const nameIdx = args.indexOf("--name");
  if (nameIdx >= 0) {
    const val = args[nameIdx + 1];
    if (val) return resolveSessionRoot(val);
  }
  return fallback;
};

/** Check if a process is still running. */
const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Stop a running daemon. Sends SIGTERM, waits for exit, falls back to SIGKILL. */
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

  if (!isRunning(pid)) {
    console.log(
      `murmuration stop: daemon (PID ${String(pid)}) is not running — cleaning up stale pidfile`,
    );
    try {
      await (await import("node:fs/promises")).unlink(pidfile);
    } catch {
      /* ok */
    }
    return;
  }

  // Send SIGTERM
  try {
    process.kill(pid, "SIGTERM");
    console.log(`murmuration stop: sent SIGTERM to daemon (PID ${String(pid)})`);
  } catch (err: unknown) {
    console.error(
      `murmuration stop: failed to signal PID ${String(pid)} — ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  // Wait for process to exit (up to 10 seconds)
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && isRunning(pid)) {
    await new Promise((r) => setTimeout(r, 250));
  }

  // If still running, SIGKILL
  if (isRunning(pid)) {
    console.log(`murmuration stop: daemon did not exit after 10s — sending SIGKILL`);
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  // Clean up pidfile
  try {
    await (await import("node:fs/promises")).unlink(pidfile);
  } catch {
    /* ok */
  }

  console.log(`murmuration stop: daemon stopped`);
};

/** Show daemon status from pidfile + agent state store. */
const showStatus = async (rootDir: string): Promise<void> => {
  const pidfile = resolve(rootDir, ".murmuration", "daemon.pid");
  const { HARNESS_VERSION } = await import("@murmurations-ai/core");
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
  const { AgentStateStore } = await import("@murmurations-ai/core");
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
  readonly logLevel: "debug" | "info" | "warn" | "error";
}

const parseStartArgs = (rest: readonly string[]): StartArgs => {
  let rootDir: string | undefined;
  let agentDir: string | undefined;
  let dryRun = false;
  let once = false;
  let now = false;
  let governancePath: string | undefined;
  let logLevel: "debug" | "info" | "warn" | "error" = "info";
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--log-level") {
      const next = rest[i + 1];
      if (next !== "debug" && next !== "info" && next !== "warn" && next !== "error") {
        throw new Error("--log-level must be debug, info, warn, or error");
      }
      logLevel = next;
      i++;
    } else if (arg === "--governance") {
      const next = rest[i + 1];
      if (next === undefined) throw new Error("--governance requires a module path");
      governancePath = next;
      i++;
    } else if (arg === "--root") {
      const next = rest[i + 1];
      if (next === undefined) throw new Error("--root requires a value");
      rootDir = next;
      i++;
    } else if (arg === "--name") {
      const next = rest[i + 1];
      if (next === undefined) throw new Error("--name requires a value");
      rootDir = resolveSessionRoot(next);
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
  return { rootDir, agentDir, dryRun, once, now, governancePath, logLevel };
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
  murmuration status [--root|--name]     Show daemon status and agent summary
  murmuration stop [--root|--name]      Stop the running daemon gracefully
  murmuration restart [--root|--name]   Stop and restart (picks up new code)
  murmuration attach <name>              Interactive REPL connected to a running daemon
  murmuration register <name> --root <path>  Register a murmuration by name
  murmuration unregister <name>         Remove a registered murmuration
  murmuration list                      Show all registered murmurations

start options:
  --root <path>    Identity root directory (default: bundled hello-world example)
  --name <name>    Use a registered murmuration name instead of --root
  --agent <id>     Agent dir under <root>/agents/ (default: all agents when
                   --root is set, "hello-world" when --root is omitted)
  --dry-run        Construct every GithubClient without writeScopes so
                   all mutations default-deny at the client layer
  --once           Exit cleanly after the first wake of any agent completes
  --now            Trigger an immediate wake (overrides cron/interval schedule)
  --governance <path>  Path to a governance plugin module (default: no-op).
                   The module must export a GovernancePlugin as default.
  --log-level <level>  Log level: debug, info, warn, error (default: info).
                   Debug shows LLM prompts, signal contents, action details.

Topics:
  murmuration help protocol                                  # show daemon protocol + parity matrix

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
        logLevel: args.logLevel,
      });
      break;
    }
    case undefined:
    case "-h":
    case "--help":
    case "help": {
      const topic = argv[1];
      if (topic === "protocol" || topic === "methods") {
        const { PROTOCOL_METHODS, PROTOCOL_SCHEMA_VERSION } = await import("@murmurations-ai/core");
        process.stdout.write(`Daemon Protocol (schema v${String(PROTOCOL_SCHEMA_VERSION)})\n\n`);
        process.stdout.write(
          "METHOD".padEnd(20) + "MUT  " + "BATCH  REPL   TUI    WEB    SUMMARY\n",
        );
        process.stdout.write("─".repeat(90) + "\n");
        for (const m of PROTOCOL_METHODS) {
          const s = m.surfaces;
          const mark = (v: string): string =>
            v === "shipped" ? "✅" : v === "planned" ? "🟡" : "❌";
          process.stdout.write(
            `${m.name.padEnd(20)}${m.mutating ? "yes" : "no "}  ${mark(s.cliBatch).padEnd(5)}  ${mark(s.cliRepl).padEnd(5)}  ${mark(s.tuiDash).padEnd(5)}  ${mark(s.webDash).padEnd(5)}  ${m.summary}\n`,
          );
        }
      } else {
        process.stdout.write(usage());
      }
      break;
    }
    case "--version":
    case "-v":
    case "version": {
      const { HARNESS_VERSION } = await import("@murmurations-ai/core");
      process.stdout.write(`murmuration-harness v${HARNESS_VERSION}\n`);
      break;
    }
    case "init": {
      await runInit(argv[1]);
      break;
    }
    case "backlog": {
      await runBacklog(argv.slice(1), resolveRoot(argv.slice(1)));
      break;
    }
    case "group-wake": {
      await runGroupWakeCommand(argv.slice(1), resolveRoot(argv.slice(1)));
      break;
    }
    case "directive": {
      await runDirective(argv.slice(1), resolveRoot(argv.slice(1)));
      break;
    }
    case "register": {
      const name = argv[1];
      if (!name || name.startsWith("--")) {
        console.error("murmuration register: <name> is required");
        process.exit(2);
      }
      const regRoot = resolveRoot(argv.slice(2));
      if (regRoot === ".") {
        console.error("murmuration register: --root <path> is required");
        process.exit(2);
      }
      registerSession(name, regRoot);
      break;
    }
    case "unregister": {
      const name = argv[1];
      if (!name || name.startsWith("--")) {
        console.error("murmuration unregister: <name> is required");
        process.exit(2);
      }
      unregisterSession(name);
      break;
    }
    case "list": {
      await listSessions();
      break;
    }
    case "attach": {
      const attachName = argv[1];
      if (!attachName || attachName.startsWith("--")) {
        console.error("murmuration attach: <name> is required (use a registered session name)");
        process.exit(2);
      }
      const attachRoot = resolveSessionRoot(attachName);
      await runAttach(attachRoot, attachName);
      break;
    }
    case "stop": {
      await stopDaemon(resolveRoot(argv.slice(1)));
      break;
    }
    case "restart": {
      const restartRoot = resolveRoot(argv.slice(1));
      await stopDaemon(restartRoot);
      await new Promise((r) => setTimeout(r, 1000));
      const restartArgs = argv.slice(1);
      await bootDaemon({
        ...(restartRoot !== "." ? { rootDir: restartRoot } : {}),
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
      await showStatus(resolveRoot(argv.slice(1)));
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
