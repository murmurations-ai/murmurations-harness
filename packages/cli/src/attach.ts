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
  "show-digest",
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
 * Persistent REPL history — one file per surface so commands specific
 * to one murmuration (`:status editorial-agent`, `:directive close
 * 457`) don't cross-contaminate recall in another murmuration that
 * may not even have those agents/directives.
 *
 * Layout under `~/.murmuration/`:
 *   repl-history                — unattached REPL (generic: list, attach)
 *   repl-history-<name>         — attached REPL for murmuration <name>
 *
 * Oldest entry first (bash-style). readline's `history` option wants
 * newest-first, so we reverse on load. Best-effort: any I/O failure
 * silently degrades to in-memory history only.
 */
const REPL_HISTORY_MAX = 500;

const replHistoryFile = (sessionName: string | null): string =>
  join(
    homedir(),
    ".murmuration",
    sessionName === null ? "repl-history" : `repl-history-${sessionName}`,
  );

const loadReplHistory = (sessionName: string | null = null): string[] => {
  try {
    const content = readFileSync(replHistoryFile(sessionName), "utf8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    // File is oldest-first; readline wants newest-first.
    return lines.slice(-REPL_HISTORY_MAX).reverse();
  } catch {
    return [];
  }
};

const appendReplHistory = (entry: string, sessionName: string | null = null): void => {
  try {
    const file = replHistoryFile(sessionName);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${entry}\n`);
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
 * auto-start a daemon when cwd had a murmuration/ directory. That
 * surprised operators who just wanted to see what was running.
 */
export const runUnattachedRepl = async (): Promise<void> => {
  const { listRunningSessions, listRunningSessionNamesSync } =
    await import("./running-sessions.js");
  const { HARNESS_VERSION } = await import("@murmurations-ai/core");

  const TOP_LEVEL_VERBS = [
    "list",
    "attach",
    "start",
    "stop",
    "restart",
    "help",
    "quit",
    "exit",
  ] as const;

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    history: loadReplHistory(),
    historySize: REPL_HISTORY_MAX,
    removeHistoryDuplicates: true,
    completer: (line: string): [string[], string] => {
      // Strip any leading `:` so `:li<TAB>` completes to `list` just like
      // `li<TAB>` does. The attached REPL uses `:` as a command prefix;
      // the unattached REPL accepts it as a decorative alias.
      const hadColon = line.startsWith(":");
      const stripped = hadColon ? line.slice(1) : line;
      const parts = stripped.split(/\s+/);
      const verb = parts[0] ?? "";
      const restore = (s: string): string => (hadColon ? `:${s}` : s);
      // First token: complete verbs.
      if (parts.length <= 1) {
        const hits = TOP_LEVEL_VERBS.filter((v) => v.startsWith(verb));
        return [hits.map((h) => restore(h) + " "), restore(verb)];
      }
      // `attach <TAB>` / `stop <TAB>` / `restart <TAB>`: from running
      // sessions. `start <TAB>`: from registered-but-not-running.
      if (verb === "attach" || verb === "stop" || verb === "restart") {
        const partial = parts[1] ?? "";
        const names = listRunningSessionNamesSync();
        const hits = names.filter((n) => n.startsWith(partial));
        return [hits, partial];
      }
      if (verb === "start") {
        const partial = parts[1] ?? "";
        // Offer all registered names not currently running. Best-
        // effort sync read of the registry — failure falls through
        // to no completions.
        try {
          const raw = readFileSync(join(homedir(), ".murmuration", "sessions.json"), "utf8");
          const reg = JSON.parse(raw) as Record<string, unknown>;
          const running = new Set(listRunningSessionNamesSync());
          const hits = Object.keys(reg)
            .filter((n) => !running.has(n) && n.startsWith(partial))
            .sort();
          return [hits, partial];
        } catch {
          return [[], partial];
        }
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
    // Accept `:verb` as well as bare `verb` for muscle-memory consistency
    // with the attached REPL, where `:` is the explicit command prefix.
    // The unattached REPL has no Spirit-vs-command ambiguity so the `:`
    // is decorative here, but permitting it avoids retraining operators
    // who hop between attached and unattached surfaces.
    const normalized = trimmed.startsWith(":") ? trimmed.slice(1) : trimmed;
    const [verb = "", ...rest] = normalized.split(/\s+/);

    if (verb === "quit" || verb === "q" || verb === "exit") {
      rl.close();
      return;
    }
    if (verb === "help" || verb === "?") {
      console.log("  :list                show running murmurations");
      console.log("  :attach <name>       connect to a running murmuration");
      console.log("  :start <name>        start a registered daemon");
      console.log("  :stop <name>         stop a running daemon");
      console.log("  :restart <name>      stop + start a running daemon");
      console.log("  :quit / :q / :exit   leave the REPL");
      console.log("  (the `:` prefix is optional here — bare `list` also works)");
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
    if (verb === "stop") {
      const name = rest[0];
      if (!name) {
        console.log("  usage: stop <name>\n");
        continue;
      }
      await stopSession(name);
      continue;
    }
    if (verb === "start") {
      const name = rest[0];
      if (!name) {
        console.log("  usage: start <name>  (name must be registered or previously-running)\n");
        continue;
      }
      await startSession(name);
      continue;
    }
    if (verb === "restart") {
      const name = rest[0];
      if (!name) {
        console.log("  usage: restart <name>\n");
        continue;
      }
      // Capture the root BEFORE stopping. A running-but-never-registered
      // session loses its name→root mapping when the socket symlink
      // disappears, and `:start` would then fail with "no session
      // named X is registered or running." Snapshot first.
      const { findRunningSessionByName } = await import("./running-sessions.js");
      const preStop = findRunningSessionByName(name);
      const rootHint = preStop?.root;
      await stopSession(name);
      const waitStart = Date.now();
      while (findRunningSessionByName(name) !== null && Date.now() - waitStart < 5000) {
        await new Promise((r) => setTimeout(r, 200));
      }
      await startSession(name, rootHint);
      continue;
    }

    console.log(`  unknown command: ${verb}. type \`?\` for help.\n`);
  }
};

/**
 * Stop a running session by name. SIGTERM the daemon PID. Used by
 * `:stop` and as the first step of `:restart`. Idempotent — logs and
 * returns cleanly if the name isn't running.
 */
const stopSession = async (name: string): Promise<void> => {
  const { listRunningSessions } = await import("./running-sessions.js");
  const sessions = await listRunningSessions();
  const match = sessions.find((s) => s.name === name);
  if (!match) {
    const available = sessions.map((s) => s.name);
    console.log(
      `  no running murmuration named "${name}".${available.length > 0 ? ` Known: ${available.join(", ")}.` : ""}\n`,
    );
    return;
  }
  if (match.pid !== undefined) {
    try {
      process.kill(match.pid, "SIGTERM");
      console.log(`  Sent SIGTERM to ${name} (PID ${String(match.pid)}).`);
    } catch (err) {
      console.log(
        `  Could not signal PID ${String(match.pid)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    console.log(`  ${name} has no pid on record.`);
  }
};

/**
 * Start a registered (or previously-running) session by name. Spawns
 * a detached child daemon via `murmuration start --root <root>`, same
 * way the CLI does. Waits briefly for the socket symlink to appear
 * so the REPL can confirm the daemon is ready.
 *
 * `rootHint` lets the caller (e.g. :restart) supply the root directly
 * when the session isn't registered — useful for a running-but-never-
 * registered session we're cycling.
 */
const startSession = async (name: string, rootHint?: string): Promise<void> => {
  const { tryResolveSessionRoot } = await import("./sessions.js");
  const root = rootHint ?? tryResolveSessionRoot(name);
  if (!root) {
    console.log(
      `  no session named "${name}" is registered or running. Register first with \`murmuration register --name ${name} --root <path>\`, or start once from the shell with \`murmuration start --root <path>\`.\n`,
    );
    return;
  }
  // Persist the name→root mapping so future `:start ${name}` /
  // `:restart ${name}` calls work without a rootHint, even after a
  // full restart cycle drops the live socket.
  try {
    const { registerSession } = await import("./sessions.js");
    registerSession(name, root);
  } catch {
    /* best-effort — registry is UI sugar */
  }
  const { findRunningSessionByName } = await import("./running-sessions.js");
  if (findRunningSessionByName(name) !== null) {
    console.log(
      `  "${name}" is already running. Use \`:restart ${name}\` to cycle it, or \`:stop ${name}\` to stop it.\n`,
    );
    return;
  }
  const cp = await import("node:child_process");
  const { openSync } = await import("node:fs");
  const { mkdirSync } = await import("node:fs");
  const path = await import("node:path");
  const { daemonLogPath } = await import("@murmurations-ai/core");
  const logPath = daemonLogPath(root);
  mkdirSync(path.dirname(logPath), { recursive: true });
  const out = openSync(logPath, "a");
  const binPath = process.argv[1] ?? "murmuration";
  const child = cp.spawn(process.execPath, [binPath, "start", "--root", root], {
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  console.log(`  Starting ${name} (PID ${String(child.pid ?? "?")}); log: ${logPath}`);
  // Wait briefly for the socket symlink to appear — confirmation that
  // the daemon bound its control socket and is ready for :attach.
  const waitStart = Date.now();
  while (findRunningSessionByName(name) === null && Date.now() - waitStart < 10000) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (findRunningSessionByName(name) !== null) {
    console.log(`  ${name} is ready. Use \`:attach ${name}\` to connect.\n`);
  } else {
    console.log(
      `  (${name} didn't bind its socket within 10s — check ${logPath} for boot errors.)\n`,
    );
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
  // Directive ID cache — populated on attach and refreshed on every
  // `:directive list`. Used by the completer so `:directive close
  // <TAB>` doesn't require typing the full ID. Wrapped in a ref so
  // handleCommand (top-level fn) can refresh it via the passed-in
  // ref; the completer reads .value through the same ref.
  const directiveIdsRef: { value: readonly string[] } = { value: [] };
  // Digest filename cache, keyed by agentId. Populated on first
  // `:show-digest <agent>` and reused for <TAB> completion on the
  // second arg.
  const digestsByAgentRef: { value: Map<string, readonly string[]> } = { value: new Map() };
  // Agents we've already kicked off a digest.list fetch for (populated
  // or in-flight). Prevents duplicate requests on repeated TABs while
  // the first is still pending.
  const digestFetchesInFlight = new Set<string>();
  const maybeLoadDigestsFor = (agentId: string): void => {
    if (digestsByAgentRef.value.has(agentId)) return;
    if (digestFetchesInFlight.has(agentId)) return;
    digestFetchesInFlight.add(agentId);
    void (async () => {
      const resp = await send("digest.list", { agentId });
      if (!resp.error) {
        const r = resp.result as { digests?: { name: string }[] };
        digestsByAgentRef.value.set(
          agentId,
          (r.digests ?? []).map((d) => d.name),
        );
      }
      digestFetchesInFlight.delete(agentId);
    })();
  };
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    // Per-murmuration persistent history so `:status editorial-agent`
    // from the EP REPL doesn't pollute the hello-circle REPL.
    history: loadReplHistory(name),
    historySize: REPL_HISTORY_MAX,
    removeHistoryDuplicates: true,
    completer: (line: string): [string[], string] => {
      // When a single hit uniquely completes a token, append a space
      // so the next TAB starts on the following argument. Tester
      // feedback: "if a tab complete selects a single option, there
      // should be an additional space added too so I can keep tab
      // completing the next options, if there are any."
      const finalize = (hits: string[], partial: string): [string[], string] => [
        hits.length === 1 && hits[0] !== undefined ? [`${hits[0]} `] : hits,
        partial,
      ];
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
          ":show-digest",
          ":switch",
          ":stop",
          ":quit",
          ":help",
          ":reset",
          ":bye",
          ":remember",
          ":forget",
        ];
        return finalize(
          commands.filter((c) => c.startsWith(cmd)),
          line,
        );
      }
      if (
        cmd === ":wake" ||
        cmd === ":edit" ||
        cmd === ":status" ||
        cmd === "wake" ||
        cmd === "edit" ||
        cmd === "status" ||
        cmd === "s"
      ) {
        const partial = parts[1] ?? "";
        return finalize(
          agentIds.filter((a) => a.startsWith(partial)),
          partial,
        );
      }
      if (cmd === ":show-digest" || cmd === "show-digest") {
        if (parts.length <= 2) {
          // First arg: agent id.
          const partial = parts[1] ?? "";
          return finalize(
            agentIds.filter((a) => a.startsWith(partial)),
            partial,
          );
        }
        // Second arg: digest filename. Lazy-fire the digest.list for
        // this agent on first TAB so the SECOND TAB has results. The
        // enter-path (running :show-digest <agent> with no file arg)
        // also populates the cache as a side-effect.
        const agentId = parts[1] ?? "";
        const partial = parts[2] ?? "";
        if (agentIds.includes(agentId)) maybeLoadDigestsFor(agentId);
        const names = digestsByAgentRef.value.get(agentId) ?? [];
        return finalize(
          names.filter((n) => n.startsWith(partial)),
          partial,
        );
      }
      if (
        cmd === ":convene" ||
        cmd === "convene" ||
        cmd === ":groups" ||
        cmd === "groups" ||
        cmd === ":events" ||
        cmd === "events"
      ) {
        const partial = parts[1] ?? "";
        return finalize(
          groupIds.filter((g) => g.startsWith(partial)),
          partial,
        );
      }
      if (cmd === ":open" || cmd === "open") {
        const partial = parts[1] ?? "";
        const all = [...agentIds, ...groupIds];
        return finalize(
          all.filter((x) => x.startsWith(partial)),
          partial,
        );
      }
      if (cmd === ":directive" || cmd === "directive" || cmd === ":d" || cmd === "d") {
        const sub = parts[1] ?? "";
        // `:directive <TAB>` → list subcommands.
        if (parts.length <= 2) {
          const subs = ["list", "close", "delete", "edit"];
          return finalize(
            subs.filter((s) => s.startsWith(sub)),
            sub,
          );
        }
        // `:directive close|delete|edit <TAB>` → complete from cached
        // directive IDs. Empty cache falls through to no completions;
        // operator can run `:directive list` to populate.
        if (sub === "close" || sub === "delete" || sub === "edit") {
          const partial = parts[2] ?? "";
          return finalize(
            directiveIdsRef.value.filter((id) => id.startsWith(partial)),
            partial,
          );
        }
        return [[], line];
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
  let shuttingDown = false;

  // Daemon went away unexpectedly (crashed, stopped, socket closed).
  // Fall back to the unattached REPL so the operator can `list` /
  // `attach <name>` naturally. Previous behavior kept the attached
  // REPL alive with a "(disconnected)>" prompt, which routed input
  // into ambiguous places — Spirit, partial commands, broken sends.
  // at this point so we can attach, list, etc."
  const fallbackToUnattached = (reason: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${reason} Dropping back to the unattached REPL.`);
    rl.close(); // resolves attachClosedPromise → runAttach returns → caller loops
  };
  conn.on("error", (err) => {
    connected = false;
    fallbackToUnattached(`Daemon connection lost: ${err.message}.`);
  });
  conn.on("close", () => {
    connected = false;
    fallbackToUnattached("Daemon disconnected.");
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
  // Warm directive-id cache so `:directive close <TAB>` works the
  // first time without requiring `:directive list` first. Best-effort;
  // silently tolerates a missing collaboration provider.
  void (async () => {
    const resp = await send("directive.list", {});
    if (!resp.error) {
      const items = (resp.result as { items?: { id: string }[] }).items ?? [];
      directiveIdsRef.value = items.map((i) => i.id);
    }
  })();
  // Digest cache is populated lazily — see `maybeLoadDigestsFor`
  // below. First TAB for an agent fires the fetch in background;
  // second TAB picks up results. The enter-path also populates.
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
      if (result.truncated) {
        console.log(
          "(Spirit ran out of tool-use budget before producing an answer. Try narrowing the question, or ask for a shorter summary.)",
        );
      } else if (result.content.trim().length === 0) {
        console.log("(Spirit returned no text. Try rephrasing the question.)");
      } else {
        console.log(result.content);
      }
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

  // v0.7.0 [N] — `:reset` clears Spirit's cross-attach context.
  // v0.7.0 [O] — `:reset memory` clears Spirit's per-murmuration memory.
  // `:reset conversation` is an explicit alias for `:reset` (clears
  // conversation.jsonl + session.json only).
  const handleSpiritReset = async (input: string): Promise<void> => {
    if (input === ":reset memory") {
      const { SpiritMemory } = await import("./spirit/memory.js");
      const mem = new SpiritMemory(rootDir);
      try {
        const result = await mem.resetAll();
        console.log(
          `Spirit memory cleared (${String(result.cleared)} files removed). This cannot be undone.`,
        );
      } catch (err) {
        console.log(`(reset memory error: ${err instanceof Error ? err.message : String(err)})`);
      }
      rl.prompt();
      return;
    }
    const session = await ensureSpirit();
    if (!session) {
      console.log(`(Spirit unavailable: ${spiritUnavailableReason ?? "unknown"})`);
      rl.prompt();
      return;
    }
    try {
      await session.reset();
      console.log(
        "Spirit conversation context cleared. The next turn will start fresh (this cannot be undone).",
      );
    } catch (err) {
      console.log(`(reset error: ${err instanceof Error ? err.message : String(err)})`);
    }
    rl.prompt();
  };

  const handleSpiritRemember = async (name: string): Promise<void> => {
    if (name.length === 0) {
      console.log("Usage: :remember <name>   (kebab-case, e.g. user_role)");
      rl.prompt();
      return;
    }
    const { SpiritMemory } = await import("./spirit/memory.js");
    const mem = new SpiritMemory(rootDir);
    const description = await question(rl, "  description (one line): ");
    if (description.trim().length === 0) {
      console.log("(no description provided — aborted)");
      rl.prompt();
      return;
    }
    console.log("  body (end with a single line containing only `.`):");
    const lines: string[] = [];
    for (;;) {
      const line = await question(rl, "  ");
      if (line.trim() === ".") break;
      lines.push(line);
    }
    try {
      await mem.remember({
        type: "user",
        name,
        description: description.trim(),
        body: lines.join("\n"),
      });
      console.log(`Saved memory "${name}" (type=user). Edit ${mem.dir}/${name}.md to refine.`);
    } catch (err) {
      console.log(`(remember error: ${err instanceof Error ? err.message : String(err)})`);
    }
    rl.prompt();
  };

  const handleSpiritForget = async (name: string): Promise<void> => {
    if (name.length === 0) {
      console.log("Usage: :forget <name>");
      rl.prompt();
      return;
    }
    const { SpiritMemory } = await import("./spirit/memory.js");
    const mem = new SpiritMemory(rootDir);
    const confirm = await question(rl, `  forget "${name}"? [y/N]: `);
    if (confirm.trim().toLowerCase() !== "y") {
      console.log("(aborted)");
      rl.prompt();
      return;
    }
    try {
      const result = await mem.forget(name);
      console.log(result.removed ? `Removed memory "${name}".` : `(no memory named "${name}")`);
    } catch (err) {
      console.log(`(forget error: ${err instanceof Error ? err.message : String(err)})`);
    }
    rl.prompt();
  };

  // Eagerly initialise the Spirit on attach so we can show a "resumed"
  // greeting before the operator types anything. Failures are silent
  // (fall through to the lazy path on first turn — same as before).
  const initialSession = await ensureSpirit();
  if (initialSession) {
    if (initialSession.resumed && initialSession.lastTurnAt) {
      console.log(
        `Spirit resumed (last turn ${initialSession.lastTurnAt}). Type :reset to start fresh.\n`,
      );
    } else {
      console.log("Spirit fresh attach (no prior context).\n");
    }
    rl.prompt();
  }

  rl.on("line", (line) => {
    const input = line.trim();

    // Persist non-empty lines to the per-murmuration history file.
    if (input.length > 0) {
      appendReplHistory(input, name);
    }

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

    // Spirit-context REPL commands (v0.7.0 [N]) — handled here because
    // they need the closure-tracked spiritSession reference.
    if (input === ":reset" || input === ":reset memory" || input === ":reset conversation") {
      void handleSpiritReset(input);
      return;
    }
    if (input === ":bye") {
      console.log("(detaching — Spirit context preserved for next attach)");
      rl.close();
      return;
    }
    // Spirit memory REPL commands (v0.7.0 [O]) — direct hand-write path
    // that does not require the LLM. Source can use these to seed a
    // memory before the first turn or fix a mistaken auto-save.
    if (input.startsWith(":remember ")) {
      const name = input.slice(":remember ".length).trim();
      void handleSpiritRemember(name);
      return;
    }
    if (input.startsWith(":forget ")) {
      const name = input.slice(":forget ".length).trim();
      void handleSpiritForget(name);
      return;
    }

    // Explicit command prefix — always dispatch as a command.
    if (input.startsWith(":")) {
      void handleCommand(
        input.slice(1),
        send,
        name,
        rl,
        conn,
        agentIds,
        groupIds,
        directiveIdsRef,
        digestsByAgentRef,
        rootDir,
      );
      return;
    }

    // Bare known verb — back-compat command dispatch.
    const firstToken = input.split(/\s+/)[0] ?? "";
    if (firstToken.length > 0 && KNOWN_VERBS.has(firstToken)) {
      void handleCommand(
        input,
        send,
        name,
        rl,
        conn,
        agentIds,
        groupIds,
        directiveIdsRef,
        digestsByAgentRef,
        rootDir,
      );
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
  name: string,
  rl: Interface,
  conn: Socket,
  agentIds: readonly string[],
  groupIds: readonly string[],
  directiveIdsRef: { value: readonly string[] },
  digestsByAgentRef: { value: Map<string, readonly string[]> },
  rootDir: string,
): Promise<void> => {
  const parts = cmd.split(/\s+/);
  const verb = parts[0] ?? "";

  if (verb === "" || verb === "s" || verb === "status") {
    // :status <agent> → per-agent detail (state, digests). Without
    // an arg, whole-daemon snapshot.
    const agentArg = parts[1];
    if (agentArg) {
      if (!agentIds.includes(agentArg)) {
        console.log(`  Unknown agent: ${agentArg}. Known: ${agentIds.join(", ")}`);
      } else {
        const resp = await send("agents.get", { agentId: agentArg });
        if (resp.error) {
          console.log(`  Error: ${resp.error}`);
        } else {
          const d = resp.result as {
            agentId: string;
            state: string;
            totalWakes: number;
            totalArtifacts: number;
            idleWakes: number;
            consecutiveFailures: number;
            recentDigests: { date: string; summary: string; file: string }[];
          };
          console.log(
            `  ${d.agentId} — ${d.state} · wakes: ${String(d.totalWakes)} · artifacts: ${String(d.totalArtifacts)} · idle: ${String(d.idleWakes)} · failures: ${String(d.consecutiveFailures)}`,
          );
          if (d.recentDigests.length === 0) {
            console.log("  No recent digests.");
          } else {
            console.log("  Recent digests:");
            for (const entry of d.recentDigests) {
              // Skip blank lines and markdown headers that have no prose.
              // Some digests are frontmatter-only with an empty body —
              // fall back to "(empty digest)" instead of a lonely date.
              const meaningfulLine = entry.summary
                .split("\n")
                .map((s) => s.trim())
                .find((s) => s.length > 0 && !s.startsWith("#"));
              const preview = meaningfulLine ?? "(empty digest)";
              console.log(`    ${entry.date}  ${preview.slice(0, 80)}`);
              console.log(`                ${entry.file}`);
            }
          }
        }
      }
      rl.prompt();
      return;
    }
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
        // Refresh tab-completion cache so close/delete/edit <TAB>
        // reflects the just-listed state.
        directiveIdsRef.value = items.map((i) => i.id);
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
          const r = resp.result as { alreadyClosed?: boolean };
          if (r.alreadyClosed) {
            console.log(`  Directive ${itemId} was already closed (no-op).`);
          } else {
            console.log(`  Directive ${itemId} closed.`);
          }
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
          const r = resp.result as { alreadyClosed?: boolean };
          if (r.alreadyClosed) {
            console.log(`  Directive ${itemId} was already closed (no-op).`);
          } else {
            console.log(`  Directive ${itemId} deleted.`);
          }
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
    const force = parts.includes("--force");
    if (!agentId) {
      console.log("  Usage: wake <agent-id> [--force]");
    } else {
      console.log(`  Waking ${agentId}${force ? " (--force: bypass circuit breaker)" : ""}...`);
      const resp = await send("wake-now", { agentId, ...(force ? { force: true } : {}) });
      if (resp.error) {
        console.log(`  Error: ${resp.error}`);
      } else {
        console.log(`  Wake triggered for ${agentId}. Waiting for result...`);
        // Poll the wake log for completion
        const { wakeLogPath } = await import("@murmurations-ai/core");
        const logPath = wakeLogPath(rootDir, agentId);
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
            console.log(`  (timed out waiting for wake result — check ${logPath})`);
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
                      // Wall-clock timeout — the agent ran past its
                      // max_wall_clock_ms (15s default). Event fires
                      // with duration metadata the operator should see
                      // alongside the "what to do" hint.
                      if (evt.event === "daemon.wake.timedOut") {
                        const ev = evt as unknown as {
                          durationMs?: number;
                          budget?: { maxWallClockMs?: number };
                        };
                        const dur =
                          ev.durationMs !== undefined ? `${String(ev.durationMs)}ms` : "?";
                        const cap =
                          ev.budget?.maxWallClockMs !== undefined
                            ? `${String(ev.budget.maxWallClockMs)}ms`
                            : "?";
                        console.log(`  Wake timed out (${dur} / ${cap} wall clock).`);
                        console.log(
                          `  Raise max_wall_clock_ms in agents/${agentId}/role.md, or switch to a faster model (e.g. model_tier: fast).`,
                        );
                        rl.prompt();
                        return;
                      }
                      // Circuit-breaker skip — agent hit the consecutive-
                      // failure threshold (default 3) and is now locked
                      // out. The daemon never runs the wake, so there's
                      // no completed/failed event — recognize this here
                      // so the operator isn't left waiting 2min for a
                      // timeout. Offer the --force escape hatch.
                      if (evt.event === "daemon.wake.circuitBreaker") {
                        const ev = evt as unknown as {
                          consecutiveFailures?: number;
                          threshold?: number;
                        };
                        console.log(
                          `  Wake skipped: circuit breaker tripped (${String(ev.consecutiveFailures ?? "?")} / ${String(ev.threshold ?? "?")} consecutive failures).`,
                        );
                        console.log(
                          `  Run \`:wake ${agentId} --force\` to reset the failure count and try again.`,
                        );
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
      // :agents <text> — case-insensitive substring filter on agentId.
      // The old running/idle/failed state keywords were dropped as
      // filter covers the common case and doesn't clutter the surface.
      const filterVal = parts[1];
      const filtered =
        filterVal === undefined
          ? agents
          : agents.filter((a) => a.agentId.toLowerCase().includes(filterVal.toLowerCase()));
      console.log(formatAgentsTable(filtered));
      if (filterVal !== undefined && filtered.length === 0) {
        console.log(`  (no agents matched "${filterVal}")`);
      }
    }
  } else if (verb === "groups") {
    const { formatGroupsTable } = await import("./formatters.js");
    const resp = await send("groups.list");
    if (resp.error) {
      console.log(`Error: ${resp.error}`);
    } else {
      const groups = resp.result as {
        groupId: string;
        memberCount: number;
        totalWakes: number;
        totalArtifacts: number;
        members: string[];
      }[];
      const filterVal = parts[1];
      const filtered =
        filterVal === undefined
          ? groups
          : groups.filter((g) => g.groupId.toLowerCase().includes(filterVal.toLowerCase()));
      console.log(formatGroupsTable(filtered));
      if (filterVal !== undefined && filtered.length === 0) {
        console.log(`  (no groups matched "${filterVal}")`);
      }
    }
  } else if (verb === "events") {
    const { formatEventsTable } = await import("./formatters.js");
    const resp = await send("events.history");
    if (resp.error) {
      console.log(`Error: ${resp.error}`);
    } else {
      const events = resp.result as {
        groupId: string;
        date: string;
        kind: string;
        minutesUrl?: string;
        status: string;
      }[];
      // :events <text> — filter by substring on groupId or kind.
      // Events are group-level meetings so group ids are the natural
      // filter key. Parallel to :agents/:groups.
      const filterVal = parts[1];
      const filtered =
        filterVal === undefined
          ? events
          : events.filter((e) => {
              const needle = filterVal.toLowerCase();
              return (
                e.groupId.toLowerCase().includes(needle) || e.kind.toLowerCase().includes(needle)
              );
            });
      console.log(formatEventsTable(filtered, []));
      if (filterVal !== undefined && filtered.length === 0) {
        console.log(`  (no events matched "${filterVal}")`);
      }
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
  } else if (verb === "show-digest") {
    const agentId = parts[1];
    if (!agentId) {
      console.log("  Usage: :show-digest <agent-id> [<digest-filename>]");
    } else if (!agentIds.includes(agentId)) {
      console.log(`  Unknown agent: ${agentId}. Known: ${agentIds.join(", ")}`);
    } else {
      const listResp = await send("digest.list", { agentId });
      if (listResp.error) {
        console.log(`  Error: ${listResp.error}`);
      } else {
        const r = listResp.result as {
          digests: { name: string; file: string; date: string }[];
        };
        digestsByAgentRef.value.set(
          agentId,
          r.digests.map((d) => d.name),
        );
        const fileArg = parts[2];
        if (!fileArg) {
          // No file → print the most recent digest's full body.
          const latest = r.digests[0];
          if (!latest) {
            console.log("  (no digests yet)");
          } else {
            const getResp = await send("digest.get", { agentId, file: latest.name });
            if (getResp.error) {
              console.log(`  Error: ${getResp.error}`);
            } else {
              const g = getResp.result as { content: string; path: string };
              console.log(`  ${g.path}`);
              console.log("  " + "─".repeat(60));
              console.log(g.content);
            }
          }
          if (r.digests.length > 1) {
            console.log(`  (${String(r.digests.length)} digests — TAB-complete to pick another)`);
          }
        } else {
          const getResp = await send("digest.get", { agentId, file: fileArg });
          if (getResp.error) {
            console.log(`  Error: ${getResp.error}`);
          } else {
            const g = getResp.result as { content: string; path: string };
            console.log(`  ${g.path}`);
            console.log("  " + "─".repeat(60));
            console.log(g.content);
          }
        }
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
      // No target — open the murmuration's GitHub URL if we have one.
      const resp = await send("status");
      const r = resp.result as { githubUrl?: string };
      if (r.githubUrl) {
        const cp = await import("node:child_process");
        cp.execFile("open", [r.githubUrl], () => {
          /* fire-and-forget */
        });
      } else {
        console.log("  Usage: open <url|agent-id|group-id>");
        console.log("  (no default GitHub URL configured for this murmuration)");
      }
    } else if (target.startsWith("http")) {
      const cp = await import("node:child_process");
      cp.execFile("open", [target], () => {
        /* fire-and-forget */
      });
    } else {
      // Resolve target to a local file. The daemon status knows
      // rootDir; from there, agents/<id>/role.md for agent ids and
      // governance/groups/<id>.md for group ids. Previously `:open
      // <group>` ignored the target entirely and reported "No GitHub
      // URL available" — which was both wrong and confusing.
      const resp = await send("status");
      const r = resp.result as { rootDir?: string };
      const rootDir = r.rootDir;
      if (!rootDir) {
        console.log("  Could not determine root directory from daemon.");
        return;
      }
      const path = await import("node:path");
      const fs = await import("node:fs");
      let filePath: string | null = null;
      if (agentIds.includes(target)) {
        filePath = path.resolve(path.join(rootDir, "agents", target, "role.md"));
      } else if (groupIds.includes(target)) {
        filePath = path.resolve(path.join(rootDir, "governance", "groups", `${target}.md`));
      }
      if (filePath && fs.existsSync(filePath)) {
        const editor = process.env.EDITOR ?? "vi";
        const cp = await import("node:child_process");
        console.log(`  Opening ${filePath}...`);
        cp.spawnSync(editor, [filePath], { stdio: "inherit" });
      } else {
        console.log(`  No match for "${target}".`);
        console.log(`  Known agents: ${agentIds.join(", ") || "(none)"}`);
        console.log(`  Known groups: ${groupIds.join(", ") || "(none)"}`);
        console.log(`  Or pass a full URL: open https://...`);
      }
    }
  } else if (verb === "q" || verb === "quit" || verb === "detach") {
    console.log("Detaching.");
    rl.close();
    return;
  } else if (verb === "stop") {
    // Attached :stop takes no arg and stops THIS daemon. If an arg is
    // given, require it to match the attached session name — that way
    // `:stop <typo>` doesn't silently stop the murmuration the operator
    // is attached to. Tester feedback: ":stop dw stopped emergent-praxis
    // even though I did not name it."
    const target = parts[1];
    if (target && target !== name) {
      console.log(
        `  refusing to stop: you're attached to "${name}" but asked to stop "${target}".`,
      );
      console.log(
        `  To stop "${name}", use bare \`:stop\` (no arg) or \`:stop ${name}\`. To stop a different murmuration, detach first (\`:q\`) and run \`:stop ${target}\` from the unattached REPL.`,
      );
      rl.prompt();
      return;
    }
    console.log(`Sending stop to ${name}...`);
    await send("stop");
    rl.close();
    return;
  } else if (verb === "?" || verb === "help") {
    console.log(`Commands (use :prefix or bare):
  :status (s)                       Agent status + governance summary
  :agents [<substring>]             Agent list; optional case-insensitive id filter
  :groups [<substring>]             Group list; optional case-insensitive id filter
  :events [<substring>]             Recent meetings + in-flight; optional group/kind filter
  :cost                             Cost summary per agent
  :show-digest <agent> [<file>]     Print a wake digest (TAB-complete file)
  :directive (d) [message]          Send a Source directive
  :directive list                   List open directives
  :directive close <id>             Close/resolve a directive
  :directive delete <id>            Permanently delete a directive
  :directive edit <id>              Open in $EDITOR (local provider only)
  :wake <agent-id>                  Wake an agent now
  :convene <group-id> [kind]        Convene a group meeting
  :edit <agent-id>                  Open agent's role.md in $EDITOR
  :open <url|agent|group>           Open URL in browser, or file in $EDITOR
  :switch <session-name>            Switch to another murmuration
  :stop                             Stop the daemon
  :reset                            Clear Spirit's cross-attach conversation
  :reset memory                     Clear Spirit's per-murmuration memory
  :remember <name>                  Save a Source-authored memory (interactive)
  :forget <name>                    Remove a memory (with confirmation)
  :bye                              Detach with a Spirit-context-preserved farewell
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
