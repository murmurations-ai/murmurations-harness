import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { copyFacilitatorAgent, detectExistingState } from "./init.js";

describe("detectExistingState (v0.5.0 Milestone 2)", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "init-state-"));
  });

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("returns empty-or-missing for a nonexistent path", () => {
    const result = detectExistingState(join(dir, "does-not-exist"));
    expect(result.kind).toBe("empty-or-missing");
  });

  it("returns empty-or-missing for an empty directory", () => {
    const result = detectExistingState(dir);
    expect(result.kind).toBe("empty-or-missing");
  });

  it("returns current when both murmuration/ and agents/ exist (ADR-0026)", async () => {
    await mkdir(join(dir, "murmuration"), { recursive: true });
    await mkdir(join(dir, "agents"), { recursive: true });
    const result = detectExistingState(dir);
    expect(result.kind).toBe("current");
    expect(result.signals).toEqual(
      expect.arrayContaining([
        expect.stringContaining("murmuration/"),
        expect.stringContaining("agents/"),
      ]),
    );
  });

  it("returns partial when murmuration/ exists but agents/ doesn't", async () => {
    await mkdir(join(dir, "murmuration"), { recursive: true });
    const result = detectExistingState(dir);
    expect(result.kind).toBe("partial");
    expect(result.signals.some((s) => s.includes("murmuration/"))).toBe(true);
  });

  it("returns partial when agents/ exists but murmuration/ doesn't", async () => {
    await mkdir(join(dir, "agents"), { recursive: true });
    const result = detectExistingState(dir);
    expect(result.kind).toBe("partial");
  });
});

// ---------------------------------------------------------------------------
// v0.7.0 Workstream I — facilitator-agent auto-include
// ---------------------------------------------------------------------------

describe("copyFacilitatorAgent (Workstream I)", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "init-facilitator-"));
  });

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("copies the template into agents/facilitator-agent/ on first call", async () => {
    const result = await copyFacilitatorAgent(dir);
    expect(result.action).toBe("copied");

    // Required files must be present.
    const role = await readFile(join(dir, "agents", "facilitator-agent", "role.md"), "utf8");
    expect(role).toContain('agent_id: "facilitator-agent"');
    expect(role).toContain("accountabilities:");

    const soul = await readFile(join(dir, "agents", "facilitator-agent", "soul.md"), "utf8");
    expect(soul).toContain("Facilitator Agent");

    // Skill files must be present (S3 + 4 stubs).
    const s3Skill = await readFile(
      join(dir, "agents", "facilitator-agent", "skills", "s3-governance.md"),
      "utf8",
    );
    expect(s3Skill).toContain("patterns.sociocracy30.org");
  });

  it("writes the facilitation group context (required by IdentityLoader)", async () => {
    await copyFacilitatorAgent(dir);
    const groupCtx = await readFile(join(dir, "governance", "groups", "facilitation.md"), "utf8");
    expect(groupCtx).toContain("Group: Facilitation");
    expect(groupCtx).toContain("facilitator-agent");
  });

  it("is idempotent — second call skips when target dir exists", async () => {
    await copyFacilitatorAgent(dir);

    // Hand-edit the role.md so we can verify it survives.
    const rolePath = join(dir, "agents", "facilitator-agent", "role.md");
    await writeFile(rolePath, "EDITED BY OPERATOR\n", "utf8");

    const second = await copyFacilitatorAgent(dir);
    expect(second.action).toBe("skipped-existing");

    // Edit must be preserved.
    const role = await readFile(rolePath, "utf8");
    expect(role).toBe("EDITED BY OPERATOR\n");
  });

  it("preserves a Source-edited facilitation group context on re-run", async () => {
    await copyFacilitatorAgent(dir);
    const groupPath = join(dir, "governance", "groups", "facilitation.md");
    await writeFile(groupPath, "OPERATOR-CUSTOMIZED GROUP\n", "utf8");

    // Remove the agent dir to force the copy path again, then verify
    // the existing group file is preserved.
    await rm(join(dir, "agents", "facilitator-agent"), { recursive: true });
    await copyFacilitatorAgent(dir);

    const groupCtx = await readFile(groupPath, "utf8");
    expect(groupCtx).toBe("OPERATOR-CUSTOMIZED GROUP\n");
  });
});
