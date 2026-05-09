import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  writeSpiritMcpConfig,
  writeEphemeralSpiritMcpConfig,
  sweepOrphanedSpiritMcpConfigs,
} from "./mcp-config.js";

describe("writeSpiritMcpConfig", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "mcp-config-test-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("writes a valid MCP config file under <rootDir>/.murmuration/spirit-mcp.json", () => {
    const path = writeSpiritMcpConfig(tmpRoot);

    expect(path).toBe(join(tmpRoot, ".murmuration", "spirit-mcp.json"));
    expect(existsSync(path)).toBe(true);

    const content = JSON.parse(readFileSync(path, "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };

    expect(content.mcpServers["murmuration-spirit"]).toBeDefined();
    expect(content.mcpServers["murmuration-spirit"]?.command).toBe("node");
    expect(content.mcpServers["murmuration-spirit"]?.args).toHaveLength(1);
    expect(content.mcpServers["murmuration-spirit"]?.args[0]).toMatch(/mcp-bin\.js$/);
    expect(content.mcpServers["murmuration-spirit"]?.env).toEqual({
      MURMURATION_ROOT: tmpRoot,
    });
  });

  it("creates the .murmuration directory if it does not exist", () => {
    const configDir = join(tmpRoot, ".murmuration");
    expect(existsSync(configDir)).toBe(false);

    writeSpiritMcpConfig(tmpRoot);

    expect(existsSync(configDir)).toBe(true);
  });

  it("is idempotent — overwrites the file on each call (config is a pure function of rootDir)", () => {
    const first = writeSpiritMcpConfig(tmpRoot);
    const firstContent = readFileSync(first, "utf8");
    const second = writeSpiritMcpConfig(tmpRoot);
    const secondContent = readFileSync(second, "utf8");

    expect(first).toBe(second);
    expect(firstContent).toBe(secondContent);
  });

  it("encodes the rootDir in the spawned MCP server's MURMURATION_ROOT env (D1: not in argv — harness#278)", () => {
    // ADR-0034 D1: prompt content + sensitive paths must never appear in
    // argv. The rootDir is sensitive (operator's home path) so it goes
    // through env, not argv. Verifies the config never serializes
    // rootDir into args[].
    const path = writeSpiritMcpConfig(tmpRoot);
    const content = JSON.parse(readFileSync(path, "utf8")) as {
      mcpServers: Record<string, { args: string[]; env: Record<string, string> }>;
    };
    const args = content.mcpServers["murmuration-spirit"]?.args ?? [];
    for (const arg of args) {
      expect(arg).not.toContain(tmpRoot);
    }
    expect(content.mcpServers["murmuration-spirit"]?.env.MURMURATION_ROOT).toBe(tmpRoot);
  });
});

// ---------------------------------------------------------------------------
// writeEphemeralSpiritMcpConfig + sweepOrphanedSpiritMcpConfigs (CF-F / harness#278)
// ---------------------------------------------------------------------------

describe("writeEphemeralSpiritMcpConfig", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "mcp-ephemeral-test-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("writes a spirit-mcp-<uuid>.json file under .murmuration/", () => {
    const { configPath } = writeEphemeralSpiritMcpConfig(tmpRoot);
    expect(configPath).toMatch(/spirit-mcp-[0-9a-f-]+\.json$/);
    expect(existsSync(configPath)).toBe(true);
  });

  it("writes a valid MCP config with murmuration-spirit server", () => {
    const { configPath } = writeEphemeralSpiritMcpConfig(tmpRoot);
    const content = JSON.parse(readFileSync(configPath, "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };
    expect(content.mcpServers["murmuration-spirit"]).toBeDefined();
    expect(content.mcpServers["murmuration-spirit"]?.command).toBe("node");
    expect(content.mcpServers["murmuration-spirit"]?.env.MURMURATION_ROOT).toBe(tmpRoot);
  });

  it("each call produces a distinct file (no collision between concurrent attaches)", () => {
    const { configPath: a } = writeEphemeralSpiritMcpConfig(tmpRoot);
    const { configPath: b } = writeEphemeralSpiritMcpConfig(tmpRoot);
    expect(a).not.toBe(b);
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);
  });

  it("cleanup() deletes the file", () => {
    const { configPath, cleanup } = writeEphemeralSpiritMcpConfig(tmpRoot);
    expect(existsSync(configPath)).toBe(true);
    cleanup();
    expect(existsSync(configPath)).toBe(false);
  });

  it("cleanup() is idempotent — second call does not throw", () => {
    const { cleanup } = writeEphemeralSpiritMcpConfig(tmpRoot);
    cleanup();
    expect(() => cleanup()).not.toThrow();
  });
});

describe("sweepOrphanedSpiritMcpConfigs", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "mcp-sweep-test-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("removes all spirit-mcp-*.json orphan files", () => {
    const { configPath: a } = writeEphemeralSpiritMcpConfig(tmpRoot);
    const { configPath: b } = writeEphemeralSpiritMcpConfig(tmpRoot);
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);

    sweepOrphanedSpiritMcpConfigs(tmpRoot);

    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
  });

  it("does not remove spirit-mcp.json (the legacy persistent config)", () => {
    const persistentPath = writeSpiritMcpConfig(tmpRoot);
    sweepOrphanedSpiritMcpConfigs(tmpRoot);
    expect(existsSync(persistentPath)).toBe(true);
  });

  it("does not remove unrelated files in .murmuration/", () => {
    const configDir = join(tmpRoot, ".murmuration");
    mkdirSync(configDir, { recursive: true });
    const keepPath = join(configDir, "harness-state.json");
    writeFileSync(keepPath, "{}", "utf8");

    sweepOrphanedSpiritMcpConfigs(tmpRoot);

    expect(existsSync(keepPath)).toBe(true);
  });

  it("is a no-op when .murmuration/ does not exist", () => {
    expect(() => sweepOrphanedSpiritMcpConfigs(tmpRoot)).not.toThrow();
  });

  it("is a no-op when there are no orphan files", () => {
    writeSpiritMcpConfig(tmpRoot); // only creates spirit-mcp.json, not ephemeral
    sweepOrphanedSpiritMcpConfigs(tmpRoot);
    const files = readdirSync(join(tmpRoot, ".murmuration"));
    expect(files).toContain("spirit-mcp.json");
  });
});
