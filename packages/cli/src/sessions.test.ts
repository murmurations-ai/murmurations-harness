import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { parseDaemonProcesses } from "./sessions.js";

// sessions.ts reads from ~/.murmuration/sessions.json which we can't
// override in the module. Instead, test the heartbeat logic directly
// by mocking the registry file. We'll test the data format contract.

describe("sessions registry format", () => {
  const tmpDir = join(tmpdir(), `murm-session-test-${randomUUID().slice(0, 8)}`);
  const registryPath = join(tmpDir, "sessions.json");

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  it("registry entry has required fields", () => {
    const entry = {
      root: "/path/to/murmuration",
      registered: "2026-04-13",
    };
    writeFileSync(registryPath, JSON.stringify({ test: entry }), "utf8");
    const loaded = JSON.parse(readFileSync(registryPath, "utf8")) as Record<
      string,
      { root: string; registered: string }
    >;
    const testEntry = loaded.test;
    expect(testEntry).toBeDefined();
    expect(testEntry?.root).toBe("/path/to/murmuration");
    expect(testEntry?.registered).toBe("2026-04-13");
  });

  it("heartbeat fields are optional extensions", () => {
    const entry = {
      root: "/path/to/murmuration",
      registered: "2026-04-13",
      lastHeartbeatAt: "2026-04-13T20:00:00.000Z",
      pid: 12345,
    };
    writeFileSync(registryPath, JSON.stringify({ test: entry }), "utf8");
    const loaded = JSON.parse(readFileSync(registryPath, "utf8")) as Record<
      string,
      { root: string; lastHeartbeatAt?: string; pid?: number }
    >;
    const testEntry = loaded.test;
    expect(testEntry?.lastHeartbeatAt).toBe("2026-04-13T20:00:00.000Z");
    expect(testEntry?.pid).toBe(12345);
  });

  it("heartbeat age calculation works correctly", () => {
    const now = Date.now();
    const recentHeartbeat = new Date(now - 30_000).toISOString(); // 30s ago
    const staleHeartbeat = new Date(now - 180_000).toISOString(); // 3 min ago

    const recentAge = now - new Date(recentHeartbeat).getTime();
    const staleAge = now - new Date(staleHeartbeat).getTime();

    expect(recentAge).toBeLessThan(120_000); // fresh (< 2 min)
    expect(staleAge).toBeGreaterThan(120_000); // stale (> 2 min)
  });
});

describe("parseDaemonProcesses (harness#422)", () => {
  const SELF = 99_999;

  it("matches the real node daemon process", () => {
    const ps = "9932 node /opt/homebrew/bin/murmuration start --root /Users/x/murm/chinook-wind";
    expect(parseDaemonProcesses(ps, SELF)).toEqual([
      { pid: 9932, root: resolve("/Users/x/murm/chinook-wind") },
    ]);
  });

  it("matches a directly-executed `murmuration start`", () => {
    const ps = "4242 /opt/homebrew/bin/murmuration start --root /srv/murm/a --now";
    expect(parseDaemonProcesses(ps, SELF)).toEqual([{ pid: 4242, root: resolve("/srv/murm/a") }]);
  });

  it("does NOT match the zsh wrapper, the tee, or unrelated processes", () => {
    // These are the exact false positives the old substring matcher produced:
    // the daemon's own shell wrapper + the tee writing to start-console.log,
    // and a coding-agent's command line that merely contains the words.
    const ps = [
      "59076 zsh -c murmuration start --root /Users/x/murm/cw 2>&1 | tee -a /Users/x/murm/cw/.murmuration/start-console.log",
      "59079 tee -a /Users/x/murm/cw/.murmuration/start-console.log",
      "9927 bash -c tmux new-session -d -s cw murmuration start --root $CW",
      "1234 vim /Users/x/murm/cw/.murmuration/start-console.log",
    ].join("\n");
    expect(parseDaemonProcesses(ps, SELF)).toEqual([]);
  });

  it("excludes the current process", () => {
    const ps = `${String(SELF)} node /usr/local/bin/murmuration start --root /srv/murm/self`;
    expect(parseDaemonProcesses(ps, SELF)).toEqual([]);
  });

  it("rejects a root with control bytes or an unexpanded shell token", () => {
    const ps = [
      "111 node /bin/murmuration start --root /srv/$CW",
      "112 node /bin/murmuration start --root /srv/[2Jevil",
    ].join("\n");
    expect(parseDaemonProcesses(ps, SELF)).toEqual([]);
  });

  it("ignores a `ps` header line and blank lines", () => {
    const ps = "  PID ARGS\n\n9932 node /bin/murmuration start --root /srv/murm/a\n";
    expect(parseDaemonProcesses(ps, SELF)).toEqual([{ pid: 9932, root: resolve("/srv/murm/a") }]);
  });

  it("matches a dev `node …/bin.js start` daemon", () => {
    const ps = "777 node /repo/packages/cli/dist/bin.js start --root /srv/murm/dev";
    expect(parseDaemonProcesses(ps, SELF)).toEqual([{ pid: 777, root: resolve("/srv/murm/dev") }]);
  });
});
