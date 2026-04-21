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
import { dirname, join, resolve } from "node:path";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

import { initSpiritSession, SpiritUnavailableError, type SpiritSession } from "./spirit/index.js";

interface SocketResponse {
  readonly id: string;
  readonly result?: unknown;
  readonly error?: string;
}

/** Bare verbs that dispatch to command handlers (no `:` prefix needed). */
const KNOWN_VERBS = new Set([
  "",
  "s",
  "status",
  "d",
  "directive",
  "wake",
  "convene",
  "switch",
  "agents",
  "groups",
  "events",
  "cost",
  "edit",
  "open",
  "q",
  "quit",
  "detach",
  "stop",
  "?",
  "help",
]);

interface SocketEvent {
  readonly event: string;
  readonly data: Record<string, unknown>;
}

/**
 * Animated "thinking" indicator for long-running synchronous
 * operations (Spirit turns, meeting wakes) where the operator would
 * otherwise see a blank terminal until the result arrives.
 *
 * v0.5.0 tester feedback: "when talking with the Spirit, it seems to
 * just hang. We should put some kind of indicator that it's doing
 * thinking or work."
 *
 * Writes to stderr so stdout captures stay clean for scripting, and
 * uses `\r` to overwrite the same line each tick. Elapsed seconds
 * tick up once per second so the operator can see the call isn't
 * frozen. Returns a stop() that clears the line and restores the
 * cursor.
 *
 * Skipped when stderr is not a TTY (CI, piped output).
 */
const startThinkingIndicator = (label: string): (() => void) => {
  if (!process.stderr.isTTY) return () => undefined;
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const start = Date.now();
  let frameIdx = 0;
  const render = (): void => {
    const elapsed = Math.floor((Date.now() - start) / 1000);
    const frame = frames[frameIdx % frames.length] ?? "";
    frameIdx++;
    process.stderr.write(`\r\x1b[2m${frame} ${label} (${String(elapsed)}s)\x1b[0m`);
  };
  render();
  const timer = setInterval(render, 100);
  return () => {
    clearInterval(timer);
    // Clear the line and reset to column 0.
    process.stderr.write("\r\x1b[K");
  };
};

/**
 * Persistent REPL history — `~/.murmuration/repl-history`, one entry
 * per line, oldest first (like bash). Node readline expects the
 * `history` option newest-first, so we reverse on load. Best-effort:
 * any I/O failure silently degrades to in-memory history only.
 */
const REPL_HISTORY_FILE = join(homedir(), ".murmuration", "repl-history");
const REPL_HISTORY_MAX = 500;

const loadReplHistory = (): string[] => {
  try {
    const content = readFileSync(REPL_HISTORY_FILE, "utf8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    // File is oldest-first; readline wants newest-first.
    return lines.slice(-REPL_HISTORY_MAX).reverse();
  } catch {
    return [];
  }
};

const appendReplHistory = (entry: string): void => {
  try {
    mkdirSync(dirname(REPL_HISTORY_FILE), { recursive: true });
    appendFileSync(REPL_HISTORY_FILE, `${entry}\n`);
  } catch {
    /* best-effort */
  }
};

/**
 * Unattached REPL — `murmuration` with no arguments drops the operator
 * here. From this prompt they can `list` running murmurations, `attach
 * <name>` to connect to one, or `quit` to exit. No daemon is started;
 * this is purely a navigation surface.
 *
 * v0.5.0 Milestone 4.9 (tester feedback): bare `murmuration` used to
 * auto-start a daemon when cwd had a murmuration/ directory. That
 * surprised operators who just wanted to see what was running.
 */
export const runUnattachedRepl = async (): Promise<void> => {
  const { listRunningSessions, listRunningSessionNamesSync } =
    await import("./running-sessions.js");
  const { HARNESS_VERSION } = await import("@murmurations-ai/core");

  const TOP_LEVEL_VERBS = ["list", "attach", "help", "quit", "exit"] as const;

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    history: loadReplHistory(),
    historySize: REPL_HISTORY_MAX,
    removeHistoryDuplicates: true,
    completer: (line: string): [string[], string] => {
      const parts = line.split(/\s+/);
      const verb = parts[0] ?? "";
      // First token: complete verbs.
      if (parts.length <= 1) {
        const hits = TOP_LEVEL_VERBS.filter((v) => v.startsWith(verb));
        return [hits.map((h) => h + " "), verb];
      }
      // `attach <TAB>`: complete from currently-running session names.
      if (verb === "attach") {
        const partial = parts[1] ?? "";
        const names = listRunningSessionNamesSync();
        const hits = names.filter((n) => n.startsWith(partial));
        return [hits, partial];
      }
      return [[], line];
    },
  });

  const prompt = "murmuration> ";

  console.log(`murmuration-harness v${HARNESS_VERSION} — unattached REPL`);
  console.log(
    "Type `list` to see running murmurations, `attach <name>` to connect, `?` for help.\n",
  );

  for (;;) {
    const line: string = await new Promise((res) => {
      rl.question(prompt, res);
    });
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    appendReplHistory(trimmed);
    const [verb = "", ...rest] = trimmed.split(/\s+/);

    if (verb === "quit" || verb === "q" || verb === "exit") {
      rl.close();
      return;
    }
    if (verb === "help" || verb === "?") {
      console.log("  list                 show running murmurations");
      console.log("  attach <name>        connect to a running murmuration");
      console.log("  quit / q / exit      leave the REPL");
      console.log("");
      console.log("Related CLI commands (run from your shell, not this REPL):");
      console.log("  murmuration start --root <path>     boot a daemon");
      console.log("  murmuration init [--example hello]  scaffold a new murmuration");
      console.log("  murmuration doctor                   diagnose setup\n");
      continue;
    }
    if (verb === "list" || verb === "ls") {
      const sessions = await listRunningSessions();
      if (sessions.length === 0) {
        console.log("  (no running murmurations)");
        console.log("  Start one with: murmuration start --root <path>\n");
      } else {
        for (const s of sessions) {
          console.log(`  ${s.name.padEnd(24)} PID ${String(s.pid ?? "?").padEnd(8)} ${s.root}`);
        }
        console.log("");
      }
      continue;
    }
    if (verb === "attach") {
      const name = rest[0];
      if (!name) {
        console.log("  usage: attach <name>\n");
        continue;
      }
      const sessions = await listRunningSessions();
      const match = sessions.find((s) => s.name === name);
      if (!match) {
        const available = sessions.map((s) => s.name);
        console.log(
          `  no running murmuration named "${name}".${available.length > 0 ? ` Known: ${available.join(", ")}.` : ""}\n`,
        );
        continue;
      }
      // Hand off to the full attach flow. Wait for THIS readline to
      // fully close before handing stdin to runAttach — otherwise two
      // readlines fight for stdin and characters double-echo. Then
      // runAttach's own readline owns stdin until the operator detaches,
      // at which point we re-enter the unattached REPL for another
      // pass. :quit/:exit in the unattached REPL is the only path back
      // to the shell.
      await new Promise<void>((res) => {
        rl.once("close", () => {
          res();
        });
        rl.close();
      });
      await runAttach(match.root, match.name);
      return runUnattachedRepl();
    }

    console.log(`  unknown command: ${verb}. type \`?\` for help.\n`);
  }
};

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

  // v0.5.0 Milestone 4.9.2: the runAttach promise now resolves when the
  // attached REPL's readline closes (i.e., on :quit / :detach / EOF).
  // Previously the function returned immediately after setup and the
  // close handler called `process.exit(0)`. That killed the process —
  // which broke the unattached REPL trying to reclaim control on detach.
  // Now the caller owns the lifecycle: bin.ts's `attach` command exits
  // naturally when its await resolves; the unattached REPL re-enters
  // its own loop.
  let resolveAttachClosed: () => void = () => {
    /* reassigned below */
  };
  const attachClosedPromise = new Promise<void>((res) => {
    resolveAttachClosed = res;
  });

  let agentIds: readonly string[] = [];
  let groupIds: readonly string[] = [];
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
      if (cmd === ":wake" || cmd === ":edit" || cmd === "wake" || cmd === "edit") {
        const partial = parts[1] ?? "";
        return [agentIds.filter((a) => a.startsWith(partial)), partial];
      }
      if (cmd === ":convene" || cmd === "convene") {
        const partial = parts[1] ?? "";
        return [groupIds.filter((g) => g.startsWith(partial)), partial];
      }
      if (cmd === ":directive" || cmd === "directive" || cmd === ":d" || cmd === "d") {
        const partial = parts[1] ?? "";
        const subs = ["list", "close", "delete", "edit"];
        return [subs.filter((s) => s.startsWith(partial)), partial];
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

  let connected = true;
  // Tracks whether the REPL is intentionally shutting down (operator
  // typed :quit / :detach). When true, socket close/error handlers
  // skip their rl.prompt() calls — calling prompt() on an already-
  // closed readline throws ERR_USE_AFTER_CLOSE and crashes the
  // unattached REPL we're about to hand off to.
  //
  // v0.5.0 tester feedback: `:q` → "Daemon disconnected" + crash.
  let shuttingDown = false;

  conn.on("error", (err) => {
    connected = false;
    if (shuttingDown) return;
    console.error(`\nDaemon connection lost: ${err.message}`);
    console.log(
      "The REPL is still running. Use :quit to exit or restart the daemon and re-attach.",
    );
    rl.setPrompt("(disconnected)> ");
    rl.prompt();
  });

  conn.on("close", () => {
    connected = false;
    if (shuttingDown) return;
    console.log("\nDaemon disconnected.");
    console.log(
      "The REPL is still running. Use :quit to exit or restart the daemon and re-attach.",
    );
    rl.setPrompt("(disconnected)> ");
    rl.prompt();
  });

  const send = (method: string, params?: Record<string, unknown>): Promise<SocketResponse> => {
    if (!connected) {
      return Promise.resolve({
        id: "0",
        error: "Not connected to daemon. Restart it and re-attach.",
      });
    }
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
  groupIds =
    (statusResult as { groups?: { groupId: string }[] }).groups?.map((g) => g.groupId) ?? [];
  rl.setPrompt(prompt);
  rl.prompt();

  let spiritSession: SpiritSession | null = null;
  let spiritUnavailableReason: string | null = null;
  // True while a Spirit turn is in flight. The line handler drops
  // input while busy so a second ENTER can't launch a concurrent turn.
  // Type-ahead queueing is a separate feature (issue #147).
  let spiritBusy = false;

  const ensureSpirit = async (): Promise<SpiritSession | null> => {
    if (spiritSession) return spiritSession;
    if (spiritUnavailableReason) return null;
    try {
      spiritSession = await initSpiritSession({ rootDir, send });
      return spiritSession;
    } catch (err) {
      if (err instanceof SpiritUnavailableError) {
        spiritUnavailableReason = err.message;
      } else {
        spiritUnavailableReason = err instanceof Error ? err.message : String(err);
      }
      return null;
    }
  };

  const handleSpiritTurn = async (message: string): Promise<void> => {
    const session = await ensureSpirit();
    if (!session) {
      console.log(`(Spirit unavailable: ${spiritUnavailableReason ?? "unknown"})`);
      console.log(`Use :help for commands or prefix explicit commands with ':'.`);
      rl.prompt();
      return;
    }
    spiritBusy = true;
    const stop = startThinkingIndicator("Spirit thinking");
    try {
      const result = await session.turn(message);
      stop();
      console.log(result.content);
      const tokens = `${String(result.inputTokens)} in / ${String(result.outputTokens)} out`;
      const cost = `$${result.estimatedCostUsd.toFixed(4)}`;
      const tools = result.toolCallCount > 0 ? `, ${String(result.toolCallCount)} tool calls` : "";
      console.log(`  \x1b[2m[${tokens}${tools} · ~${cost}]\x1b[0m`);
    } catch (err) {
      stop();
      console.log(`(Spirit error: ${err instanceof Error ? err.message : String(err)})`);
    } finally {
      spiritBusy = false;
    }
    rl.prompt();
  };

  rl.on("line", (line) => {
    const input = line.trim();

    // Spirit turn in flight — drop the input with a note so a second
    // ENTER can't launch a concurrent turn. Type-ahead queueing is a
    // separate feature tracked in issue #147.
    if (spiritBusy) {
      if (input.length > 0) {
        console.log("  (Spirit is thinking — your input was dropped. Wait for the response.)");
      }
      return;
    }

    // Bare ENTER is a no-op — just re-prompt. Tester feedback: bare
    // ENTER previously dispatched :status and dumped an agent list,
    // which was surprising. Operators use ENTER to clear their mental
    // state while thinking; the REPL should respect that.
    if (input.length === 0) {
      rl.prompt();
      return;
    }

    // Explicit command prefix — always dispatch as a command.
    if (input.startsWith(":")) {
      void handleCommand(input.slice(1), send, name, rl, conn, agentIds, rootDir);
      return;
    }

    // Bare known verb — back-compat command dispatch.
    const firstToken = input.split(/\s+/)[0] ?? "";
    if (firstToken.length > 0 && KNOWN_VERBS.has(firstToken)) {
      void handleCommand(input, send, name, rl, conn, agentIds, rootDir);
      return;
    }

    // Otherwise route to the Spirit.
    void handleSpiritTurn(input);
  });

  rl.on("close", () => {
    shuttingDown = true;
    conn.destroy();
    resolveAttachClosed();
  });

  // Block the promise until the readline closes. Callers await this
  // and act on it (bin.ts exits; unattached REPL re-enters its loop).
  await attachClosedPromise;
};

const handleCommand = async (
  cmd: string,
  send: (method: string, params?: Record<string, unknown>) => Promise<SocketResponse>,
  _name: string,
  rl: Interface,
  conn: Socket,
  agentIds: readonly string[],
  rootDir: string,
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
    const sub = parts[1];

    // :directive --list — show pending directives
    if (sub === "--list" || sub === "list") {
      const resp = await send("directive.list", {});
      if (resp.error) {
        console.log(`  Error: ${resp.error}`);
      } else {
        const items =
          (
            resp.result as {
              items?: { id: string; title: string; state: string; labels: string[] }[];
            }
          ).items ?? [];
        if (items.length === 0) {
          console.log("  No directives found.");
        } else {
          for (const item of items) {
            const scope = item.labels.find((l: string) => l.startsWith("scope:")) ?? "";
            console.log(
              `  ${item.id.padEnd(10)} ${item.state.padEnd(8)} ${scope.padEnd(20)} ${item.title.slice(0, 60)}`,
            );
          }
        }
      }

      // :directive close <id> — close a directive (mark resolved)
    } else if (sub === "close") {
      const itemId = parts[2];
      if (!itemId) {
        console.log("  Usage: :directive close <id>");
      } else {
        const resp = await send("directive.close", { id: itemId });
        if (resp.error) {
          console.log(`  Error: ${resp.error}`);
        } else {
          console.log(`  Directive ${itemId} closed.`);
        }
      }

      // :directive delete <id> — permanently delete a directive
    } else if (sub === "delete" || sub === "--delete") {
      const itemId = parts[2];
      if (!itemId) {
        console.log("  Usage: :directive delete <id>");
      } else {
        const resp = await send("directive.delete", { id: itemId });
        if (resp.error) {
          console.log(`  Error: ${resp.error}`);
        } else {
          console.log(`  Directive ${itemId} deleted.`);
        }
      }

      // :directive edit <id> — open in $EDITOR
    } else if (sub === "edit") {
      const itemId = parts[2];
      if (!itemId) {
        console.log("  Usage: :directive edit <id>");
      } else {
        const resp = await send("directive.path", { id: itemId });
        if (resp.error) {
          console.log(`  Error: ${resp.error}`);
        } else {
          const filePath = (resp.result as { path?: string }).path;
          if (!filePath) {
            console.log("  Error: no file path (edit only works with local provider)");
          } else {
            const editor = process.env.EDITOR ?? "vi";
            const { execSync } = await import("node:child_process");
            execSync(`${editor} ${filePath}`, { stdio: "inherit" });
          }
        }
      }

      // :directive <message> — create a new directive
    } else {
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
        console.log(`  Wake triggered for ${agentId}. Waiting for result...`);
        // Poll the wake log for completion
        const pathMod = await import("node:path");
        const logPath = pathMod.join(rootDir, ".murmuration", `wake-${agentId}.log`);
        const startTime = Date.now();
        const maxWaitMs = 120_000; // 2 min
        const pollMs = 2000;

        // Record log size at trigger time so we only look at NEW entries
        let logOffset = 0;
        try {
          const { stat: statF } = await import("node:fs/promises");
          logOffset = (await statF(logPath)).size;
        } catch {
          /* file doesn't exist yet */
        }

        const pollForResult = (): void => {
          if (Date.now() - startTime > maxWaitMs) {
            console.log("  (timed out waiting for wake result — check .murmuration/ log)");
            rl.prompt();
            return;
          }
          import("node:fs/promises")
            .then(({ readFile: readF }) =>
              readF(logPath, "utf8")
                .then((content) => {
                  // Only look at content AFTER the offset (new entries since we triggered)
                  const newContent = content.slice(logOffset);
                  for (const line of newContent.split("\n")) {
                    if (!line.trim()) continue;
                    try {
                      const evt = JSON.parse(line) as {
                        event?: string;
                        outcome?: string;
                        wakeSummary?: string;
                        errorMessage?: string;
                      };
                      if (evt.event === "daemon.wake.completed") {
                        console.log(`  Wake completed (${evt.outcome ?? "unknown"})`);
                        const summary = evt.wakeSummary ?? "";
                        for (const sl of summary.split("\n").slice(0, 15)) {
                          console.log(`  ${sl}`);
                        }
                        rl.prompt();
                        return;
                      }
                      if (evt.event === "daemon.wake.failed") {
                        console.log(`  Wake failed: ${evt.errorMessage ?? "unknown error"}`);
                        rl.prompt();
                        return;
                      }
                    } catch {
                      /* not JSON */
                    }
                  }
                  // Not done yet — poll again
                  setTimeout(pollForResult, pollMs);
                })
                .catch(() => {
                  setTimeout(pollForResult, pollMs);
                }),
            )
            .catch(() => {
              setTimeout(pollForResult, pollMs);
            });
        };

        // Start polling after a brief delay
        setTimeout(pollForResult, 1000);
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
      try {
        const { resolveSessionRoot } = await import("./sessions.js");
        const targetRoot = resolveSessionRoot(targetName);
        conn.destroy();
        await runAttach(targetRoot, targetName);
        return; // don't prompt — runAttach takes over
      } catch (err) {
        console.log(`  Could not switch: ${err instanceof Error ? err.message : String(err)}`);
        console.log("  Is the daemon running?");
      }
    }
  } else if (verb === "agents") {
    const { formatAgentsTable } = await import("./formatters.js");
    const resp = await send("agents.list");
    if (resp.error) {
      console.log(`Error: ${resp.error}`);
    } else {
      const agents = resp.result as {
        agentId: string;
        state: string;
        totalWakes: number;
        totalArtifacts: number;
        idleWakes: number;
        consecutiveFailures: number;
        groups: string[];
      }[];
      const filterVal = parts[1];
      const filtered =
        filterVal === "running" || filterVal === "idle" || filterVal === "failed"
          ? agents.filter((a) => a.state === filterVal)
          : agents;
      console.log(formatAgentsTable(filtered));
    }
  } else if (verb === "groups") {
    const { formatGroupsTable } = await import("./formatters.js");
    const resp = await send("groups.list");
    if (resp.error) {
      console.log(`Error: ${resp.error}`);
    } else {
      console.log(
        formatGroupsTable(
          resp.result as {
            groupId: string;
            memberCount: number;
            totalWakes: number;
            totalArtifacts: number;
            members: string[];
          }[],
        ),
      );
    }
  } else if (verb === "events") {
    const { formatEventsTable } = await import("./formatters.js");
    const resp = await send("events.history");
    if (resp.error) {
      console.log(`Error: ${resp.error}`);
    } else {
      console.log(
        formatEventsTable(
          resp.result as {
            groupId: string;
            date: string;
            kind: string;
            minutesUrl?: string;
            status: string;
          }[],
          [],
        ),
      );
    }
  } else if (verb === "cost") {
    const { formatCostTable } = await import("./formatters.js");
    const resp = await send("cost.summary");
    if (resp.error) {
      console.log(`Error: ${resp.error}`);
    } else {
      const r = resp.result as {
        totalWakes: number;
        totalArtifacts: number;
        agents: { agentId: string; totalWakes: number; totalArtifacts: number }[];
      };
      console.log(formatCostTable(r.totalWakes, r.totalArtifacts, r.agents));
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
  :directive list                   List open directives
  :directive close <id>             Close/resolve a directive
  :directive delete <id>            Permanently delete a directive
  :directive edit <id>              Open in $EDITOR (local provider only)
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
