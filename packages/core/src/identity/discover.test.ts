import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityLoader } from "./index.js";

describe("IdentityLoader.discover()", () => {
  let rootDir = "";

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "murmuration-discover-"));
    await mkdir(join(rootDir, "agents"), { recursive: true });
  });

  afterEach(async () => {
    if (rootDir) await rm(rootDir, { recursive: true, force: true });
  });

  it("discovers agent directories that contain role.md", async () => {
    await mkdir(join(rootDir, "agents", "01-research"), { recursive: true });
    await writeFile(join(rootDir, "agents", "01-research", "role.md"), "---\nagent_id: x\n---\n");
    await mkdir(join(rootDir, "agents", "02-builder"), { recursive: true });
    await writeFile(join(rootDir, "agents", "02-builder", "role.md"), "---\nagent_id: y\n---\n");

    const loader = new IdentityLoader({ rootDir });
    const dirs = await loader.discover();
    expect(dirs).toEqual(["01-research", "02-builder"]);
  });

  it("skips directories without role.md", async () => {
    await mkdir(join(rootDir, "agents", "has-role"), { recursive: true });
    await writeFile(join(rootDir, "agents", "has-role", "role.md"), "---\n---\n");
    await mkdir(join(rootDir, "agents", "no-role"), { recursive: true });
    // no-role has no role.md → skipped

    const loader = new IdentityLoader({ rootDir });
    const dirs = await loader.discover();
    expect(dirs).toEqual(["has-role"]);
  });

  it("returns empty when agents/ directory doesn't exist", async () => {
    await rm(join(rootDir, "agents"), { recursive: true });
    const loader = new IdentityLoader({ rootDir });
    const dirs = await loader.discover();
    expect(dirs).toEqual([]);
  });

  it("returns sorted results", async () => {
    await mkdir(join(rootDir, "agents", "zzz-last"), { recursive: true });
    await writeFile(join(rootDir, "agents", "zzz-last", "role.md"), "x");
    await mkdir(join(rootDir, "agents", "aaa-first"), { recursive: true });
    await writeFile(join(rootDir, "agents", "aaa-first", "role.md"), "x");

    const loader = new IdentityLoader({ rootDir });
    const dirs = await loader.discover();
    expect(dirs).toEqual(["aaa-first", "zzz-last"]);
  });
});
