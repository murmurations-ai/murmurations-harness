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

// ---------------------------------------------------------------------------
// Embedded dashboard HTML
// ---------------------------------------------------------------------------

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Murmuration Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace; background: #0d1117; color: #c9d1d9; padding: 20px; }
  h1 { color: #58a6ff; margin-bottom: 4px; font-size: 1.4rem; }
  .meta { color: #8b949e; margin-bottom: 20px; font-size: 0.85rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 14px; }
  .card h3 { color: #58a6ff; font-size: 0.95rem; margin-bottom: 8px; }
  .stat { display: flex; justify-content: space-between; margin: 4px 0; font-size: 0.85rem; }
  .stat .label { color: #8b949e; }
  .stat .value { color: #c9d1d9; font-weight: 600; }
  .state-idle { color: #3fb950; }
  .state-running { color: #d29922; }
  .state-failed { color: #f85149; }
  .bar { height: 4px; background: #21262d; border-radius: 2px; margin-top: 6px; }
  .bar-fill { height: 100%; border-radius: 2px; background: #58a6ff; }
  .bar-fill.idle { background: #f85149; }
  .events { margin-top: 20px; max-height: 200px; overflow-y: auto; font-size: 0.8rem; color: #8b949e; }
  .events div { padding: 2px 0; border-bottom: 1px solid #21262d; }
  #status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #3fb950; margin-right: 6px; }
</style>
</head>
<body>
<h1><span id="status-dot"></span>Murmuration Dashboard</h1>
<div class="meta" id="meta">Loading...</div>
<div class="grid" id="agents"></div>
<div class="events" id="events"></div>
<script>
const agentsEl = document.getElementById('agents');
const metaEl = document.getElementById('meta');
const eventsEl = document.getElementById('events');

async function refresh() {
  try {
    const r = await fetch('/api/status');
    const d = await r.json();
    metaEl.textContent = 'v' + d.version + ' | PID ' + d.pid + ' | ' + d.agentCount + ' agents | ' + new Date().toLocaleTimeString();
    agentsEl.innerHTML = d.agents.map(a => {
      const idleRate = a.totalWakes > 0 ? Math.round((a.idleWakes / a.totalWakes) * 100) : 0;
      const artifactRate = a.totalWakes > 0 ? (a.totalArtifacts / a.totalWakes).toFixed(1) : '0';
      const stateClass = a.state === 'idle' ? 'state-idle' : a.state === 'running' ? 'state-running' : 'state-failed';
      return '<div class="card">' +
        '<h3>' + a.agentId + '</h3>' +
        '<div class="stat"><span class="label">State</span><span class="value ' + stateClass + '">' + a.state + '</span></div>' +
        '<div class="stat"><span class="label">Wakes</span><span class="value">' + a.totalWakes + '</span></div>' +
        '<div class="stat"><span class="label">Artifacts</span><span class="value">' + a.totalArtifacts + '</span></div>' +
        '<div class="stat"><span class="label">Artifact/Wake</span><span class="value">' + artifactRate + '</span></div>' +
        '<div class="stat"><span class="label">Idle Rate</span><span class="value">' + idleRate + '%</span></div>' +
        '<div class="stat"><span class="label">Failures</span><span class="value">' + a.consecutiveFailures + '</span></div>' +
        '<div class="bar"><div class="bar-fill' + (idleRate > 50 ? ' idle' : '') + '" style="width:' + Math.max(5, (a.totalArtifacts / Math.max(a.totalWakes, 1)) * 100) + '%"></div></div>' +
      '</div>';
    }).join('');
  } catch (e) {
    metaEl.textContent = 'Connection lost: ' + e.message;
    document.getElementById('status-dot').style.background = '#f85149';
  }
}

// SSE for real-time events
const sse = new EventSource('/api/events');
sse.onmessage = function(e) {
  const div = document.createElement('div');
  div.textContent = new Date().toLocaleTimeString() + ' ' + e.data;
  eventsEl.prepend(div);
  if (eventsEl.children.length > 50) eventsEl.lastChild.remove();
  refresh();
};
sse.addEventListener('connected', () => { document.getElementById('status-dot').style.background = '#3fb950'; });
sse.onerror = () => { document.getElementById('status-dot').style.background = '#f85149'; };

refresh();
setInterval(refresh, 10000);
</script>
</body>
</html>`;
