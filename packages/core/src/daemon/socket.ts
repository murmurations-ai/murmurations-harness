/**
 * Daemon control socket — Unix domain socket for CLI/TUI/Web communication.
 *
 * Protocol: newline-delimited JSON.
 *   Request:  { "id": "abc", "method": "status" | "agents" | "stop" | "wake-now", "params"?: {...} }
 *   Response: { "id": "abc", "result"?: {...}, "error"?: string }
 *   Event:    { "event": "wake.completed" | "wake.fire" | ..., "data": {...} }
 *
 * Events are pushed to all connected clients (streaming).
 */

import { createServer, type Server, type Socket } from "node:net";
import { unlinkSync } from "node:fs";

/** A request from a client. */
export interface SocketRequest {
  readonly id: string;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

/** A response to a client. */
export interface SocketResponse {
  readonly id: string;
  readonly result?: unknown;
  readonly error?: string;
}

/** A push event to all clients. */
export interface SocketEvent {
  readonly event: string;
  readonly data: Record<string, unknown>;
}

/** Handler for incoming socket requests. */
export type SocketRequestHandler = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Creates and manages the daemon control socket.
 */
export class DaemonSocket {
  readonly #socketPath: string;
  readonly #handler: SocketRequestHandler;
  readonly #clients = new Set<Socket>();
  #server: Server | null = null;

  /** Ring buffer of recent events — replayed to new clients on connect. */
  readonly #eventBuffer: string[] = [];
  static readonly #EVENT_BUFFER_SIZE = 50;

  public constructor(socketPath: string, handler: SocketRequestHandler) {
    this.#socketPath = socketPath;
    this.#handler = handler;
  }

  /** Start listening on the Unix socket. */
  public start(): void {
    // Clean up stale socket file
    try {
      unlinkSync(this.#socketPath);
    } catch {
      /* doesn't exist — fine */
    }

    this.#server = createServer((client) => {
      this.#clients.add(client);

      // Replay recent events so attach clients see what happened
      for (const line of this.#eventBuffer) {
        try {
          client.write(line);
        } catch {
          /* client gone */
        }
      }

      let buffer = "";

      client.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim().length === 0) continue;
          void this.#handleLine(client, line);
        }
      });

      client.on("close", () => {
        this.#clients.delete(client);
      });

      client.on("error", () => {
        this.#clients.delete(client);
      });
    });

    this.#server.listen(this.#socketPath);
  }

  /** Stop the socket server and disconnect all clients. */
  public stop(): void {
    for (const client of this.#clients) {
      client.destroy();
    }
    this.#clients.clear();
    this.#server?.close();
    this.#server = null;
    try {
      unlinkSync(this.#socketPath);
    } catch {
      /* ok */
    }
  }

  /** Push an event to all connected clients and store in ring buffer. */
  public broadcast(event: string, data: Record<string, unknown>): void {
    const msg: SocketEvent = { event, data };
    const line = JSON.stringify(msg) + "\n";

    // Store in ring buffer for replay on attach
    this.#eventBuffer.push(line);
    if (this.#eventBuffer.length > DaemonSocket.#EVENT_BUFFER_SIZE) {
      this.#eventBuffer.shift();
    }
    for (const client of this.#clients) {
      try {
        client.write(line);
      } catch {
        /* client disconnected */
      }
    }
  }

  async #handleLine(client: Socket, line: string): Promise<void> {
    let req: SocketRequest;
    try {
      req = JSON.parse(line) as SocketRequest;
    } catch {
      client.write(JSON.stringify({ id: "?", error: "invalid JSON" }) + "\n");
      return;
    }

    try {
      const result = await this.#handler(req.method, req.params ?? {});
      const resp: SocketResponse = { id: req.id, result };
      client.write(JSON.stringify(resp) + "\n");
    } catch (err: unknown) {
      const resp: SocketResponse = {
        id: req.id,
        error: err instanceof Error ? err.message : String(err),
      };
      client.write(JSON.stringify(resp) + "\n");
    }
  }
}
