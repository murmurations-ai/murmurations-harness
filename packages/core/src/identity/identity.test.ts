import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FrontmatterInvalidError,
  IdentityFileMissingError,
  IdentityLoader,
  splitFrontmatter,
} from "./index.js";

describe("splitFrontmatter", () => {
  it("extracts frontmatter and body from a well-formed file", () => {
    const source = `---
agent_id: test
name: Test Agent
---
# Narrative body here

Content.
`;
    const { frontmatter, body } = splitFrontmatter(source);
    expect(frontmatter).toContain("agent_id: test");
    expect(body).toContain("# Narrative body here");
  });

  it("returns null frontmatter when the file has no frontmatter", () => {
    const source = "# Just a title\n\nNo frontmatter.\n";
    const { frontmatter, body } = splitFrontmatter(source);
    expect(frontmatter).toBeNull();
    expect(body).toBe(source);
  });
});

describe("IdentityLoader", () => {
  let rootDir = "";

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "murmuration-identity-"));
  });

  afterEach(async () => {
    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  const writeFixture = async (relativePath: string, content: string): Promise<void> => {
    const full = join(rootDir, relativePath);
    const dir = full.substring(0, full.lastIndexOf("/"));
    await mkdir(dir, { recursive: true });
    await writeFile(full, content, "utf8");
  };

  const writeCompleteFixture = async (): Promise<void> => {
    await writeFixture(
      "murmuration/soul.md",
      "# Murmuration Soul\n\nShared constitutional content.\n",
    );
    await writeFixture(
      "agents/08-editorial/soul.md",
      "# Editorial Agent Soul\n\nLong-lived character.\n",
    );
    await writeFixture(
      "agents/08-editorial/role.md",
      `---
agent_id: "08-editorial"
name: "Editorial Agent"
model_tier: balanced
circle_memberships:
  - content
  - quality
wake_schedule:
  delayMs: 2000
max_wall_clock_ms: 30000
---

# Editorial Agent — Role

Accountabilities, etc.
`,
    );
    await writeFixture(
      "governance/circles/content.md",
      "---\ncircle_id: content\n---\n# Content Circle\n\nPurpose...\n",
    );
    await writeFixture(
      "governance/circles/quality.md",
      "---\ncircle_id: quality\n---\n# Quality Circle\n\nPurpose...\n",
    );
  };

  it("loads a complete identity chain from disk", async () => {
    await writeCompleteFixture();
    const loader = new IdentityLoader({ rootDir });

    const loaded = await loader.load("08-editorial");

    expect(loaded.agentId.value).toBe("08-editorial");
    expect(loaded.frontmatter.name).toBe("Editorial Agent");
    expect(loaded.frontmatter.model_tier).toBe("balanced");
    expect(loaded.frontmatter.circle_memberships).toEqual(["content", "quality"]);
    expect(loaded.frontmatter.max_wall_clock_ms).toBe(30_000);

    const chain = loaded.chain;
    expect(chain.layers).toHaveLength(5);
    expect(chain.layers[0]?.kind).toBe("murmuration-soul");
    expect(chain.layers[1]?.kind).toBe("agent-soul");
    expect(chain.layers[2]?.kind).toBe("agent-role");
    expect(chain.layers[3]?.kind).toBe("circle-context");
    expect(chain.layers[4]?.kind).toBe("circle-context");

    const agentRoleLayer = chain.layers[2];
    expect(agentRoleLayer?.content).toContain("Editorial Agent — Role");
    expect(agentRoleLayer?.content).not.toContain("agent_id:");
  });

  it("supports multi-circle agents as first-class", async () => {
    await writeCompleteFixture();
    const loader = new IdentityLoader({ rootDir });
    const loaded = await loader.load("08-editorial");

    expect(loaded.chain.frontmatter.circleMemberships).toHaveLength(2);
    const circleIds: string[] = [];
    for (const layer of loaded.chain.layers) {
      if (layer.kind === "circle-context") {
        circleIds.push(layer.circleId.value);
      }
    }
    expect(circleIds).toEqual(["content", "quality"]);
  });

  it("throws IdentityFileMissingError when role.md is absent", async () => {
    await writeFixture("murmuration/soul.md", "# Soul\n");
    await writeFixture("agents/09-missing/soul.md", "# Agent Soul\n");

    const loader = new IdentityLoader({ rootDir });

    await expect(loader.load("09-missing")).rejects.toBeInstanceOf(IdentityFileMissingError);
  });

  it("throws IdentityFileMissingError when a circle context file is absent", async () => {
    await writeFixture("murmuration/soul.md", "# Soul\n");
    await writeFixture("agents/10-orphan/soul.md", "# Agent Soul\n");
    await writeFixture(
      "agents/10-orphan/role.md",
      `---
agent_id: "10-orphan"
name: "Orphan"
model_tier: fast
circle_memberships:
  - nonexistent
---

# Orphan
`,
    );

    const loader = new IdentityLoader({ rootDir });

    await expect(loader.load("10-orphan")).rejects.toBeInstanceOf(IdentityFileMissingError);
  });

  it("throws FrontmatterInvalidError when role.md has no frontmatter block", async () => {
    await writeFixture("murmuration/soul.md", "# Soul\n");
    await writeFixture("agents/11-bad/soul.md", "# Agent Soul\n");
    await writeFixture("agents/11-bad/role.md", "# No frontmatter here\n");

    const loader = new IdentityLoader({ rootDir });

    await expect(loader.load("11-bad")).rejects.toBeInstanceOf(FrontmatterInvalidError);
  });

  it("throws FrontmatterInvalidError when required fields are missing", async () => {
    await writeFixture("murmuration/soul.md", "# Soul\n");
    await writeFixture("agents/12-incomplete/soul.md", "# Soul\n");
    await writeFixture(
      "agents/12-incomplete/role.md",
      `---
name: "Incomplete"
---

# Incomplete
`,
    );

    const loader = new IdentityLoader({ rootDir });

    try {
      await loader.load("12-incomplete");
      throw new Error("expected FrontmatterInvalidError");
    } catch (err) {
      expect(err).toBeInstanceOf(FrontmatterInvalidError);
      if (err instanceof FrontmatterInvalidError) {
        expect(err.issues.some((i) => i.includes("agent_id"))).toBe(true);
      }
    }
  });

  it("throws FrontmatterInvalidError when model_tier is invalid", async () => {
    await writeFixture("murmuration/soul.md", "# Soul\n");
    await writeFixture("agents/13-badtier/soul.md", "# Soul\n");
    await writeFixture(
      "agents/13-badtier/role.md",
      `---
agent_id: "13-badtier"
name: "BadTier"
model_tier: galactic
---

# BadTier
`,
    );

    const loader = new IdentityLoader({ rootDir });

    await expect(loader.load("13-badtier")).rejects.toBeInstanceOf(FrontmatterInvalidError);
  });

  it("frontmatter schema defaults apply when optional fields are omitted", async () => {
    await writeFixture("murmuration/soul.md", "# Soul\n");
    await writeFixture("agents/14-defaults/soul.md", "# Soul\n");
    await writeFixture(
      "agents/14-defaults/role.md",
      `---
agent_id: "14-defaults"
name: "Defaults"
model_tier: fast
---

# Defaults
`,
    );

    const loader = new IdentityLoader({ rootDir });
    const loaded = await loader.load("14-defaults");

    expect(loaded.frontmatter.circle_memberships).toEqual([]);
    expect(loaded.frontmatter.max_wall_clock_ms).toBe(15_000);
  });
});
