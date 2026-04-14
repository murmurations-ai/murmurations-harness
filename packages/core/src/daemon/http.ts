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
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { DaemonEventBus } from "./events.js";

// ---------------------------------------------------------------------------
// Dashboard HTML — loaded from static file at import time.
// Extracted per Engineering Standard #5 (no inline HTML/JS in TypeScript).
// ---------------------------------------------------------------------------

const __dirname_compat = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_HTML = readFileSync(resolve(__dirname_compat, "dashboard.html"), "utf8");

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

export interface DaemonHttpConfig {
  readonly port: number;
  readonly statusHandler: () => Promise<unknown>;
  readonly commandHandler?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  readonly agentDetailHandler?: (agentId: string) => Promise<unknown>;
  readonly groupDetailHandler?: (groupId: string) => Promise<unknown>;
  readonly eventBus?: DaemonEventBus;
}

export class DaemonHttp {
  readonly #port: number;
  readonly #statusHandler: () => Promise<unknown>;
  readonly #sseClients = new Set<ServerResponse>();
  #server: Server | null = null;

  readonly #commandHandler: DaemonHttpConfig["commandHandler"];
  readonly #agentDetailHandler: DaemonHttpConfig["agentDetailHandler"];
  readonly #groupDetailHandler: DaemonHttpConfig["groupDetailHandler"];
  #unsubscribeEventBus: (() => void) | null = null;

  public constructor(config: DaemonHttpConfig) {
    this.#port = config.port;
    this.#statusHandler = config.statusHandler;
    this.#commandHandler = config.commandHandler;
    this.#agentDetailHandler = config.agentDetailHandler;
    this.#groupDetailHandler = config.groupDetailHandler;

    // Forward daemon events to all SSE clients
    if (config.eventBus) {
      this.#unsubscribeEventBus = config.eventBus.subscribe((event) => {
        this.pushEvent(event.kind, event as unknown as Record<string, unknown>);
      });
    }
  }

  public start(): void {
    this.#server = createServer((req, res) => {
      void this.#handleRequest(req, res);
    });
    this.#server.listen(this.#port);
  }

  public stop(): void {
    this.#unsubscribeEventBus?.();
    this.#unsubscribeEventBus = null;
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
      res.writeHead(302, { Location: "/dashboard" });
      res.end();
      return;
    }

    if (url === "/dashboard" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(DASHBOARD_HTML);
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

    if (url.startsWith("/api/agent/") && req.method === "GET" && this.#agentDetailHandler) {
      const agentId = url.slice("/api/agent/".length);
      try {
        const detail = await this.#agentDetailHandler(agentId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(detail));
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    if (url.startsWith("/api/group/") && req.method === "GET" && this.#groupDetailHandler) {
      const groupId = decodeURIComponent(url.slice("/api/group/".length));
      try {
        const detail = await this.#groupDetailHandler(groupId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(detail));
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
          if (this.#commandHandler) {
            void this.#commandHandler(parsed.method, parsed.params ?? {}).then(
              (result) => {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true, method: parsed.method, result }));
              },
              (err: unknown) => {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(
                  JSON.stringify({
                    ok: false,
                    error: err instanceof Error ? err.message : String(err),
                  }),
                );
              },
            );
          } else {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, method: parsed.method }));
          }
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
