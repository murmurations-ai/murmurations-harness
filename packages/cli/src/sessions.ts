/**
 * Session registry — tracks multiple murmurations by name.
 *
 * Stores at ~/.murmuration/sessions.json. Each entry maps a short name
 * to an absolute root path. All CLI commands accept `--name <name>`
 * as an alias for `--root <path>`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";

import { findRunningSessionByName, listRunningSessionNamesSync } from "./running-sessions.js";

interface SessionEntry {
  readonly root: string;
  readonly registered: string; // ISO date
  lastHeartbeatAt?: string; // ISO datetime — updated by running daemon
  pid?: number;
}

type SessionRegistry = Record<string, SessionEntry>;

const REGISTRY_DIR = join(homedir(), ".murmuration");
const REGISTRY_PATH = join(REGISTRY_DIR, "sessions.json");

const loadRegistry = (): SessionRegistry => {
  if (!existsSync(REGISTRY_PATH)) return {};
  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as SessionRegistry;
  } catch {
    return {};
  }
};

const saveRegistry = (registry: SessionRegistry): void => {
  mkdirSync(REGISTRY_DIR, { recursive: true });
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n", "utf8");
};

/** Register a murmuration by name. */
export const registerSession = (name: string, rootDir: string): void => {
  const registry = loadRegistry();
  const absRoot = resolve(rootDir);
  if (!existsSync(absRoot)) {
    console.error(`murmuration register: path does not exist: ${absRoot}`);
    process.exit(1);
  }
  registry[name] = { root: absRoot, registered: new Date().toISOString().slice(0, 10) };
  saveRegistry(registry);
  console.log(`Registered "${name}" → ${absRoot}`);
};

/** Unregister a murmuration by name. */
export const unregisterSession = (name: string): void => {
  const registry = loadRegistry();
  if (!(name in registry)) {
    console.error(`murmuration unregister: "${name}" is not registered`);
    process.exit(1);
  }
  const entry = registry[name];
  const { [name]: _, ...rest } = registry;
  saveRegistry(rest);
  console.log(`Unregistered "${name}" (was ${entry?.root ?? "unknown"})`);
};

/**
 * List running murmurations (v0.5.0 Milestone 4.8 — tmux-style).
 *
 * Source of truth: `~/.murmuration/sockets/*.sock` symlinks pointing
 * at each daemon's live control socket. Stopped murmurations are not
 * shown — they're noise. Stale symlinks (daemon crashed without
 * cleanup) are pruned as a side effect of listing.
 *
 * sessions.json remains the `--name` → `--root` mapping for CLI
 * shortcuts; it's consulted as a fallback for names not in the
 * sockets dir (rare).
 */
export const listSessions = async (): Promise<void> => {
  const { listRunningSessions } = await import("./running-sessions.js");
  const { HARNESS_VERSION, AgentStateStore } = await import("@murmurations-ai/core");

  const running = await listRunningSessions();
  console.log("murmuration-harness v" + HARNESS_VERSION + "\n");

  if (running.length === 0) {
    console.log(
      "No running murmurations.\n\n" +
        "  Start one with:   murmuration start --root <path>\n" +
        "  Or from scratch:  murmuration init --example hello my-first-murm",
    );
    return;
  }

  console.log("NAME".padEnd(20) + " " + "STATUS".padEnd(20) + " " + "AGENTS".padEnd(8) + " ROOT");
  console.log("─".repeat(80));

  for (const session of running) {
    const status = session.pid !== undefined ? `running (PID ${String(session.pid)})` : "running";

    let agentCount: string;
    try {
      const store = new AgentStateStore({
        persistDir: join(session.root, ".murmuration", "agents"),
      });
      const loaded = await store.load();
      agentCount = loaded > 0 ? String(store.getAllAgents().length) : "0";
    } catch {
      agentCount = "?";
    }

    console.log(
      `${session.name.padEnd(20)} ${status.padEnd(20)} ${agentCount.padEnd(8)} ${session.root}`,
    );
  }
};

/** Update heartbeat for a running daemon. Called periodically by the daemon. */
export const heartbeatSession = (rootDir: string): void => {
  const registry = loadRegistry();
  const absRoot = resolve(rootDir);
  // Find entry by root path
  for (const [name, entry] of Object.entries(registry)) {
    if (entry.root === absRoot) {
      registry[name] = { ...entry, lastHeartbeatAt: new Date().toISOString(), pid: process.pid };
      saveRegistry(registry);
      return;
    }
  }
};

/**
 * Resolve --name to --root. Two sources, in order:
 *   1. Running-sessions registry (~/.murmuration/sockets/) — tmux-style
 *      live symlinks. Always right when present; works from any
 *      directory without prior `register` or `init`.
 *   2. sessions.json — registered names (useful when the daemon is
 *      stopped but the operator wants to start it by name).
 *
 * v0.5.0 Milestone 4.8 tester feedback: `murmuration attach <name>`
 * should work whenever a daemon is running, regardless of whether
 * anyone registered it first.
 */
export const resolveSessionRoot = (name: string): string => {
  const root = tryResolveSessionRoot(name);
  if (root !== null) return root;

  const available = listRunningSessionNamesSync();
  const registered = Object.keys(loadRegistry()).sort();
  const allNames = [...new Set([...available, ...registered])].sort();
  const hint =
    allNames.length > 0
      ? `Known sessions: ${allNames.join(", ")}.`
      : `No running or registered sessions found. Start one with \`murmuration start --root <path>\`.`;
  console.error(`murmuration: unknown session "${name}". ${hint}`);
  process.exit(1);
};

/**
 * Non-exiting variant for callers (like the REPL) that want to handle
 * the "no such session" case themselves. Returns the root for any
 * known session (running OR registered), null if neither.
 */
export const tryResolveSessionRoot = (name: string): string | null => {
  const hit = findRunningSessionByName(name);
  if (hit) return hit.root;
  const entry = loadRegistry()[name];
  if (entry) return entry.root;
  return null;
};
