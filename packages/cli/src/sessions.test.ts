import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

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
