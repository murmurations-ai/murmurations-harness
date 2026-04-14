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

/** List all registered murmurations with status. */
export const listSessions = async (): Promise<void> => {
  const registry = loadRegistry();
  const names = Object.keys(registry);
  if (names.length === 0) {
    console.log(
      "No murmurations registered. Use `murmuration register <name> --root <path>` to add one.",
    );
    return;
  }

  const { HARNESS_VERSION, AgentStateStore } = await import("@murmurations-ai/core");

  console.log("murmuration-harness v" + HARNESS_VERSION + "\n");
  console.log("NAME".padEnd(15) + " " + "STATUS".padEnd(22) + " " + "AGENTS".padEnd(8) + " ROOT");
  console.log("─".repeat(70));

  for (const name of names.sort()) {
    const entry = registry[name];
    if (!entry) continue;
    const root = entry.root;

    // Check daemon status — heartbeat is authoritative, pidfile is fallback
    let status = "stopped";
    const heartbeatAge = entry.lastHeartbeatAt
      ? Date.now() - new Date(entry.lastHeartbeatAt).getTime()
      : Infinity;
    const heartbeatFresh = heartbeatAge < 120_000; // 2 minutes (heartbeat is 60s)

    if (entry.pid && heartbeatFresh) {
      try {
        process.kill(entry.pid, 0);
        status = `running (PID ${String(entry.pid)})`;
      } catch {
        status = "stopped (stale heartbeat)";
      }
    } else {
      // Fallback to pidfile
      const pidfile = join(root, ".murmuration", "daemon.pid");
      if (existsSync(pidfile)) {
        const pid = parseInt(readFileSync(pidfile, "utf8").trim(), 10);
        try {
          process.kill(pid, 0);
          status = `running (PID ${String(pid)})`;
        } catch {
          status = "stopped (stale pid)";
        }
      }
    }

    // Count agents
    let agentCount: string;
    try {
      const store = new AgentStateStore({
        persistDir: join(root, ".murmuration", "agents"),
      });
      const loaded = await store.load();
      agentCount = loaded > 0 ? String(store.getAllAgents().length) : "0";
    } catch {
      agentCount = "?";
    }

    console.log(`${name.padEnd(15)} ${status.padEnd(22)} ${agentCount.padEnd(8)} ${root}`);
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

/** Resolve --name to --root from the session registry. */
export const resolveSessionRoot = (name: string): string => {
  const registry = loadRegistry();
  const entry = registry[name];
  if (!entry) {
    console.error(
      `murmuration: unknown session "${name}". Run \`murmuration list\` to see registered sessions.`,
    );
    process.exit(1);
  }
  return entry.root;
};
