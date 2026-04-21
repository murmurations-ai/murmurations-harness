/**
 * Log file path resolution.
 *
 * Canonical location: `<rootDir>/.murmuration/logs/`
 *
 *   daemon.log           — daemon stdout/stderr (captured by the spawner)
 *   wake-<agentId>.log   — per-agent wake JSONL stream (emitted by `wake-now`)
 *
 * Logs are operational metadata, not content, so they stay under the
 * hidden `.murmuration/` directory alongside the socket and pidfile.
 * They're grouped into `logs/` so the root of `.murmuration/` stays
 * uncluttered as we add more ops files.
 */

import { join } from "node:path";

export const LOGS_DIR_NAME = "logs";

/** `<rootDir>/.murmuration/logs` — base logs directory. */
export const logsDir = (rootDir: string): string => join(rootDir, ".murmuration", LOGS_DIR_NAME);

/** `<rootDir>/.murmuration/logs/daemon.log` — daemon stdout/stderr. */
export const daemonLogPath = (rootDir: string): string => join(logsDir(rootDir), "daemon.log");

/** `<rootDir>/.murmuration/logs/wake-<agentId>.log` — per-agent wake JSONL. */
export const wakeLogPath = (rootDir: string, agentId: string): string =>
  join(logsDir(rootDir), `wake-${agentId}.log`);
