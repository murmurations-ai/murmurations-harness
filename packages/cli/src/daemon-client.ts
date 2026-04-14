/**
 * Daemon client — connects to a running daemon's Unix socket and
 * sends RPC requests. Used by batch CLI verbs that need daemon state.
 *
 * Engineering Standard #4: events over polling. The daemon is the
 * source of truth; batch commands query it, not local files.
 */

import { createConnection, type Socket } from "node:net";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

interface SocketResponse {
  readonly id: string;
  readonly result?: unknown;
  readonly error?: string;
}

/**
 * Send a single RPC request to the daemon and return the result.
 * Throws if the daemon is not running or the request fails.
 */
export const daemonRpc = async (
  rootDir: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> => {
  const socketPath = resolve(rootDir, ".murmuration", "daemon.sock");
  if (!existsSync(socketPath)) {
    throw new Error(
      `No daemon running at ${rootDir} (socket not found). Start with: murmuration start --root ${rootDir}`,
    );
  }

  return new Promise<unknown>((resolvePromise, reject) => {
    const conn: Socket = createConnection(socketPath, () => {
      const id = "rpc-1";
      const msg = JSON.stringify({ id, method, ...(params ? { params } : {}) }) + "\n";
      conn.write(msg);
    });

    let buffer = "";
    conn.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as SocketResponse;
          if (msg.id === "rpc-1") {
            conn.destroy();
            if (msg.error) {
              reject(new Error(msg.error));
            } else {
              resolvePromise(msg.result);
            }
          }
        } catch {
          /* skip non-response lines (broadcast events) */
        }
      }
    });

    conn.on("error", (err) => {
      reject(new Error(`Daemon connection failed: ${err.message}`));
    });

    // Timeout after 5 seconds
    setTimeout(() => {
      conn.destroy();
      reject(new Error("Daemon did not respond within 5 seconds"));
    }, 5000);
  });
};
