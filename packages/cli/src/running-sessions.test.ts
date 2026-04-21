import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The module reads SOCKETS_DIR at import time from homedir(), so we
// point HOME at a tmp dir BEFORE importing.
let origHome = "";
let sandboxHome = "";

beforeEach(async () => {
  sandboxHome = await mkdtemp(join(tmpdir(), "running-sessions-"));
  origHome = process.env.HOME ?? "";
  process.env.HOME = sandboxHome;
  vi.resetModules();
});

afterEach(async () => {
  process.env.HOME = origHome;
  if (sandboxHome) await rm(sandboxHome, { recursive: true, force: true });
});

describe("running-sessions (v0.5.0 Milestone 4.8)", () => {
  const loadModule = async (): Promise<typeof import("./running-sessions.js")> => {
    // Cache-bust so each test gets a fresh module closure (HOME changes).
    const mod = (await import(
      "./running-sessions.js?t=" + String(Date.now())
    )) as typeof import("./running-sessions.js");
    return mod;
  };

  const makeFakeDaemon = (rootName: string): { root: string; socketPath: string } => {
    const root = join(sandboxHome, rootName);
    mkdirSync(join(root, ".murmuration"), { recursive: true });
    const socketPath = join(root, ".murmuration", "daemon.sock");
    // Simulate the socket file existing. Node's existsSync doesn't care
    // whether it's a real socket for our purposes; we just need a target.
    writeFileSync(socketPath, "", "utf8");
    // PID file points at this test process (always alive)
    writeFileSync(join(root, ".murmuration", "daemon.pid"), String(process.pid), "utf8");
    return { root, socketPath };
  };

  it("registerRunningSocket creates a symlink under ~/.murmuration/sockets/", async () => {
    const { registerRunningSocket } = await loadModule();
    const { socketPath } = makeFakeDaemon("ep");
    registerRunningSocket("ep", socketPath);
    const linkPath = join(sandboxHome, ".murmuration", "sockets", "ep.sock");
    expect(existsSync(linkPath)).toBe(true);
  });

  it("listRunningSessions returns registered running daemons", async () => {
    const { registerRunningSocket, listRunningSessions } = await loadModule();
    const a = makeFakeDaemon("alpha");
    const b = makeFakeDaemon("beta");
    registerRunningSocket("alpha", a.socketPath);
    registerRunningSocket("beta", b.socketPath);

    const sessions = await listRunningSessions();
    expect(sessions.map((s) => s.name).sort()).toEqual(["alpha", "beta"]);
    expect(sessions[0]!.root).toBe(a.root);
    expect(sessions[0]!.running).toBe(true);
  });

  it("prunes stale entries when the PID is not alive", async () => {
    const { registerRunningSocket, listRunningSessions } = await loadModule();
    const { root, socketPath } = makeFakeDaemon("dead");
    registerRunningSocket("dead", socketPath);
    // Overwrite pid with one that's very unlikely to be alive
    writeFileSync(join(root, ".murmuration", "daemon.pid"), "999999999", "utf8");

    const sessions = await listRunningSessions();
    expect(sessions.map((s) => s.name)).not.toContain("dead");

    // Symlink was pruned
    const linkPath = join(sandboxHome, ".murmuration", "sockets", "dead.sock");
    expect(existsSync(linkPath)).toBe(false);
  });

  it("unregisterRunningSocket removes the symlink", async () => {
    const { registerRunningSocket, unregisterRunningSocket } = await loadModule();
    const { socketPath } = makeFakeDaemon("one");
    registerRunningSocket("one", socketPath);
    const linkPath = join(sandboxHome, ".murmuration", "sockets", "one.sock");
    expect(existsSync(linkPath)).toBe(true);

    unregisterRunningSocket("one");
    expect(existsSync(linkPath)).toBe(false);
  });

  it("registering over an existing symlink replaces it", async () => {
    const { registerRunningSocket, listRunningSessions } = await loadModule();
    const first = makeFakeDaemon("same");
    const second = makeFakeDaemon("same-v2");
    registerRunningSocket("same", first.socketPath);
    registerRunningSocket("same", second.socketPath);

    const sessions = await listRunningSessions();
    expect(sessions.find((s) => s.name === "same")?.root).toBe(second.root);
  });

  it("returns empty array when the sockets dir doesn't exist", async () => {
    const { listRunningSessions } = await loadModule();
    const socketsDir = join(sandboxHome, ".murmuration", "sockets");
    if (existsSync(socketsDir)) rmSync(socketsDir, { recursive: true });
    const sessions = await listRunningSessions();
    expect(sessions).toEqual([]);
  });

  it("prunes broken symlinks (target removed under us)", async () => {
    const { listRunningSessions } = await loadModule();
    const socketsDir = join(sandboxHome, ".murmuration", "sockets");
    mkdirSync(socketsDir, { recursive: true });
    const broken = join(socketsDir, "broken.sock");
    symlinkSync("/nonexistent/path/daemon.sock", broken);

    const sessions = await listRunningSessions();
    expect(sessions).toEqual([]);
    // Side-effect: broken symlink pruned
    expect(existsSync(broken)).toBe(false);
  });
});
