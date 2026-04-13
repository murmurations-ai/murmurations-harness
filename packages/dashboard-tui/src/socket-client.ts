/**
 * Socket client for the daemon control socket.
 * Used by the TUI dashboard to read agent state via the daemon
 * instead of reading files directly.
 */

import { createConnection } from "node:net";
import { join } from "node:path";
import { existsSync } from "node:fs";

interface SocketResponse {
  readonly id: string;
  readonly result?: unknown;
  readonly error?: string;
}

/**
 * Send a single request to the daemon socket and return the response.
 * Returns null if the socket is unavailable.
 */
export const queryDaemon = async (
  rootDir: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> => {
  const socketPath = join(rootDir, ".murmuration", "daemon.sock");
  if (!existsSync(socketPath)) return null;

  return new Promise<unknown>((resolve) => {
    const conn = createConnection(socketPath);
    let buffer = "";
    const timeout = setTimeout(() => {
      conn.destroy();
      resolve(null);
    }, 3000);

    conn.on("connect", () => {
      conn.write(JSON.stringify({ id: "tui-1", method, ...(params ? { params } : {}) }) + "\n");
    });

    conn.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        try {
          const resp = JSON.parse(line) as SocketResponse;
          if (resp.id === "tui-1") {
            clearTimeout(timeout);
            conn.destroy();
            if (resp.error) {
              resolve(null);
            } else {
              resolve(resp.result);
            }
            return;
          }
        } catch {
          /* skip */
        }
      }
    });

    conn.on("error", () => {
      clearTimeout(timeout);
      resolve(null);
    });
  });
};
