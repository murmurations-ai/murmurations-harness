/**
 * Harness config loader tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadHarnessConfig, mergeWithCliFlags } from "./harness-config.js";

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "config-test-"));
  await mkdir(join(rootDir, "murmuration"), { recursive: true });
});

afterEach(async () => {
  if (rootDir) await rm(rootDir, { recursive: true, force: true });
});

describe("loadHarnessConfig", () => {
  it("returns defaults when harness.yaml does not exist", async () => {
    const config = await loadHarnessConfig(rootDir);
    expect(config.governance.plugin).toBeUndefined();
    expect(config.collaboration.provider).toBe("github");
    expect(config.collaboration.repo).toBeUndefined();
    expect(config.products).toEqual([]);
    expect(config.logging.level).toBe("info");
  });

  it("loads all fields from a complete harness.yaml", async () => {
    await writeFile(
      join(rootDir, "murmuration", "harness.yaml"),
      `governance:
  plugin: "./governance-s3/index.mjs"

collaboration:
  provider: "local"
  repo: "my-org/my-murmuration"

products:
  - name: harness
    repo: "my-org/harness"
  - name: website
    repo: "my-org/site"

logging:
  level: "debug"
`,
      "utf8",
    );

    const config = await loadHarnessConfig(rootDir);
    expect(config.governance.plugin).toBe("./governance-s3/index.mjs");
    expect(config.collaboration.provider).toBe("local");
    expect(config.collaboration.repo).toBe("my-org/my-murmuration");
    expect(config.products).toHaveLength(2);
    expect(config.products[0]!.name).toBe("harness");
    expect(config.products[1]!.repo).toBe("my-org/site");
    expect(config.logging.level).toBe("debug");
  });

  it("fills defaults for missing fields", async () => {
    await writeFile(
      join(rootDir, "murmuration", "harness.yaml"),
      `governance:
  plugin: "./my-plugin.mjs"
`,
      "utf8",
    );

    const config = await loadHarnessConfig(rootDir);
    expect(config.governance.plugin).toBe("./my-plugin.mjs");
    expect(config.collaboration.provider).toBe("github");
    expect(config.logging.level).toBe("info");
  });

  it("returns defaults for invalid YAML", async () => {
    await writeFile(
      join(rootDir, "murmuration", "harness.yaml"),
      "{{{{ not valid yaml !!!!",
      "utf8",
    );

    const config = await loadHarnessConfig(rootDir);
    expect(config.collaboration.provider).toBe("github");
  });

  it("validates collaboration.provider enum", async () => {
    await writeFile(
      join(rootDir, "murmuration", "harness.yaml"),
      `collaboration:
  provider: "invalid-provider"
`,
      "utf8",
    );

    const config = await loadHarnessConfig(rootDir);
    expect(config.collaboration.provider).toBe("github"); // default
  });

  it("validates logging.level enum", async () => {
    await writeFile(
      join(rootDir, "murmuration", "harness.yaml"),
      `logging:
  level: "trace"
`,
      "utf8",
    );

    const config = await loadHarnessConfig(rootDir);
    expect(config.logging.level).toBe("info"); // default
  });

  it("skips invalid product entries", async () => {
    await writeFile(
      join(rootDir, "murmuration", "harness.yaml"),
      `products:
  - name: "valid"
    repo: "org/repo"
  - "just a string"
  - name: "missing-repo"
`,
      "utf8",
    );

    const config = await loadHarnessConfig(rootDir);
    expect(config.products).toHaveLength(1);
    expect(config.products[0]!.name).toBe("valid");
  });
});

describe("mergeWithCliFlags", () => {
  it("CLI flags override config values", () => {
    const config = {
      governance: { plugin: "from-config" },
      collaboration: { provider: "github" as const, repo: "org/repo" },
      products: [],
      logging: { level: "info" as const },
    };

    const merged = mergeWithCliFlags(config, {
      governancePath: "from-cli",
      collaboration: "local",
      logLevel: "debug",
    });

    expect(merged.governance.plugin).toBe("from-cli");
    expect(merged.collaboration.provider).toBe("local");
    expect(merged.logging.level).toBe("debug");
  });

  it("config values preserved when CLI flags are not set", () => {
    const config = {
      governance: { plugin: "from-config" },
      collaboration: { provider: "local" as const, repo: "org/repo" },
      products: [],
      logging: { level: "warn" as const },
    };

    const merged = mergeWithCliFlags(config, {});

    expect(merged.governance.plugin).toBe("from-config");
    expect(merged.collaboration.provider).toBe("local");
    expect(merged.logging.level).toBe("warn");
  });

  it("preserves products and collaboration.repo from config", () => {
    const config = {
      governance: { plugin: undefined },
      collaboration: { provider: "github" as const, repo: "my/repo" },
      products: [{ name: "p", repo: "o/r" }],
      logging: { level: "info" as const },
    };

    const merged = mergeWithCliFlags(config, { logLevel: "debug" });

    expect(merged.collaboration.repo).toBe("my/repo");
    expect(merged.products).toHaveLength(1);
  });
});
