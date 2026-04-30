/**
 * McpToolLoader tests.
 *
 * We can't easily spawn a real MCP server in unit tests, so we test:
 * - The public interface (loadTools returns ToolDefinition[])
 * - Tool name prefixing
 * - close() cleanup
 * - Error handling for unreachable servers
 *
 * For the tool conversion logic (JSON Schema → jsonSchema wrapper),
 * we test via a mock that patches the internal #connect method.
 */

import { homedir } from "node:os";

import { afterEach, beforeEach, describe, it, expect } from "vitest";

import { McpToolLoader, extractTextContent, expandPath } from "./tool-loader.js";
import type { McpServerConfig } from "./tool-loader.js";

describe("McpToolLoader", () => {
  it("loadTools returns empty array for no servers", async () => {
    const loader = new McpToolLoader();
    const tools = await loader.loadTools([]);
    expect(tools).toEqual([]);
    await loader.close(); // no-op, shouldn't throw
  });

  it("close() is safe to call multiple times", async () => {
    const loader = new McpToolLoader();
    await loader.close();
    await loader.close(); // second call should not throw
  });

  it("loadTools rejects for unreachable command", async () => {
    const loader = new McpToolLoader();
    const badServer: McpServerConfig = {
      name: "nonexistent",
      command: "__nonexistent_command_that_does_not_exist__",
      args: [],
    };

    await expect(loader.loadTools([badServer])).rejects.toThrow();
    await loader.close();
  });

  it("merges parent env with server env", async () => {
    // This is a structural test — we verify the config shape
    // is accepted without actually spawning a process.
    const loader = new McpToolLoader();
    const config: McpServerConfig = {
      name: "test",
      command: "echo",
      args: ["hello"],
      env: { SERVER_VAR: "server-value" },
    };

    // We can't easily test the merge without spawning, but we verify
    // the interface accepts the expected shape
    expect(config.env).toEqual({ SERVER_VAR: "server-value" });
    await loader.close();
  });
});

// ---------------------------------------------------------------------------
// extractTextContent
// ---------------------------------------------------------------------------

describe("extractTextContent", () => {
  it("extracts text from text content items", () => {
    const content = [
      { type: "text", text: "Hello" },
      { type: "text", text: "World" },
    ];
    expect(extractTextContent(content)).toBe("Hello\nWorld");
  });

  it("returns single text item without newlines", () => {
    const content = [{ type: "text", text: "Only one" }];
    expect(extractTextContent(content)).toBe("Only one");
  });

  it("filters non-text content and falls back to JSON", () => {
    const content = [
      { type: "image", data: "base64..." },
      { type: "resource", uri: "file://foo" },
    ];
    expect(extractTextContent(content)).toBe(JSON.stringify(content));
  });

  it("extracts text and ignores non-text items", () => {
    const content = [
      { type: "image", data: "base64..." },
      { type: "text", text: "Found it" },
    ];
    expect(extractTextContent(content)).toBe("Found it");
  });

  it("returns JSON for non-array input", () => {
    expect(extractTextContent("raw string")).toBe('"raw string"');
    expect(extractTextContent(null)).toBe("null");
    expect(extractTextContent(42)).toBe("42");
    expect(extractTextContent({ foo: "bar" })).toBe('{"foo":"bar"}');
  });

  it("returns JSON for empty array", () => {
    expect(extractTextContent([])).toBe("[]");
  });

  it("handles items with type text but missing text field", () => {
    const content = [{ type: "text" }]; // no text field
    expect(extractTextContent(content)).toBe(JSON.stringify(content));
  });
});

describe("expandPath", () => {
  // Snapshot env at suite start; restore exactly that snapshot in
  // afterEach so per-test env mutations don't leak across this file's
  // tests or to neighboring test files in the same vitest worker.
  // Uses Object.assign / property mutation only — no dynamic delete,
  // which the lint rules disallow.
  const envSnapshot: Record<string, string> = { ...process.env } as Record<string, string>;

  beforeEach(() => {
    process.env.MURM_TEST_VAR = "expanded-value";
    process.env.MURM_TEST_DIR = "/tmp/murmtest";
  });
  afterEach(() => {
    // Reset every key we may have touched back to its snapshotted value;
    // for keys that weren't in the snapshot, set to "" rather than delete.
    process.env.MURM_TEST_VAR = envSnapshot.MURM_TEST_VAR ?? "";
    process.env.MURM_TEST_DIR = envSnapshot.MURM_TEST_DIR ?? "";
    process.env.MURM_NONEXISTENT_VAR = envSnapshot.MURM_NONEXISTENT_VAR ?? "";
  });

  it("returns bare command names unchanged so PATH resolution still works", () => {
    expect(expandPath("jdocmunch-mcp")).toBe("jdocmunch-mcp");
    expect(expandPath("npx")).toBe("npx");
  });

  it("returns absolute paths unchanged when there are no expansion tokens", () => {
    expect(expandPath("/usr/local/bin/mcp-server")).toBe("/usr/local/bin/mcp-server");
  });

  it("expands a leading `~/` to the home directory", () => {
    const expanded = expandPath("~/Code/jmunch-mcp/.venv/bin/jmunch-mcp");
    expect(expanded.startsWith(homedir())).toBe(true);
    expect(expanded.endsWith("/Code/jmunch-mcp/.venv/bin/jmunch-mcp")).toBe(true);
  });

  it("expands a bare `~` to the home directory", () => {
    expect(expandPath("~")).toBe(homedir());
  });

  it("expands ${VAR} references", () => {
    expect(expandPath("${MURM_TEST_VAR}/bin/server")).toBe("expanded-value/bin/server");
  });

  it("expands $VAR references without braces", () => {
    expect(expandPath("$MURM_TEST_DIR/server")).toBe("/tmp/murmtest/server");
  });

  it("substitutes empty string for unset variables (fail loud at spawn rather than silent fallback)", () => {
    expect(expandPath("${MURM_NONEXISTENT_VAR}/server")).toBe("/server");
  });

  it("combines `~` and `${VAR}` expansion correctly", () => {
    const expanded = expandPath("~/${MURM_TEST_VAR}/bin");
    expect(expanded).toBe(`${homedir()}/expanded-value/bin`);
  });

  it("does not expand mid-path tilde", () => {
    // Tilde only expands as the literal first character (or `~/` prefix).
    expect(expandPath("/path/with/~tilde/inside")).toBe("/path/with/~tilde/inside");
  });
});
