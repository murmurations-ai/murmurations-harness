/**
 * Daemon HTTP server — bridges the Unix socket protocol to HTTP/SSE
 * for web dashboard clients.
 *
 * Endpoints:
 *   GET  /api/status      — JSON snapshot of agent state
 *   GET  /api/events      — SSE stream of daemon events
 *   POST /api/command      — send a command (same as socket protocol)
 *   GET  /                 — health check
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
export interface DaemonHttpConfig {
  readonly port: number;
  readonly statusHandler: () => Promise<unknown>;
}

export class DaemonHttp {
  readonly #port: number;
  readonly #statusHandler: () => Promise<unknown>;
  readonly #sseClients = new Set<ServerResponse>();
  #server: Server | null = null;

  public constructor(config: DaemonHttpConfig) {
    this.#port = config.port;
    this.#statusHandler = config.statusHandler;
  }

  public start(): void {
    this.#server = createServer((req, res) => {
      void this.#handleRequest(req, res);
    });
    this.#server.listen(this.#port);
  }

  public stop(): void {
    for (const client of this.#sseClients) {
      client.end();
    }
    this.#sseClients.clear();
    this.#server?.close();
    this.#server = null;
  }

  /** Push an event to all SSE clients. */
  public pushEvent(event: string, data: Record<string, unknown>): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.#sseClients) {
      try {
        client.write(payload);
      } catch {
        this.#sseClients.delete(client);
      }
    }
  }

  async #handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS headers for local development
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url ?? "/";

    if (url === "/" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "murmuration-harness" }));
      return;
    }

    if (url === "/api/status" && req.method === "GET") {
      try {
        const status = await this.#statusHandler();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(status));
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    if (url === "/api/events" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write("event: connected\ndata: {}\n\n");
      this.#sseClients.add(res);
      req.on("close", () => {
        this.#sseClients.delete(res);
      });
      return;
    }

    if (url === "/api/command" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body) as { method: string; params?: Record<string, unknown> };
          void this.#statusHandler().then(() => {
            // For now, just echo the command — real implementation routes through socket
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, method: parsed.method }));
          });
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid JSON" }));
        }
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  }
}
