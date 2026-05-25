import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyFixes, classifyStaleIssues, runDoctor } from "./doctor.js";

describe("runDoctor (v0.5.0 Milestone 3)", () => {
  let rootDir = "";

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "doctor-"));
  });

  afterEach(async () => {
    if (rootDir) await rm(rootDir, { recursive: true, force: true });
  });

  const writeFile2 = async (relPath: string, content: string): Promise<void> => {
    const full = join(rootDir, relPath);
    const dir = full.substring(0, full.lastIndexOf("/"));
    await mkdir(dir, { recursive: true });
    await writeFile(full, content, "utf8");
  };

  const writeHealthy = async (): Promise<void> => {
    await writeFile2(
      "murmuration/harness.yaml",
      `llm:\n  provider: "gemini"\ncollaboration:\n  provider: local\n`,
    );
    await writeFile2("murmuration/soul.md", "# soul\n");
    await writeFile2("murmuration/default-agent/soul.md", "# default soul\n");
    await writeFile2("murmuration/default-agent/role.md", "---\n---\n# default role\n");
    await writeFile2("agents/worker/role.md", `---\nllm:\n  provider: gemini\n---\nbody\n`);
    await writeFile2("agents/worker/soul.md", "# soul\n");
    await writeFile2(".gitignore", ".env\n.env.*\n!.env.example\n.murmuration/\n");
    await writeFile2(".env", "GEMINI_API_KEY=AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXXX123\n");
    await chmod(join(rootDir, ".env"), 0o600);
  };

  it("healthy murmuration: 0 errors", async () => {
    await writeHealthy();
    const report = await runDoctor({ rootDir });
    const errors = report.findings.filter((f) => f.severity === "error");
    expect(errors).toEqual([]);
  });

  it("reports missing murmuration/ and agents/", async () => {
    const report = await runDoctor({ rootDir });
    const ids = report.findings.map((f) => f.checkId);
    expect(ids).toContain("layout.murmuration.missing");
    expect(ids).toContain("layout.agents.missing");
  });

  it("reports .env missing as a secrets error", async () => {
    await writeHealthy();
    await rm(join(rootDir, ".env"));
    const report = await runDoctor({ rootDir });
    const ids = report.findings.map((f) => f.checkId);
    expect(ids).toContain("secrets.env.missing");
  });

  it("reports unset provider key in .env", async () => {
    await writeHealthy();
    await writeFile2(".env", "GEMINI_API_KEY=your-api-key-here\n");
    await chmod(join(rootDir, ".env"), 0o600);
    const report = await runDoctor({ rootDir });
    const ids = report.findings.map((f) => f.checkId);
    expect(ids).toContain("secrets.env.GEMINI_API_KEY.missing");
  });

  it("warns when .env is not 0600", async () => {
    await writeHealthy();
    await chmod(join(rootDir, ".env"), 0o644);
    const report = await runDoctor({ rootDir });
    const ids = report.findings.map((f) => f.checkId);
    expect(ids).toContain("layout.env.mode");
  });

  it("flags schema errors in role.md (bad model_tier)", async () => {
    await writeHealthy();
    await writeFile2("agents/broken/role.md", `---\nmodel_tier: galactic\n---\nbody\n`);
    await writeFile2("agents/broken/soul.md", "# soul\n");
    const report = await runDoctor({ rootDir });
    const titles = report.findings.map((f) => f.title);
    expect(titles.some((t) => t.includes("broken/role.md") && t.includes("model_tier"))).toBe(true);
  });

  it("flags group members that don't match an agent dir", async () => {
    await writeHealthy();
    await writeFile2(
      "governance/groups/example.md",
      `# Example\n\n## Members\n\n- nonexistent-agent\n\nfacilitator: nonexistent-agent\n`,
    );
    const report = await runDoctor({ rootDir });
    const ids = report.findings.map((f) => f.checkId);
    expect(ids.some((id) => id.includes("unknown-member"))).toBe(true);
    expect(ids.some((id) => id.includes("facilitator-missing"))).toBe(true);
  });

  it("--fix auto-chmod .env to 0600", async () => {
    await writeHealthy();
    await chmod(join(rootDir, ".env"), 0o644);
    const report = await runDoctor({ rootDir });
    await applyFixes(report);
    const retry = await runDoctor({ rootDir });
    const ids = retry.findings.map((f) => f.checkId);
    expect(ids).not.toContain("layout.env.mode");
  });

  it("flags missing relative-path governance plugin as error (Milestone 4.6)", async () => {
    await writeHealthy();
    // Overwrite harness.yaml to reference a nonexistent plugin
    await writeFile2(
      "murmuration/harness.yaml",
      `llm:\n  provider: "gemini"\ngovernance:\n  model: self-organizing\n  plugin: "./murmuration/governance-s3/index.mjs"\ncollaboration:\n  provider: local\n`,
    );
    const report = await runDoctor({ rootDir });
    const ids = report.findings.map((f) => f.checkId);
    expect(ids).toContain("governance.plugin-unresolvable");
  });

  it("accepts bundled `plugin: s3` without flagging (Milestone 4.7)", async () => {
    await writeHealthy();
    await writeFile2(
      "murmuration/harness.yaml",
      `llm:\n  provider: "gemini"\ngovernance:\n  model: self-organizing\n  plugin: "s3"\ncollaboration:\n  provider: local\n`,
    );
    const report = await runDoctor({ rootDir });
    const ids = report.findings.map((f) => f.checkId);
    expect(ids).not.toContain("governance.plugin-unresolvable");
  });

  it("--fix rewrites unresolvable governance plugin to bundled s3 (Milestone 4.7)", async () => {
    await writeHealthy();
    // Simulate EP's pre-v0.5 state: plugin: s3 looked like a placeholder
    // but v0.5.0 makes s3 a bundled alias, so this particular case works.
    // Use an actually-bogus name to exercise --fix.
    await writeFile2(
      "murmuration/harness.yaml",
      `llm:\n  provider: "gemini"\ngovernance:\n  model: self-organizing\n  plugin: "bogus-not-a-real-plugin"\ncollaboration:\n  provider: local\n`,
    );
    const report = await runDoctor({ rootDir });
    expect(
      report.findings.find((f) => f.checkId === "governance.plugin-unresolvable"),
    ).toBeDefined();
    await applyFixes(report);
    const content = await import("node:fs/promises").then((m) =>
      m.readFile(join(rootDir, "murmuration", "harness.yaml"), "utf8"),
    );
    expect(content).toContain('plugin: "s3"');
    const retry = await runDoctor({ rootDir });
    const retryIds = retry.findings.map((f) => f.checkId);
    expect(retryIds).not.toContain("governance.plugin-unresolvable");
  });

  it("live category is skipped by default", async () => {
    await writeHealthy();
    const report = await runDoctor({ rootDir });
    expect(report.skipped).toContain("live");
  });

  it("hygiene category is skipped by default and listed under --live (harness#394)", async () => {
    await writeHealthy();
    const reportNoLive = await runDoctor({ rootDir });
    expect(reportNoLive.skipped).toContain("hygiene");
    // Local-only collaboration: even with --live, no network call should fire
    // and no hygiene findings should be emitted. Test confirms graceful no-op.
    const reportLive = await runDoctor({ rootDir, live: true });
    expect(reportLive.skipped).not.toContain("hygiene");
    expect(reportLive.findings.filter((f) => f.category === "hygiene")).toEqual([]);
  });
});

describe("classifyStaleIssues (harness#394 scope 1)", () => {
  const NOW = new Date("2026-05-25T12:00:00Z");
  const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);

  it("flags issues older than 14d with no comment activity in 7d", () => {
    const result = classifyStaleIssues(
      [
        {
          number: 1,
          title: "Ancient stale issue",
          htmlUrl: "https://example/1",
          createdAt: daysAgo(30),
          updatedAt: daysAgo(10),
        },
        {
          number: 2,
          title: "Old but recently commented",
          htmlUrl: "https://example/2",
          createdAt: daysAgo(30),
          updatedAt: daysAgo(2),
        },
        {
          number: 3,
          title: "Brand new",
          htmlUrl: "https://example/3",
          createdAt: daysAgo(1),
          updatedAt: daysAgo(1),
        },
      ],
      NOW,
    );
    expect(result.byAge.map((i) => i.number)).toEqual([1]);
  });

  it("flags digest-pattern titles regardless of age", () => {
    const result = classifyStaleIssues(
      [
        {
          number: 10,
          title: "[FINANCE] Weekly burn 2026-05-25",
          htmlUrl: "https://example/10",
          createdAt: daysAgo(1),
          updatedAt: daysAgo(1),
        },
        {
          number: 11,
          title: "DIGEST: catch-up",
          htmlUrl: "https://example/11",
          createdAt: daysAgo(1),
          updatedAt: daysAgo(1),
        },
        {
          number: 12,
          title: "Implement feature X",
          htmlUrl: "https://example/12",
          createdAt: daysAgo(1),
          updatedAt: daysAgo(1),
        },
        {
          number: 13,
          title: "[Status] Sprint update",
          htmlUrl: "https://example/13",
          createdAt: daysAgo(1),
          updatedAt: daysAgo(1),
        },
      ],
      NOW,
    );
    expect(result.byDigestPattern.map((i) => i.number).sort((a, b) => a - b)).toEqual([10, 11, 13]);
  });

  it("issue can appear in both buckets when stale AND digest-patterned", () => {
    const result = classifyStaleIssues(
      [
        {
          number: 20,
          title: "[DIGEST] 2026-02 monthly",
          htmlUrl: "https://example/20",
          createdAt: daysAgo(90),
          updatedAt: daysAgo(45),
        },
      ],
      NOW,
    );
    expect(result.byAge.map((i) => i.number)).toEqual([20]);
    expect(result.byDigestPattern.map((i) => i.number)).toEqual([20]);
  });
});
