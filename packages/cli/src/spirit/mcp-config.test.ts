import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeSpiritMcpConfig } from "./mcp-config.js";

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

  it("encodes the rootDir in the spawned MCP server's MURMURATION_ROOT env (D1: not in argv)", () => {
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
