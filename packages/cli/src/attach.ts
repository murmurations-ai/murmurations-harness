/**
 * `murmuration attach` — interactive REPL connected to a running daemon
 * via the Unix domain socket.
 *
 * Leader key: Ctrl-M (Enter) then a command character:
 *   s — status
 *   d — send directive
 *   w — trigger group-wake
 *   q — detach
 *   ? — help
 */

import { createConnection, type Socket } from "node:net";
import { createInterface, type Interface } from "node:readline";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

interface SocketResponse {
  readonly id: string;
  readonly result?: unknown;
  readonly error?: string;
}

interface SocketEvent {
  readonly event: string;
  readonly data: Record<string, unknown>;
}

export const runAttach = async (rootDir: string, name: string): Promise<void> => {
  const socketPath = resolve(rootDir, ".murmuration", "daemon.sock");
  if (!existsSync(socketPath)) {
    console.error(`murmuration attach: no daemon socket at ${socketPath}`);
    console.error("Is the daemon running? Try: murmuration start --name " + name);
    process.exit(1);
  }

  const conn = createConnection(socketPath);
  let requestId = 0;
  const pending = new Map<string, (resp: SocketResponse) => void>();

  // Parse incoming lines
  let buffer = "";
  conn.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      try {
        const msg = JSON.parse(line) as SocketResponse | SocketEvent;
        if ("id" in msg && typeof msg.id === "string" && pending.has(msg.id)) {
          const cb = pending.get(msg.id);
          pending.delete(msg.id);
          cb?.(msg as unknown as SocketResponse);
        } else if ("event" in msg) {
          printEvent(msg as unknown as SocketEvent);
        }
      } catch {
        /* skip malformed */
      }
    }
  });

  conn.on("error", (err) => {
    console.error(`\nSocket error: ${err.message}`);
    process.exit(1);
  });

  conn.on("close", () => {
    console.log("\nDaemon disconnected.");
    process.exit(0);
  });

  const send = (method: string, params?: Record<string, unknown>): Promise<SocketResponse> => {
    const id = String(++requestId);
    return new Promise((resolve) => {
      pending.set(id, resolve);
      conn.write(JSON.stringify({ id, method, ...(params ? { params } : {}) }) + "\n");
    });
  };

  // Initial status
  const status = await send("status");
  const result = status.result as
    | {
        version: string;
        pid: number;
        agentCount: number;
      }
    | undefined;
  console.log(
    `[${name}] murmuration v${result?.version ?? "?"} — ${String(result?.agentCount ?? "?")} agents, PID ${String(result?.pid ?? "?")}`,
  );
  console.log("Type a command or ? for help. Ctrl-C to detach.\n");

  // REPL
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt(`[${name}]> `);
  rl.prompt();

  rl.on("line", (line) => {
    const cmd = line.trim();
    void handleCommand(cmd, send, name, rl, conn);
  });

  rl.on("close", () => {
    conn.destroy();
    process.exit(0);
  });
};

const handleCommand = async (
  cmd: string,
  send: (method: string, params?: Record<string, unknown>) => Promise<SocketResponse>,
  _name: string,
  rl: Interface,
  _conn: Socket,
): Promise<void> => {
  if (cmd === "" || cmd === "s" || cmd === "status") {
    const resp = await send("status");
    if (resp.error) {
      console.log(`Error: ${resp.error}`);
    } else {
      const r = resp.result as {
        version: string;
        pid: number;
        agents: {
          agentId: string;
          state: string;
          totalWakes: number;
          totalArtifacts: number;
          idleWakes: number;
        }[];
      };
      console.log(`v${r.version} PID ${String(r.pid)}`);
      for (const a of r.agents) {
        const idle =
          a.totalWakes > 0
            ? `${String(Math.round((a.idleWakes / a.totalWakes) * 100))}% idle`
            : "—";
        console.log(
          `  ${a.agentId.padEnd(25)} ${a.state.padEnd(10)} ${String(a.totalWakes).padStart(3)}w ${String(a.totalArtifacts).padStart(3)}a ${idle}`,
        );
      }
    }
  } else if (cmd === "q" || cmd === "quit" || cmd === "detach") {
    console.log("Detaching.");
    rl.close();
    return;
  } else if (cmd === "stop") {
    console.log("Sending stop...");
    await send("stop");
    rl.close();
    return;
  } else if (cmd === "?" || cmd === "help") {
    console.log(`Commands:
  status (s)    Show agent status
  stop          Stop the daemon
  quit (q)      Detach from daemon
  help (?)      Show this help`);
  } else {
    console.log(`Unknown command: ${cmd}. Type ? for help.`);
  }
  rl.prompt();
};

const printEvent = (evt: SocketEvent): void => {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`  [${ts}] ${evt.event}: ${JSON.stringify(evt.data).slice(0, 80)}`);
};
