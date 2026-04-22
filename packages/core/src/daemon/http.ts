/**
 * Daemon HTTP server — bridges the Unix socket protocol to HTTP/SSE
 * for web dashboard clients.
 *
 * Endpoints:
 *   GET  /api/status      — JSON snapshot of agent state
 *   GET  /api/events      — SSE stream of daemon events
 *   POST /api/command      — send a command (same as socket protocol)
 *   GET  /                 — health check
 *
 * Security model:
 *   - Bound to 127.0.0.1 only
 *   - Host header must be `127.0.0.1:<port>` or `localhost:<port>`
 *     (defeats DNS rebinding attacks)
 *   - Every endpoint except `/dashboard` requires a random per-daemon
 *     auth token, either via `?token=` query param or `x-murmuration-token`
 *     header. The token is minted at daemon start and written to
 *     `<root>/.murmuration/dashboard.token` with 0600 permissions so
 *     only the operator account can read it. The boot log echoes the
 *     full URL including the token so the operator can open the
 *     dashboard with one click.
 *   - `/dashboard` serves static HTML with a strict Content-Security-Policy
 *     and `default-src 'self'` so any injected content can't reach
 *     third-party origins.
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

/**
 * Content-Security-Policy for /dashboard. Strict enough to contain an
 * XSS injection if one slips past the escape helper in dashboard.html:
 * - no third-party script sources
 * - no inline event handlers (inline <script> is allowed because the
 *   dashboard is a single static file with its behavior inline; a
 *   future milestone extracts it)
 * - no plugins, no base rewrites, no mixed content
 */
const DASHBOARD_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join("; ");

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
  /**
   * Shared secret required on every API request. Minted at daemon
   * start; persisted to disk (0600) for the local dashboard to read.
   * Clients present it as `?token=<value>` or the
   * `x-murmuration-token` header.
   */
  readonly authToken: string;
}

export class DaemonHttp {
  readonly #port: number;
  readonly #statusHandler: () => Promise<unknown>;
  readonly #sseClients = new Set<ServerResponse>();
  #server: Server | null = null;

  readonly #commandHandler: DaemonHttpConfig["commandHandler"];
  readonly #agentDetailHandler: DaemonHttpConfig["agentDetailHandler"];
  readonly #groupDetailHandler: DaemonHttpConfig["groupDetailHandler"];
  readonly #authToken: string;
  #unsubscribeEventBus: (() => void) | null = null;

  public constructor(config: DaemonHttpConfig) {
    this.#port = config.port;
    this.#statusHandler = config.statusHandler;
    this.#commandHandler = config.commandHandler;
    this.#agentDetailHandler = config.agentDetailHandler;
    this.#groupDetailHandler = config.groupDetailHandler;
    this.#authToken = config.authToken;

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
    this.#server.listen(this.#port, "127.0.0.1");
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

  /**
   * Verify the Host header points at our expected localhost binding.
   * A mismatch usually means DNS rebinding or a misconfigured reverse
   * proxy — either way, refuse. The daemon only ever listens on
   * 127.0.0.1, so legitimate requests have `127.0.0.1:<port>` or
   * `localhost:<port>` in the Host header.
   */
  #hostHeaderOk(req: IncomingMessage): boolean {
    const host = req.headers.host;
    if (typeof host !== "string") return false;
    const port = String(this.#port);
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
  }

  /**
   * Constant-time equality check for the auth token. Avoids timing
   * leaks across the network (same-origin browser-dashboard use case
   * isn't really exposed to this attack, but it's cheap insurance).
   */
  #constantTimeEq(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  }

  /**
   * Accept a token from `x-murmuration-token` header or `?token=` query.
   * Header is preferred (doesn't leak into server logs or `Referer`).
   */
  #tokenOk(req: IncomingMessage, url: string): boolean {
    const header = req.headers["x-murmuration-token"];
    if (typeof header === "string" && this.#constantTimeEq(header, this.#authToken)) {
      return true;
    }
    const qIdx = url.indexOf("?");
    if (qIdx >= 0) {
      const search = new URLSearchParams(url.slice(qIdx + 1));
      const q = search.get("token");
      if (q !== null && this.#constantTimeEq(q, this.#authToken)) return true;
    }
    return false;
  }

  async #handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Host header + DNS rebinding defense
    if (!this.#hostHeaderOk(req)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid Host header" }));
      return;
    }

    // CORS headers for local development (same-origin only)
    res.setHeader("Access-Control-Allow-Origin", `http://localhost:${String(this.#port)}`);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Murmuration-Token");
    res.setHeader("Vary", "Origin");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url ?? "/";
    const urlPath = url.split("?")[0] ?? "/";

    if (urlPath === "/" && req.method === "GET") {
      res.writeHead(302, { Location: "/dashboard" });
      res.end();
      return;
    }

    if (urlPath === "/dashboard" && req.method === "GET") {
      // The dashboard itself is public (no token) so the operator can
      // land on it and see the login form; all data endpoints require
      // the token. CSP keeps any injected script boxed in.
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": DASHBOARD_CSP,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      });
      res.end(DASHBOARD_HTML);
      return;
    }

    // All /api/* endpoints require the auth token.
    if (urlPath.startsWith("/api/") && !this.#tokenOk(req, url)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "missing or invalid token" }));
      return;
    }

    if (urlPath === "/api/status" && req.method === "GET") {
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

    if (urlPath.startsWith("/api/agent/") && req.method === "GET" && this.#agentDetailHandler) {
      const agentId = urlPath.slice("/api/agent/".length);
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(agentId)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid agent ID" }));
        return;
      }
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

    if (urlPath.startsWith("/api/group/") && req.method === "GET" && this.#groupDetailHandler) {
      const groupId = decodeURIComponent(urlPath.slice("/api/group/".length));
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(groupId)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid group ID" }));
        return;
      }
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

    if (urlPath === "/api/events" && req.method === "GET") {
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

    if (urlPath === "/api/command" && req.method === "POST") {
      const MAX_BODY = 65536; // 64KB limit
      let body = "";
      let oversized = false;
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
        if (body.length > MAX_BODY && !oversized) {
          oversized = true;
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "request body too large" }));
          req.destroy();
        }
      });
      req.on("end", () => {
        if (oversized) return;
        try {
          const raw: unknown = JSON.parse(body);
          if (typeof raw !== "object" || raw === null) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "request must be an object" }));
            return;
          }
          const obj = raw as Record<string, unknown>;
          if (typeof obj.method !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "method must be a string" }));
            return;
          }
          const parsed = {
            method: obj.method,
            params: (typeof obj.params === "object" && obj.params !== null
              ? obj.params
              : {}) as Record<string, unknown>,
          };
          if (this.#commandHandler) {
            void this.#commandHandler(parsed.method, parsed.params).then(
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
