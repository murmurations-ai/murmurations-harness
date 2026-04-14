/**
 * `murmuration attach` — interactive REPL connected to a running daemon
 * via the Unix domain socket.
 *
 * Commands:
 *   status (s)     Show agent status
 *   directive (d)  Send a Source directive
 *   wake <agent>   Wake an agent now
 *   convene <group> [kind]  Convene a group meeting
 *   switch <name>  Detach and attach to another murmuration
 *   stop           Stop the daemon
 *   quit (q)       Detach
 *   help (?)       Show help
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

  // Load user config
  const { loadConfig } = await import("./config.js");
  const config = loadConfig();
  const prompt = config.ui.prompt.replace("{name}", name);

  let agentIds: readonly string[] = [];
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    completer: (line: string): [string[], string] => {
      const parts = line.split(/\s+/);
      const cmd = parts[0] ?? "";
      if (parts.length <= 1) {
        const commands = [
          ":status",
          ":agents",
          ":groups",
          ":events",
          ":cost",
          ":directive",
          ":wake",
          ":convene",
          ":edit",
          ":open",
          ":switch",
          ":stop",
          ":quit",
          ":help",
        ];
        return [commands.filter((c) => c.startsWith(cmd)), line];
      }
      if (cmd === ":wake" || cmd === ":edit") {
        const partial = parts[1] ?? "";
        return [agentIds.filter((a) => a.startsWith(partial)), partial];
      }
      return [[], line];
    },
  });

  // NOW connect the socket (after readline owns stdin)
  const conn = createConnection(socketPath);
  let requestId = 0;
  const pending = new Map<string, (resp: SocketResponse) => void>();

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
    return new Promise((r) => {
      pending.set(id, r);
      conn.write(JSON.stringify({ id, method, ...(params ? { params } : {}) }) + "\n");
    });
  };

  // Fetch initial status (socket is connected, readline already owns stdin)
  const status = await send("status");
  const statusResult = status.result as
    | {
        version: string;
        pid: number;
        agentCount: number;
        agents: { agentId: string; groups: string[] }[];
        groups: { groupId: string }[];
      }
    | undefined;
  const schemaVersion =
    (statusResult as { schemaVersion?: number } | undefined)?.schemaVersion ?? "?";
  console.log(
    `[${name}] murmuration v${statusResult?.version ?? "?"} (schema ${String(schemaVersion)}) — ${String(statusResult?.agentCount ?? "?")} agents, PID ${String(statusResult?.pid ?? "?")}`,
  );
  console.log("Type :help for commands. Ctrl-C to detach.\n");

  // Cache agent lists for :edit validation and tab completion
  agentIds = statusResult?.agents.map((a) => a.agentId) ?? [];
  rl.setPrompt(prompt);
  rl.prompt();

  rl.on("line", (line) => {
    let cmd = line.trim();
    // Support both `:command` (new) and bare `command` (backward compat)
    if (cmd.startsWith(":")) cmd = cmd.slice(1);
    void handleCommand(cmd, send, name, rl, conn, agentIds);
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
  conn: Socket,
  agentIds: readonly string[],
): Promise<void> => {
  const parts = cmd.split(/\s+/);
  const verb = parts[0] ?? "";

  if (verb === "" || verb === "s" || verb === "status") {
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
        governance: { model: string; pending: unknown[]; recentDecisions: unknown[] };
        inFlightMeetings: { groupId: string; kind: string }[];
      };
      console.log(
        `v${r.version} PID ${String(r.pid)} | governance: ${r.governance.model} | pending: ${String(r.governance.pending.length)} | meetings: ${String(r.inFlightMeetings.length)} in-flight`,
      );
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
  } else if (verb === "d" || verb === "directive") {
    // directive <message> OR prompt for it
    let message = parts.slice(1).join(" ").trim();
    if (!message) {
      message = await question(rl, "  Directive message: ");
    }
    if (!message) {
      console.log("  (cancelled)");
    } else {
      const scope = await question(rl, "  Scope (all/agent <id>/group <id>) [all]: ");
      const scopeParts = scope.trim().split(/\s+/);
      let params: Record<string, unknown>;
      if (scopeParts[0] === "agent" && scopeParts[1]) {
        params = { scope: "--agent", target: scopeParts[1], message };
      } else if (scopeParts[0] === "group" && scopeParts[1]) {
        params = { scope: "--group", target: scopeParts[1], message };
      } else {
        params = { scope: "--all", message };
      }
      console.log("  Sending directive...");
      const resp = await send("directive", params);
      if (resp.error) {
        console.log(`  Error: ${resp.error}`);
      } else {
        console.log("  Directive sent.");
      }
    }
  } else if (verb === "wake") {
    const agentId = parts[1];
    if (!agentId) {
      console.log("  Usage: wake <agent-id>");
    } else {
      console.log(`  Waking ${agentId}...`);
      const resp = await send("wake-now", { agentId });
      if (resp.error) {
        console.log(`  Error: ${resp.error}`);
      } else {
        console.log(`  Wake triggered for ${agentId}.`);
      }
    }
  } else if (verb === "convene") {
    const groupId = parts[1];
    if (!groupId) {
      console.log("  Usage: convene <group-id> [operational|governance|retrospective]");
    } else {
      const kind = parts[2] ?? "operational";
      console.log(`  Convening ${groupId} (${kind})...`);
      const resp = await send("group-wake", { groupId, kind });
      if (resp.error) {
        console.log(`  Error: ${resp.error}`);
      } else {
        console.log(`  ${groupId} ${kind} meeting convened.`);
      }
    }
  } else if (verb === "switch") {
    const targetName = parts[1];
    if (!targetName) {
      console.log("  Usage: switch <session-name>");
    } else {
      console.log(`  Switching to ${targetName}...`);
      conn.destroy();
      // Re-resolve and re-attach
      const { resolveSessionRoot } = await import("./sessions.js");
      const targetRoot = resolveSessionRoot(targetName);
      await runAttach(targetRoot, targetName);
      return; // don't prompt — runAttach takes over
    }
  } else if (verb === "agents") {
    const resp = await send("status");
    if (resp.error) {
      console.log(`Error: ${resp.error}`);
    } else {
      const r = resp.result as {
        agents: {
          agentId: string;
          state: string;
          totalWakes: number;
          totalArtifacts: number;
          idleWakes: number;
          consecutiveFailures: number;
          groups: string[];
        }[];
      };
      const filterVal = parts[1];
      let agents = r.agents;
      if (filterVal === "running" || filterVal === "idle" || filterVal === "failed") {
        agents = agents.filter((a) => a.state === filterVal);
      }
      for (const a of agents) {
        const idle =
          a.totalWakes > 0 ? `${String(Math.round((a.idleWakes / a.totalWakes) * 100))}%` : "—";
        console.log(
          `  ${a.agentId.padEnd(25)} ${a.state.padEnd(10)} ${String(a.totalWakes).padStart(3)}w ${String(a.totalArtifacts).padStart(3)}a ${idle.padStart(4)} idle  ${a.groups.join(", ")}`,
        );
      }
    }
  } else if (verb === "groups") {
    const resp = await send("status");
    if (resp.error) {
      console.log(`Error: ${resp.error}`);
    } else {
      const r = resp.result as {
        groups: {
          groupId: string;
          memberCount: number;
          totalWakes: number;
          totalArtifacts: number;
          members: string[];
        }[];
      };
      for (const g of r.groups) {
        console.log(
          `  ${g.groupId.padEnd(20)} ${String(g.memberCount)} members  ${String(g.totalWakes)}w ${String(g.totalArtifacts)}a  ${g.members.join(", ")}`,
        );
      }
    }
  } else if (verb === "events") {
    const resp = await send("status");
    if (resp.error) {
      console.log(`Error: ${resp.error}`);
    } else {
      const r = resp.result as {
        recentMeetings: { date: string; groupId: string; kind: string; minutesUrl?: string }[];
        inFlightMeetings: { groupId: string; kind: string }[];
      };
      if (r.inFlightMeetings.length > 0) {
        for (const m of r.inFlightMeetings) console.log(`  [running] ${m.groupId} ${m.kind}`);
      }
      for (const m of r.recentMeetings) {
        console.log(
          `  ${m.date}  ${m.groupId.padEnd(15)} ${m.kind.padEnd(14)} ${m.minutesUrl ?? ""}`,
        );
      }
      if (r.recentMeetings.length === 0 && r.inFlightMeetings.length === 0) console.log("  (none)");
    }
  } else if (verb === "cost") {
    const resp = await send("status");
    if (resp.error) {
      console.log(`Error: ${resp.error}`);
    } else {
      const r = resp.result as {
        murmuration: { totalWakes: number; totalArtifacts: number };
        agents: { agentId: string; totalWakes: number; totalArtifacts: number }[];
      };
      console.log(
        `  Total: ${String(r.murmuration.totalWakes)} wakes, ${String(r.murmuration.totalArtifacts)} artifacts`,
      );
      for (const a of r.agents.filter((x) => x.totalWakes > 0)) {
        const rate = (a.totalArtifacts / a.totalWakes).toFixed(1);
        console.log(
          `  ${a.agentId.padEnd(25)} ${String(a.totalWakes).padStart(3)}w ${String(a.totalArtifacts).padStart(3)}a  ${rate} art/wake`,
        );
      }
    }
  } else if (verb === "edit") {
    const agentId = parts[1];
    if (!agentId) {
      console.log("  Usage: edit <agent-id>  (opens role.md in $EDITOR)");
    } else if (!agentIds.includes(agentId)) {
      console.log(`  Unknown agent: ${agentId}. Known: ${agentIds.join(", ")}`);
    } else {
      // The daemon knows the root dir from status
      const resp = await send("status");
      const r = resp.result as { rootDir?: string };
      const rootDir = r.rootDir;
      if (rootDir) {
        const path = await import("node:path");
        const rolePath = path.resolve(path.join(rootDir, "agents", agentId, "role.md"));
        const editor = process.env.EDITOR ?? "vi";
        const cp = await import("node:child_process");
        console.log(`  Opening ${rolePath}...`);
        cp.spawnSync(editor, [rolePath], { stdio: "inherit" });
      } else {
        console.log("  Could not determine root directory from daemon.");
      }
    }
  } else if (verb === "open") {
    const target = parts[1];
    if (!target) {
      console.log("  Usage: open <issue-url|agent-id|group-id>");
    } else if (target.startsWith("http")) {
      const cp = await import("node:child_process");
      cp.execFile("open", [target], () => {
        /* fire-and-forget */
      });
    } else {
      // Try to open in GitHub
      const resp = await send("status");
      const r = resp.result as { githubUrl?: string };
      if (r.githubUrl) {
        const cp = await import("node:child_process");
        cp.execFile("open", [r.githubUrl], () => {
          /* fire-and-forget */
        });
      } else {
        console.log("  No GitHub URL available.");
      }
    }
  } else if (verb === "q" || verb === "quit" || verb === "detach") {
    console.log("Detaching.");
    rl.close();
    return;
  } else if (verb === "stop") {
    console.log("Sending stop...");
    await send("stop");
    rl.close();
    return;
  } else if (verb === "?" || verb === "help") {
    console.log(`Commands (use :prefix or bare):
  :status (s)                       Agent status + governance summary
  :agents [running|idle|failed]     Agent list with filter
  :groups                           Group list with stats
  :events                           Recent meetings + in-flight
  :cost                             Cost summary per agent
  :directive (d) [message]          Send a Source directive
  :wake <agent-id>                  Wake an agent now
  :convene <group-id> [kind]        Convene a group meeting
  :edit <agent-id>                  Open agent's role.md in $EDITOR
  :open <url|agent|group>           Open in browser
  :switch <session-name>            Switch to another murmuration
  :stop                             Stop the daemon
  :quit (q)                         Detach from daemon
  :help (?)                         Show this help

Tab completion works for commands, agent IDs, and group IDs.`);
  } else {
    console.log(`Unknown command: ${verb}. Type :help for commands.`);
  }
  rl.prompt();
};

/** Prompt for input within the REPL. */
const question = (rl: Interface, prompt: string): Promise<string> =>
  new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer);
    });
  });

const printEvent = (evt: SocketEvent): void => {
  const ts = new Date().toISOString().slice(11, 19);
  const data = evt.data;
  let summary: string;
  switch (evt.event) {
    case "wake.started":
      summary = `agent ${String(data.agentId)} waking`;
      break;
    case "wake.completed":
      summary = `agent ${String(data.agentId)} ${String(data.outcome)} (${String(data.artifactCount)} artifacts)`;
      break;
    case "meeting.started":
      summary = `${String(data.groupId)} ${String(data.meetingKind)} meeting started`;
      break;
    case "meeting.completed":
      summary = `${String(data.groupId)} ${String(data.meetingKind)} meeting completed`;
      break;
    case "governance.transitioned":
      summary = `governance ${String(data.itemId).slice(0, 8)} ${String(data.from)} → ${String(data.to)}`;
      break;
    default:
      summary = JSON.stringify(evt.data).slice(0, 80);
  }
  // Write to stderr to avoid interfering with readline's stdout management
  process.stderr.write(`  [${ts}] ${evt.event}: ${summary}\n`);
};
