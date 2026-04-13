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
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace; background: #0d1117; color: #c9d1d9; padding: 20px; max-width: 1200px; margin: 0 auto; }
  h1 { color: #58a6ff; margin-bottom: 4px; font-size: 1.4rem; }
  h2 { color: #c9d1d9; margin: 20px 0 10px; font-size: 1.1rem; border-bottom: 1px solid #30363d; padding-bottom: 6px; }
  .meta { color: #8b949e; margin-bottom: 16px; font-size: 0.85rem; }
  .overview { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; margin-bottom: 20px; }
  .overview .stat-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 12px; text-align: center; }
  .overview .stat-card .num { font-size: 1.6rem; font-weight: 700; color: #58a6ff; }
  .overview .stat-card .lbl { font-size: 0.75rem; color: #8b949e; margin-top: 2px; }
  .groups { margin-bottom: 20px; }
  .group-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 14px; margin-bottom: 10px; }
  .group-card h3 { color: #58a6ff; font-size: 1rem; margin-bottom: 6px; }
  .group-stats { display: flex; gap: 20px; font-size: 0.85rem; color: #8b949e; margin-bottom: 8px; }
  .group-stats span { color: #c9d1d9; font-weight: 600; }
  .group-members { display: flex; flex-wrap: wrap; gap: 6px; }
  .member-tag { background: #21262d; border: 1px solid #30363d; border-radius: 4px; padding: 2px 8px; font-size: 0.75rem; }
  .member-tag.active { border-color: #3fb950; color: #3fb950; }
  .member-tag.idle { border-color: #d29922; color: #d29922; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 12px; }
  .card h3 { color: #58a6ff; font-size: 0.9rem; margin-bottom: 6px; }
  .stat { display: flex; justify-content: space-between; margin: 3px 0; font-size: 0.8rem; }
  .stat .label { color: #8b949e; }
  .stat .value { color: #c9d1d9; font-weight: 600; }
  .state-idle { color: #3fb950; }
  .state-running { color: #d29922; }
  .state-failed { color: #f85149; }
  .bar { height: 4px; background: #21262d; border-radius: 2px; margin-top: 4px; }
  .bar-fill { height: 100%; border-radius: 2px; background: #58a6ff; }
  .bar-fill.warn { background: #f85149; }
  .events { margin-top: 16px; max-height: 150px; overflow-y: auto; font-size: 0.75rem; color: #8b949e; }
  .events div { padding: 2px 0; border-bottom: 1px solid #21262d; }
  #dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #3fb950; margin-right: 6px; }
</style>
</head>
<body>
<h1><span id="dot"></span><span id="title">Murmuration Dashboard</span></h1>
<div class="meta" id="meta">Loading...</div>

<div class="overview" id="overview"></div>

<h2 id="gov-title">Governance</h2>
<div class="groups" id="governance"></div>

<h2>Groups</h2>
<div class="groups" id="groups"></div>

<h2>Agents</h2>
<div class="grid" id="agents"></div>

<div class="events" id="events"></div>

<script>
async function refresh() {
  try {
    const r = await fetch('/api/status');
    const d = await r.json();
    const m = d.murmuration || {};
    document.getElementById('title').textContent = (d.name || 'Murmuration') + ' Dashboard';
    document.title = (d.name || 'Murmuration') + ' Dashboard';
    const ghLink = d.githubUrl ? ' | <a href="' + d.githubUrl + '/issues" style="color:#58a6ff" target="_blank">GitHub Issues</a>' : '';
    const g = d.governance || {};
    const govName = g.model || 'none';
    const govMeta = govName !== 'none' ? ' | Governance: ' + govName : '';
    document.getElementById('meta').innerHTML = 'v' + d.version + ' | PID ' + d.pid + govMeta + ' | ' + new Date().toLocaleTimeString() + ghLink;

    // 1. Overview
    const idleRate = m.totalWakes > 0 ? Math.round((m.idleWakes / m.totalWakes) * 100) : 0;
    document.getElementById('overview').innerHTML =
      sc(d.agentCount, 'Agents') +
      sc(m.groupCount || 0, 'Groups') +
      sc(m.totalWakes || 0, 'Total Wakes') +
      sc(m.totalArtifacts || 0, 'Artifacts') +
      sc(idleRate + '%', 'Idle Rate') +
      sc(g.totalItems || 0, 'Gov Items');

    // 2. Groups
    document.getElementById('groups').innerHTML = (d.groups || []).map(g => {
      const gIdle = g.totalWakes > 0 ? Math.round((g.idleWakes / g.totalWakes) * 100) : 0;
      return '<div class="group-card"><h3>' + g.groupId + '</h3>' +
        '<div class="group-stats">' +
        g.memberCount + ' members | ' +
        '<span>' + g.totalWakes + '</span> wakes | ' +
        '<span>' + g.totalArtifacts + '</span> artifacts | ' +
        gIdle + '% idle' +
        '</div>' +
        '<div class="group-members">' +
        g.members.map(id => {
          const a = d.agents.find(x => x.agentId === id);
          const cls = a && a.totalArtifacts > 0 ? 'active' : a && a.totalWakes > 0 ? 'idle' : '';
          return '<span class="member-tag ' + cls + '">' + id + '</span>';
        }).join('') +
        '</div></div>';
    }).join('');

    // 2b. Governance
    const gt = g.terminology || {};
    const itemLabel = gt.governanceItem || 'item';
    const eventLabel = gt.governanceEvent || 'event';
    document.getElementById('gov-title').textContent = 'Governance' + (govName !== 'none' ? ' (' + govName + ')' : '');
    const pending = g.pending || [];
    const recent = g.recentDecisions || [];
    let govHtml = '';
    if (pending.length > 0) {
      govHtml += '<div class="group-card"><h3>Pending ' + itemLabel + 's (' + pending.length + ')</h3>';
      govHtml += pending.map(i =>
        '<div class="stat"><span class="label">[' + i.kind + '] ' + (i.topic || '(no topic)').slice(0, 60) + '</span><span class="value state-running">' + i.state + '</span></div>'
      ).join('');
      govHtml += '</div>';
    }
    if (recent.length > 0) {
      govHtml += '<div class="group-card"><h3>Recent Decisions</h3>';
      govHtml += recent.map(i =>
        '<div class="stat"><span class="label">[' + i.kind + '] ' + (i.topic || '(no topic)').slice(0, 60) + '</span><span class="value state-idle">' + i.state + '</span></div>'
      ).join('');
      govHtml += '</div>';
    }
    if (govHtml === '') {
      govHtml = '<div class="group-card"><h3>No governance items</h3><div class="stat"><span class="label">File a ' + eventLabel + ' to start governance</span><span class="value">—</span></div></div>';
    }
    document.getElementById('governance').innerHTML = govHtml;

    // 3. Agents
    document.getElementById('agents').innerHTML = d.agents.map(a => {
      const ir = a.totalWakes > 0 ? Math.round((a.idleWakes / a.totalWakes) * 100) : 0;
      const ar = a.totalWakes > 0 ? (a.totalArtifacts / a.totalWakes).toFixed(1) : '0';
      const sc2 = a.state === 'idle' ? 'state-idle' : a.state === 'running' ? 'state-running' : 'state-failed';
      return '<div class="card"><h3>' + a.agentId + '</h3>' +
        st('State', '<span class="' + sc2 + '">' + a.state + '</span>') +
        st('Wakes', a.totalWakes) + st('Artifacts', a.totalArtifacts) +
        st('Art/Wake', ar) + st('Idle', ir + '%') + st('Failures', a.consecutiveFailures) +
        '<div class="bar"><div class="bar-fill' + (ir > 50 ? ' warn' : '') +
        '" style="width:' + Math.max(5, (a.totalArtifacts / Math.max(a.totalWakes, 1)) * 100) + '%"></div></div></div>';
    }).join('');
  } catch (e) {
    document.getElementById('meta').textContent = 'Disconnected: ' + e.message;
    document.getElementById('dot').style.background = '#f85149';
  }
}
function sc(n, l) { return '<div class="stat-card"><div class="num">' + n + '</div><div class="lbl">' + l + '</div></div>'; }
function st(l, v) { return '<div class="stat"><span class="label">' + l + '</span><span class="value">' + v + '</span></div>'; }

const sse = new EventSource('/api/events');
sse.onmessage = function(e) {
  const div = document.createElement('div');
  div.textContent = new Date().toLocaleTimeString() + ' ' + e.data;
  document.getElementById('events').prepend(div);
  refresh();
};
sse.addEventListener('connected', () => { document.getElementById('dot').style.background = '#3fb950'; });
sse.onerror = () => { document.getElementById('dot').style.background = '#f85149'; };
refresh();
setInterval(refresh, 10000);
</script>
</body>
</html>`;
