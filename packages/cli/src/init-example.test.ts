import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const readFileText = (p: string): Promise<string> => readFile(p, "utf8");

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runDoctor } from "./doctor.js";
import { listExamples, runInitFromExample } from "./init.js";

describe("init --example (v0.5.0 Milestone 4)", () => {
  let parent = "";

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), "init-example-"));
  });

  afterEach(async () => {
    if (parent) await rm(parent, { recursive: true, force: true });
  });

  it("lists `hello` among available examples", () => {
    const examples = listExamples();
    expect(examples).toContain("hello-circle");
  });

  it("copies the hello-circle tree into a fresh target", async () => {
    const target = join(parent, "hello-target");
    await runInitFromExample("hello-circle", target);

    expect(existsSync(join(target, "murmuration", "harness.yaml"))).toBe(true);
    expect(existsSync(join(target, "murmuration", "soul.md"))).toBe(true);
    expect(existsSync(join(target, "murmuration", "default-agent", "soul.md"))).toBe(true);
    expect(existsSync(join(target, "murmuration", "default-agent", "role.md"))).toBe(true);
    expect(existsSync(join(target, "agents", "host-agent", "role.md"))).toBe(true);
    expect(existsSync(join(target, "agents", "host-agent", "soul.md"))).toBe(true);
    expect(existsSync(join(target, "agents", "scout-agent", "role.md"))).toBe(true);
    expect(existsSync(join(target, "agents", "scout-agent", "soul.md"))).toBe(true);
    expect(existsSync(join(target, "governance", "groups", "example.md"))).toBe(true);
    expect(existsSync(join(target, ".env.example"))).toBe(true);
    expect(existsSync(join(target, ".gitignore"))).toBe(true);
    expect(existsSync(join(target, "README.md"))).toBe(true);
  });

  it("rejects when target directory already exists with content", async () => {
    const target = join(parent, "not-empty");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(target, "murmuration"), { recursive: true });
    await expect(runInitFromExample("hello-circle", target)).rejects.toThrow(
      /target directory not empty/,
    );
  });

  it("rejects unknown example names", async () => {
    const target = join(parent, "fresh");
    await expect(runInitFromExample("not-a-real-example", target)).rejects.toThrow(
      /unknown example/,
    );
  });

  it("materializes .env from .env.example at 0600 (Milestone 4.5)", async () => {
    const target = join(parent, "hello-env");
    await runInitFromExample("hello-circle", target);

    const { stat } = await import("node:fs/promises");
    const envPath = join(target, ".env");
    expect(existsSync(envPath)).toBe(true);
    const mode = (await stat(envPath)).mode & 0o777;
    expect(mode).toBe(0o600);
    // Placeholder is present (captured only when stdin is TTY — not in tests)
    const envContent = await readFileText(envPath);
    expect(envContent).toContain("GEMINI_API_KEY=");
  });

  it("produces a doctor-clean murmuration after editing .env with a real key", async () => {
    const target = join(parent, "hello-clean");
    await runInitFromExample("hello-circle", target);

    // Operator's paste step: overwrite the placeholder with a real key.
    // Simulates what they'd do in their editor after init.
    await writeFile(
      join(target, ".env"),
      "GEMINI_API_KEY=AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXXX123\n",
      "utf8",
    );
    const { chmod } = await import("node:fs/promises");
    await chmod(join(target, ".env"), 0o600);

    const report = await runDoctor({ rootDir: target });
    const errors = report.findings.filter((f) => f.severity === "error");
    expect(errors).toEqual([]);
  });

  it("default target name is my-<example>-murmuration when targetArg omitted", async () => {
    // Switch cwd to parent so the relative default lands there.
    const origCwd = process.cwd();
    process.chdir(parent);
    try {
      await runInitFromExample("hello-circle", undefined);
      expect(existsSync(join(parent, "my-hello-circle-murmuration"))).toBe(true);
    } finally {
      process.chdir(origCwd);
    }
  });
});
