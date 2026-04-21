/**
 * Running-sessions registry — tmux-style socket directory.
 *
 * v0.5.0 Milestone 4.8. Every live daemon drops a symlink from
 * `~/.murmuration/sockets/<name>.sock` to the per-root
 * `<root>/.murmuration/daemon.sock`. Listing that directory gives
 * every running murmuration for free, without touching sessions.json.
 *
 * This complements (doesn't replace) `~/.murmuration/sessions.json`:
 *   - sessions.json is the name → root mapping for the `--name` flag.
 *   - sockets/ is the live list of running murmurations.
 *
 * A stopped murmuration stays in sessions.json (so `--name foo` still
 * works to scaffold a command) but is absent from sockets/ (so
 * `murmuration list` shows only what's actually alive).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const SOCKETS_DIR = join(homedir(), ".murmuration", "sockets");

const ensureDir = (): void => {
  if (!existsSync(SOCKETS_DIR)) {
    mkdirSync(SOCKETS_DIR, { recursive: true });
  }
};

/**
 * Symlink the per-root daemon socket into the shared sockets dir so
 * `murmuration list` can find it. Called by the daemon once the
 * socket is bound. Safe to call when an entry with the same name
 * already exists — older symlinks are replaced.
 */
export const registerRunningSocket = (name: string, socketPath: string): void => {
  ensureDir();
  const linkPath = join(SOCKETS_DIR, `${name}.sock`);
  try {
    if (existsSync(linkPath) || isBrokenSymlink(linkPath)) {
      unlinkSync(linkPath);
    }
    symlinkSync(resolve(socketPath), linkPath);
  } catch {
    // Registration is best-effort — the daemon is what matters; the
    // socket dir is UI sugar. Never block startup on this.
  }
};

/** Remove a daemon's entry from the sockets dir. Called on clean shutdown. */
export const unregisterRunningSocket = (name: string): void => {
  const linkPath = join(SOCKETS_DIR, `${name}.sock`);
  try {
    if (existsSync(linkPath) || isBrokenSymlink(linkPath)) {
      unlinkSync(linkPath);
    }
  } catch {
    /* best-effort */
  }
};

/** One entry in the live running-sessions list. */
export interface RunningSession {
  readonly name: string;
  /** Absolute path the symlink resolves to. */
  readonly socketPath: string;
  /** The murmuration root (parent of .murmuration/). */
  readonly root: string;
  /** PID from <root>/.murmuration/daemon.pid, or undefined. */
  readonly pid: number | undefined;
  /** True when the PID responds to signal 0 (process is alive). */
  readonly running: boolean;
}

/**
 * Scan the sockets directory, prune stale entries (symlinks whose
 * PID no longer responds), and return the live set.
 */
export const listRunningSessions = async (): Promise<readonly RunningSession[]> => {
  if (!existsSync(SOCKETS_DIR)) return [];
  let entries: string[];
  try {
    entries = await readdir(SOCKETS_DIR);
  } catch {
    return [];
  }

  const results: RunningSession[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".sock")) continue;
    const name = entry.slice(0, -".sock".length);
    const linkPath = join(SOCKETS_DIR, entry);

    let socketPath: string;
    try {
      socketPath = readlinkSync(linkPath);
    } catch {
      // Broken symlink or permission error — prune
      safeUnlink(linkPath);
      continue;
    }

    // socketPath resolves to <root>/.murmuration/daemon.sock
    // → root = dirname(dirname(socketPath))
    const root = dirname(dirname(socketPath));

    let pid: number | undefined;
    const pidfile = join(root, ".murmuration", "daemon.pid");
    if (existsSync(pidfile)) {
      try {
        const raw = readFileSync(pidfile, "utf8").trim();
        const n = parseInt(raw, 10);
        pid = Number.isNaN(n) ? undefined : n;
      } catch {
        pid = undefined;
      }
    }

    const running = pid !== undefined && isProcessAlive(pid);
    if (!running) {
      // Stale entry — daemon died without cleanup. Prune.
      safeUnlink(linkPath);
      continue;
    }

    results.push({ name, socketPath, root, pid, running });
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const isBrokenSymlink = (path: string): boolean => {
  try {
    readlinkSync(path);
    return !existsSync(path);
  } catch {
    return false;
  }
};

const safeUnlink = (path: string): void => {
  try {
    unlinkSync(path);
  } catch {
    try {
      rmSync(path, { force: true });
    } catch {
      /* give up */
    }
  }
};

/** Exposed for tests. */
export const __socketsDirForTests = SOCKETS_DIR;
