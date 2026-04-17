/**
 * Extension loader tests (ADR-0023).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadExtensions } from "./loader.js";

let extDir: string;
let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "ext-test-"));
  extDir = join(rootDir, "extensions");
  await mkdir(extDir, { recursive: true });
});

afterEach(async () => {
  if (rootDir) await rm(rootDir, { recursive: true, force: true });
});

const writeExtension = async (
  name: string,
  manifest: Record<string, unknown>,
  entryCode: string,
): Promise<void> => {
  const dir = join(extDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "openclaw.plugin.json"), JSON.stringify(manifest), "utf8");
  await writeFile(join(dir, "index.mjs"), entryCode, "utf8");
};

describe("loadExtensions", () => {
  it("returns empty array when extensions/ directory does not exist", async () => {
    const result = await loadExtensions("/tmp/__nonexistent__", rootDir);
    expect(result).toEqual([]);
  });

  it("returns empty array when extensions/ is empty", async () => {
    const result = await loadExtensions(extDir, rootDir);
    expect(result).toEqual([]);
  });

  it("loads a valid extension with manifest and entry point", async () => {
    await writeExtension(
      "test-ext",
      { id: "test-ext", contracts: { tools: ["my_tool"] } },
      `export default {
        id: "test-ext",
        name: "Test Extension",
        description: "A test",
        register(api) {
          api.registerTool({
            name: "my_tool",
            description: "A test tool",
            parameters: {},
            execute: async () => "result",
          });
        },
      };`,
    );

    const result = await loadExtensions(extDir, rootDir);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("test-ext");
    expect(result[0]!.tools).toHaveLength(1);
    expect(result[0]!.tools[0]!.name).toBe("my_tool");
  });

  it("skips directories without openclaw.plugin.json", async () => {
    const dir = join(extDir, "no-manifest");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "index.mjs"), "export default {};", "utf8");

    const result = await loadExtensions(extDir, rootDir);
    expect(result).toEqual([]);
  });

  it("skips extensions with invalid JSON manifest", async () => {
    const dir = join(extDir, "bad-json");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "openclaw.plugin.json"), "not json{{{", "utf8");
    await writeFile(join(dir, "index.mjs"), "export default {};", "utf8");

    const result = await loadExtensions(extDir, rootDir);
    expect(result).toEqual([]);
  });

  it("skips extensions without entry point", async () => {
    const dir = join(extDir, "no-entry");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "openclaw.plugin.json"), JSON.stringify({ id: "no-entry" }), "utf8");

    const result = await loadExtensions(extDir, rootDir);
    expect(result).toEqual([]);
  });

  it("skips extensions with missing required env vars", async () => {
    await writeExtension(
      "needs-key",
      {
        id: "needs-key",
        providerAuthEnvVars: { provider: ["NONEXISTENT_KEY_12345"] },
      },
      `export default {
        id: "needs-key",
        name: "Needs Key",
        description: "Requires a key",
        register() {},
      };`,
    );

    const result = await loadExtensions(extDir, rootDir);
    expect(result).toEqual([]);
  });

  it("loads extensions without providerAuthEnvVars (no key required)", async () => {
    await writeExtension(
      "keyless",
      { id: "keyless" },
      `export default {
        id: "keyless",
        name: "Keyless",
        description: "No key needed",
        register(api) {
          api.registerTool({
            name: "free_tool",
            description: "Free",
            parameters: {},
            execute: async () => "free",
          });
        },
      };`,
    );

    const result = await loadExtensions(extDir, rootDir);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("keyless");
  });

  it("passes rootDir and getSecret via the plugin API", async () => {
    await writeExtension(
      "api-test",
      { id: "api-test" },
      `export default {
        id: "api-test",
        name: "API Test",
        description: "Tests API",
        register(api) {
          globalThis.__capturedRootDir = api.rootDir;
          globalThis.__capturedSecret = api.getSecret("PATH");
        },
      };`,
    );

    await loadExtensions(extDir, rootDir);
    // @ts-expect-error — global test value
    expect(globalThis.__capturedRootDir).toBe(rootDir);
    // @ts-expect-error — global test value
    expect(globalThis.__capturedSecret).toBeTruthy(); // PATH is always set
  });

  it("skips non-directory entries in extensions/", async () => {
    await writeFile(join(extDir, "not-a-dir.txt"), "hello", "utf8");
    const result = await loadExtensions(extDir, rootDir);
    expect(result).toEqual([]);
  });
});
