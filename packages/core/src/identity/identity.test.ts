import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
group_memberships:
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
      "governance/groups/content.md",
      "---\ncircle_id: content\n---\n# Content Circle\n\nPurpose...\n",
    );
    await writeFixture(
      "governance/groups/quality.md",
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
    expect(loaded.frontmatter.group_memberships).toEqual(["content", "quality"]);
    expect(loaded.frontmatter.max_wall_clock_ms).toBe(30_000);

    const chain = loaded.chain;
    expect(chain.layers).toHaveLength(5);
    expect(chain.layers[0]?.kind).toBe("murmuration-soul");
    expect(chain.layers[1]?.kind).toBe("agent-soul");
    expect(chain.layers[2]?.kind).toBe("agent-role");
    expect(chain.layers[3]?.kind).toBe("group-context");
    expect(chain.layers[4]?.kind).toBe("group-context");

    const agentRoleLayer = chain.layers[2];
    expect(agentRoleLayer?.content).toContain("Editorial Agent — Role");
    expect(agentRoleLayer?.content).not.toContain("agent_id:");
  });

  it("supports multi-circle agents as first-class", async () => {
    await writeCompleteFixture();
    const loader = new IdentityLoader({ rootDir });
    const loaded = await loader.load("08-editorial");

    expect(loaded.chain.frontmatter.groupMemberships).toHaveLength(2);
    const groupIds: string[] = [];
    for (const layer of loaded.chain.layers) {
      if (layer.kind === "group-context") {
        groupIds.push(layer.groupId.value);
      }
    }
    expect(groupIds).toEqual(["content", "quality"]);
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
group_memberships:
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

  it("fills in missing agent_id from the directory name (Reasonable defaults)", async () => {
    // Engineering Standard #11: operators shouldn't have to repeat the
    // directory name as agent_id. The loader derives it automatically.
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
    const loaded = await loader.load("12-incomplete");
    expect(loaded.frontmatter.agent_id).toBe("12-incomplete");
    expect(loaded.frontmatter.name).toBe("Incomplete");
    expect(loaded.frontmatter.model_tier).toBe("balanced");
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

  describe("Zod issue annotation (v0.5.0 Milestone 1)", () => {
    it("numeric agent_id is coerced to a string rather than rejected (Engineering Standard #11)", async () => {
      // A legacy `agent_id: 22` (YAML integer) used to crash boot with a
      // schema error. v0.5.0 coerces to string before validation — the
      // operator's intent was clearly "a string ID", and the harness
      // doesn't enforce agent_id === dirname, so 22 is accepted as "22".
      await writeFixture("murmuration/soul.md", "# Soul\n");
      await writeFixture("agents/facilitator/soul.md", "# Soul\n");
      await writeFixture(
        "agents/facilitator/role.md",
        `---
agent_id: 22
name: "Facilitator"
model_tier: balanced
---

# Body
`,
      );

      const loader = new IdentityLoader({ rootDir });
      const loaded = await loader.load("facilitator");
      expect(loaded.frontmatter.agent_id).toBe("22");
    });

    it("rejects agent_id containing path traversal sequences (H2)", async () => {
      // A role.md with agent_id like "../../tmp/x" would otherwise
      // escape the murmuration root when the daemon joins it into
      // runs/, logs/, governance persist dirs.
      await writeFixture("murmuration/soul.md", "# Soul\n");
      await writeFixture("agents/evil/soul.md", "# Soul\n");
      await writeFixture(
        "agents/evil/role.md",
        `---
agent_id: "../../../tmp/pwned"
name: "Evil"
model_tier: balanced
---

# Evil
`,
      );
      const loader = new IdentityLoader({ rootDir });
      await expect(loader.load("evil")).rejects.toBeInstanceOf(FrontmatterInvalidError);
    });

    it("rejects agent_id containing slashes", async () => {
      await writeFixture("murmuration/soul.md", "# Soul\n");
      await writeFixture("agents/slashy/soul.md", "# Soul\n");
      await writeFixture(
        "agents/slashy/role.md",
        `---
agent_id: "research/editorial"
name: "Slashy"
model_tier: balanced
---

# Slashy
`,
      );
      const loader = new IdentityLoader({ rootDir });
      await expect(loader.load("slashy")).rejects.toBeInstanceOf(FrontmatterInvalidError);
    });

    it("rejects agent_id longer than 64 chars", async () => {
      await writeFixture("murmuration/soul.md", "# Soul\n");
      await writeFixture("agents/long/soul.md", "# Soul\n");
      await writeFixture(
        "agents/long/role.md",
        `---
agent_id: "${"a".repeat(65)}"
name: "Long"
model_tier: balanced
---

# Long
`,
      );
      const loader = new IdentityLoader({ rootDir });
      await expect(loader.load("long")).rejects.toBeInstanceOf(FrontmatterInvalidError);
    });

    it("wrong model_tier: issue names the valid enum values", async () => {
      await writeFixture("murmuration/soul.md", "# Soul\n");
      await writeFixture("agents/badtier/soul.md", "# Soul\n");
      await writeFixture(
        "agents/badtier/role.md",
        `---
agent_id: "badtier"
name: "BadTier"
model_tier: galactic
---

# BadTier
`,
      );

      const loader = new IdentityLoader({ rootDir });
      try {
        await loader.load("badtier");
        throw new Error("expected FrontmatterInvalidError");
      } catch (err) {
        expect(err).toBeInstanceOf(FrontmatterInvalidError);
        if (err instanceof FrontmatterInvalidError) {
          const joined = err.issues.join("\n");
          expect(joined).toContain("fast");
          expect(joined).toContain("balanced");
          expect(joined).toContain("deep");
        }
      }
    });

    it("wrong llm.provider: issue names the valid provider list", async () => {
      await writeFixture("murmuration/soul.md", "# Soul\n");
      await writeFixture("agents/badllm/soul.md", "# Soul\n");
      await writeFixture(
        "agents/badllm/role.md",
        `---
agent_id: "badllm"
name: "BadLLM"
model_tier: balanced
llm:
  provider: "Claude"
---

# BadLLM
`,
      );

      const loader = new IdentityLoader({ rootDir });
      try {
        await loader.load("badllm");
        throw new Error("expected FrontmatterInvalidError");
      } catch (err) {
        expect(err).toBeInstanceOf(FrontmatterInvalidError);
        if (err instanceof FrontmatterInvalidError) {
          const joined = err.issues.join("\n");
          expect(joined).toContain("gemini");
          expect(joined).toContain("anthropic");
          expect(joined).toContain("openai");
          expect(joined).toContain("ollama");
        }
      }
    });
  });

  describe("Reasonable defaults cascade (Engineering Standard #11)", () => {
    it("derives agent_id from directory when omitted", async () => {
      await writeFixture("murmuration/soul.md", "# Soul\n");
      await writeFixture("agents/my-agent/soul.md", "# Soul\n");
      await writeFixture(
        "agents/my-agent/role.md",
        `---
name: "My Agent"
---

body
`,
      );
      const loader = new IdentityLoader({ rootDir });
      const loaded = await loader.load("my-agent");
      expect(loaded.frontmatter.agent_id).toBe("my-agent");
    });

    it("humanizes the directory name when name is omitted", async () => {
      await writeFixture("murmuration/soul.md", "# Soul\n");
      await writeFixture("agents/research-agent/soul.md", "# Soul\n");
      await writeFixture(
        "agents/research-agent/role.md",
        "---\n# minimum frontmatter\n---\nbody\n",
      );
      const loader = new IdentityLoader({ rootDir });
      const loaded = await loader.load("research-agent");
      expect(loaded.frontmatter.name).toBe("Research Agent");
    });

    it("cascades llm from harness.yaml when role.md omits it", async () => {
      await writeFixture("murmuration/soul.md", "# Soul\n");
      await writeFixture("agents/silent/soul.md", "# Soul\n");
      await writeFixture("agents/silent/role.md", "---\n# minimum frontmatter\n---\nbody\n");
      const loader = new IdentityLoader({
        rootDir,
        roleDefaults: { llm: { provider: "anthropic" } },
      });
      const loaded = await loader.load("silent");
      expect(loaded.frontmatter.llm?.provider).toBe("anthropic");
    });

    it("role.md llm wins over harness-level default when both are set", async () => {
      await writeFixture("murmuration/soul.md", "# Soul\n");
      await writeFixture("agents/opinionated/soul.md", "# Soul\n");
      await writeFixture(
        "agents/opinionated/role.md",
        `---
llm:
  provider: "openai"
---

body
`,
      );
      const loader = new IdentityLoader({
        rootDir,
        roleDefaults: { llm: { provider: "gemini" } },
      });
      const loaded = await loader.load("opinionated");
      expect(loaded.frontmatter.llm?.provider).toBe("openai");
    });
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

    expect(loaded.frontmatter.group_memberships).toEqual([]);
    expect(loaded.frontmatter.max_wall_clock_ms).toBe(120_000);
  });
});

// ---------------------------------------------------------------------------
// ADR-0016 extensions — Phase 2C role template
// ---------------------------------------------------------------------------

describe("roleFrontmatterSchema (ADR-0016 extensions)", () => {
  let rootDir = "";

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "murmuration-role-"));
  });

  afterEach(async () => {
    if (rootDir) await rm(rootDir, { recursive: true, force: true });
  });

  const writeFixture = async (relativePath: string, content: string): Promise<void> => {
    const full = join(rootDir, relativePath);
    const dir = full.substring(0, full.lastIndexOf("/"));
    await mkdir(dir, { recursive: true });
    await writeFile(full, content, "utf8");
  };

  const writeMinimalFixture = async (agentDir: string, roleFrontmatter: string): Promise<void> => {
    await writeFixture("murmuration/soul.md", "# Murmuration Soul\n\nShared.\n");
    await writeFixture(`agents/${agentDir}/soul.md`, "# Soul\n\nChar.\n");
    await writeFixture(`agents/${agentDir}/role.md`, `---\n${roleFrontmatter}\n---\n\n# Role\n`);
    await writeFixture("governance/groups/engineering.md", "# Engineering\n");
  };

  it("minimal hello-world frontmatter still loads (backwards compat)", async () => {
    await writeMinimalFixture(
      "hello-world",
      [
        'agent_id: "hello-world"',
        'name: "Hello World Agent"',
        "model_tier: fast",
        "group_memberships:",
        "  - engineering",
      ].join("\n"),
    );
    const loader = new IdentityLoader({ rootDir });
    const loaded = await loader.load("hello-world");
    expect(loaded.frontmatter.llm).toBeUndefined();
    expect(loaded.frontmatter.signals.sources).toEqual([
      "github-issue",
      "private-note",
      "inbox-message",
    ]);
    expect(loaded.frontmatter.github.write_scopes.issue_comments).toEqual([]);
    expect(loaded.frontmatter.github.write_scopes.branch_commits).toEqual([]);
    expect(loaded.frontmatter.budget.max_cost_micros).toBe(0);
    expect(loaded.frontmatter.budget.on_breach).toBe("warn");
    expect(loaded.frontmatter.secrets.required).toEqual([]);
    expect(loaded.frontmatter.prompt.ref).toBeUndefined();
  });

  it("full Research Agent #1 frontmatter loads with every field", async () => {
    await writeMinimalFixture(
      "01-research",
      [
        'agent_id: "01-research"',
        'name: "Research Agent"',
        "model_tier: balanced",
        "max_wall_clock_ms: 600000",
        "group_memberships:",
        "  - engineering",
        "llm:",
        '  provider: "gemini"',
        '  model: "gemini-2.5-pro"',
        "wake_schedule:",
        '  cron: "0 18 * * 0"',
        "signals:",
        "  sources:",
        '    - "github-issue"',
        '    - "private-note"',
        "  github_scopes:",
        '    - owner: "xeeban"',
        '      repo: "emergent-praxis"',
        "      filter:",
        '        state: "all"',
        "        since_days: 7",
        "github:",
        "  write_scopes:",
        "    issue_comments:",
        '      - "xeeban/emergent-praxis"',
        "    branch_commits:",
        '      - repo: "xeeban/emergent-praxis"',
        "        paths:",
        '          - "notes/weekly/**"',
        "prompt:",
        '  ref: "./prompts/wake.md"',
        "budget:",
        "  max_cost_micros: 500000",
        "  max_github_api_calls: 100",
        '  on_breach: "abort"',
        "secrets:",
        "  required:",
        '    - "GEMINI_API_KEY"',
      ].join("\n"),
    );
    const loader = new IdentityLoader({ rootDir });
    const loaded = await loader.load("01-research");
    expect(loaded.frontmatter.llm?.provider).toBe("gemini");
    expect(loaded.frontmatter.llm?.model).toBe("gemini-2.5-pro");
    expect(loaded.frontmatter.wake_schedule?.cron).toBe("0 18 * * 0");
    expect(loaded.frontmatter.signals.github_scopes).toHaveLength(1);
    expect(loaded.frontmatter.github.write_scopes.issue_comments).toEqual([
      "xeeban/emergent-praxis",
    ]);
    expect(loaded.frontmatter.github.write_scopes.branch_commits[0]?.paths).toEqual([
      "notes/weekly/**",
    ]);
    expect(loaded.frontmatter.prompt.ref).toBe("./prompts/wake.md");
    expect(loaded.frontmatter.budget.max_cost_micros).toBe(500_000);
    expect(loaded.frontmatter.budget.on_breach).toBe("abort");
    expect(loaded.frontmatter.secrets.required).toEqual(["GEMINI_API_KEY"]);
  });

  it("rejects unknown llm.provider enum", async () => {
    await writeMinimalFixture(
      "bad-provider",
      [
        'agent_id: "bad-provider"',
        'name: "Bad"',
        "model_tier: fast",
        "llm:",
        '  provider: "xai"',
      ].join("\n"),
    );
    const loader = new IdentityLoader({ rootDir });
    await expect(loader.load("bad-provider")).rejects.toThrow(FrontmatterInvalidError);
  });

  it("rejects invalid cron expression", async () => {
    await writeMinimalFixture(
      "bad-cron",
      [
        'agent_id: "bad-cron"',
        'name: "Bad Cron"',
        "model_tier: fast",
        "wake_schedule:",
        '  cron: "not a cron"',
      ].join("\n"),
    );
    const loader = new IdentityLoader({ rootDir });
    await expect(loader.load("bad-cron")).rejects.toThrow(FrontmatterInvalidError);
  });

  it("rejects branch_commits.repo not in owner/name form", async () => {
    await writeMinimalFixture(
      "bad-repo",
      [
        'agent_id: "bad-repo"',
        'name: "Bad Repo"',
        "model_tier: fast",
        "github:",
        "  write_scopes:",
        "    branch_commits:",
        '      - repo: "not-a-valid-repo-name"',
        "        paths:",
        '          - "docs/**"',
      ].join("\n"),
    );
    const loader = new IdentityLoader({ rootDir });
    await expect(loader.load("bad-repo")).rejects.toThrow(FrontmatterInvalidError);
  });

  it("tools defaults to empty mcp/cli when omitted (backwards compat)", async () => {
    await writeMinimalFixture(
      "no-tools",
      ['agent_id: "no-tools"', 'name: "No Tools"', "model_tier: fast"].join("\n"),
    );
    const loader = new IdentityLoader({ rootDir });
    const loaded = await loader.load("no-tools");
    expect(loaded.frontmatter.tools.mcp).toEqual([]);
    expect(loaded.frontmatter.tools.cli).toEqual([]);
  });

  it("parses tools.mcp server declarations", async () => {
    await writeMinimalFixture(
      "with-tools",
      [
        'agent_id: "with-tools"',
        'name: "Tool Agent"',
        "model_tier: balanced",
        "tools:",
        "  mcp:",
        "    - name: filesystem",
        "      command: npx",
        "      args:",
        "        - -y",
        "        - '@modelcontextprotocol/server-filesystem'",
        "        - ./workspace",
        "    - name: github",
        "      command: npx",
        "      args:",
        "        - -y",
        "        - '@modelcontextprotocol/server-github'",
        "      env:",
        "        GITHUB_TOKEN: '$GITHUB_TOKEN'",
        "  cli:",
        "    - gh",
        "    - gcloud",
      ].join("\n"),
    );
    const loader = new IdentityLoader({ rootDir });
    const loaded = await loader.load("with-tools");
    expect(loaded.frontmatter.tools.mcp).toHaveLength(2);
    expect(loaded.frontmatter.tools.mcp[0]?.name).toBe("filesystem");
    expect(loaded.frontmatter.tools.mcp[0]?.command).toBe("npx");
    expect(loaded.frontmatter.tools.mcp[0]?.args).toEqual([
      "-y",
      "@modelcontextprotocol/server-filesystem",
      "./workspace",
    ]);
    expect(loaded.frontmatter.tools.mcp[1]?.name).toBe("github");
    expect(loaded.frontmatter.tools.mcp[1]?.env).toEqual({ GITHUB_TOKEN: "$GITHUB_TOKEN" });
    expect(loaded.frontmatter.tools.cli).toEqual(["gh", "gcloud"]);
  });

  it("plugins defaults to empty when omitted (backwards compat)", async () => {
    await writeMinimalFixture(
      "no-plugins",
      ['agent_id: "no-plugins"', 'name: "No Plugins"', "model_tier: fast"].join("\n"),
    );
    const loader = new IdentityLoader({ rootDir });
    const loaded = await loader.load("no-plugins");
    expect(loaded.frontmatter.plugins).toEqual([]);
  });

  it("parses plugin declarations from role.md frontmatter (ADR-0023)", async () => {
    await writeMinimalFixture(
      "with-plugins",
      [
        'agent_id: "with-plugins"',
        'name: "Plugin Agent"',
        "model_tier: balanced",
        "plugins:",
        '  - provider: "@murmurations-ai/web-search"',
        '  - provider: "custom-plugin"',
      ].join("\n"),
    );
    const loader = new IdentityLoader({ rootDir });
    const loaded = await loader.load("with-plugins");
    expect(loaded.frontmatter.plugins).toHaveLength(2);
    expect(loaded.frontmatter.plugins[0]?.provider).toBe("@murmurations-ai/web-search");
    expect(loaded.frontmatter.plugins[1]?.provider).toBe("custom-plugin");
  });

  it("rejects malformed plugin entries (empty provider)", async () => {
    await writeMinimalFixture(
      "bad-plugins",
      [
        'agent_id: "bad-plugins"',
        'name: "Bad"',
        "model_tier: fast",
        "plugins:",
        '  - provider: ""',
      ].join("\n"),
    );
    const loader = new IdentityLoader({ rootDir });
    await expect(loader.load("bad-plugins")).rejects.toThrow(FrontmatterInvalidError);
  });
});

// ---------------------------------------------------------------------------
// Real-world example: the shipped `examples/research-agent/` identity chain
//
// This is not a synthetic fixture — it is the actual files under
// `examples/research-agent/`, the Phase 2C port of the Emergent Praxis
// Research Agent #1 identity. The test exists so any change to the role
// template schema (ADR-0016 and successors) immediately breaks CI if the
// example stops loading cleanly. Cheapest way to keep the example honest.
// ---------------------------------------------------------------------------

describe("examples/research-agent identity chain", () => {
  const hereDir = dirname(fileURLToPath(import.meta.url));
  // packages/core/src/identity → repo root → examples/research-agent
  const exampleRoot = resolve(hereDir, "..", "..", "..", "..", "examples", "research-agent");

  it("loads the research-agent identity chain without errors", async () => {
    const loader = new IdentityLoader({ rootDir: exampleRoot });
    const loaded = await loader.load("01-research");

    expect(loaded.agentId.value).toBe("01-research");
    expect(loaded.frontmatter.name).toBe("Research Agent");
    expect(loaded.frontmatter.model_tier).toBe("balanced");
    expect(loaded.frontmatter.group_memberships).toEqual(["intelligence"]);
  });

  it("parses the ADR-0016 llm pin (gemini / gemini-2.5-pro)", async () => {
    const loader = new IdentityLoader({ rootDir: exampleRoot });
    const loaded = await loader.load("01-research");

    expect(loaded.frontmatter.llm).toEqual({
      provider: "gemini",
      model: "gemini-2.5-pro",
    });
  });

  it("parses the weekly cron wake schedule", async () => {
    const loader = new IdentityLoader({ rootDir: exampleRoot });
    const loaded = await loader.load("01-research");

    expect(loaded.frontmatter.wake_schedule?.cron).toBe("0 18 * * 0");
  });

  it("parses the ADR-0017 write scopes — notes/weekly/** on emergent-praxis", async () => {
    const loader = new IdentityLoader({ rootDir: exampleRoot });
    const loaded = await loader.load("01-research");

    const write = loaded.frontmatter.github.write_scopes;
    expect(write.issue_comments).toEqual(["xeeban/emergent-praxis"]);
    expect(write.branch_commits).toEqual([
      {
        repo: "xeeban/emergent-praxis",
        paths: ["notes/weekly/**"],
      },
    ]);
    expect(write.labels).toEqual([]);
  });

  it("parses the signal github_scopes for both repos", async () => {
    const loader = new IdentityLoader({ rootDir: exampleRoot });
    const loaded = await loader.load("01-research");

    expect(loaded.frontmatter.signals.github_scopes).toEqual([
      {
        owner: "xeeban",
        repo: "emergent-praxis",
        filter: { state: "all", since_days: 7 },
      },
      {
        owner: "murmurations-ai",
        repo: "murmurations-harness",
        filter: { state: "all", since_days: 7 },
      },
    ]);
  });

  it("parses the budget ceiling + on_breach = abort", async () => {
    const loader = new IdentityLoader({ rootDir: exampleRoot });
    const loaded = await loader.load("01-research");

    expect(loaded.frontmatter.budget).toEqual({
      max_cost_micros: 500_000,
      max_github_api_calls: 100,
      on_breach: "abort",
    });
  });

  it("declares GEMINI_API_KEY and GITHUB_TOKEN as required secrets", async () => {
    const loader = new IdentityLoader({ rootDir: exampleRoot });
    const loaded = await loader.load("01-research");

    expect(loaded.frontmatter.secrets.required).toEqual(["GEMINI_API_KEY", "GITHUB_TOKEN"]);
    expect(loaded.frontmatter.secrets.optional).toEqual([]);
  });

  it("assembles a four-layer identity chain (soul + agent-soul + role + intelligence circle)", async () => {
    const loader = new IdentityLoader({ rootDir: exampleRoot });
    const loaded = await loader.load("01-research");

    expect(loaded.chain.layers).toHaveLength(4);
    expect(loaded.chain.layers[0]?.kind).toBe("murmuration-soul");
    expect(loaded.chain.layers[1]?.kind).toBe("agent-soul");
    expect(loaded.chain.layers[2]?.kind).toBe("agent-role");
    expect(loaded.chain.layers[3]?.kind).toBe("group-context");
  });
});

// ---------------------------------------------------------------------------
// v0.7.0 — examples/facilitator-agent reference implementation (ADR-0041)
// ---------------------------------------------------------------------------

describe("examples/facilitator-agent identity chain", () => {
  const hereDir = dirname(fileURLToPath(import.meta.url));
  // packages/core/src/identity → repo root → examples/facilitator-agent
  const exampleRoot = resolve(hereDir, "..", "..", "..", "..", "examples", "facilitator-agent");

  it("loads the facilitator-agent identity chain without errors", async () => {
    const loader = new IdentityLoader({ rootDir: exampleRoot });
    const loaded = await loader.load("facilitator-agent");

    expect(loaded.agentId.value).toBe("facilitator-agent");
    expect(loaded.frontmatter.name).toBe("Facilitator Agent");
    expect(loaded.frontmatter.group_memberships).toEqual(["facilitation"]);
  });

  it("parses the twice-daily wake schedule (07:00 + 18:00)", async () => {
    const loader = new IdentityLoader({ rootDir: exampleRoot });
    const loaded = await loader.load("facilitator-agent");

    expect(loaded.frontmatter.wake_schedule?.cron).toBe("0 7,18 * * *");
  });

  it("parses the four ADR-0042 accountabilities with done_when blocks", async () => {
    const loader = new IdentityLoader({ rootDir: exampleRoot });
    const loaded = await loader.load("facilitator-agent");

    const accountabilities = loaded.frontmatter.accountabilities;
    expect(accountabilities).toBeDefined();
    expect(accountabilities?.map((a) => a.id)).toEqual([
      "advance-and-close-governance-items",
      "decision-log",
      "facilitator-log",
      "awaiting-source-close-surfacing",
    ]);
    // Every accountability must have at least one done_when condition.
    for (const acc of accountabilities ?? []) {
      expect(acc.done_when.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("declares the closure-related label write scope", async () => {
    const loader = new IdentityLoader({ rootDir: exampleRoot });
    const loaded = await loader.load("facilitator-agent");

    const labels = loaded.frontmatter.github.write_scopes.labels;
    expect(labels).toContain("awaiting:source-close");
    expect(labels).toContain("verification-failed");
  });

  it("declares branch-commit scope for governance/decisions and agreements", async () => {
    const loader = new IdentityLoader({ rootDir: exampleRoot });
    const loaded = await loader.load("facilitator-agent");

    const branchCommits = loaded.frontmatter.github.write_scopes.branch_commits;
    expect(branchCommits).toHaveLength(1);
    expect(branchCommits[0]?.paths).toEqual(
      expect.arrayContaining(["governance/decisions/**", "governance/agreements/**"]),
    );
  });
});

// ---------------------------------------------------------------------------
// ADR-0027 — Fallback identity for incomplete agent directories
// ---------------------------------------------------------------------------

describe("IdentityLoader fallback (ADR-0027)", () => {
  let rootDir = "";

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "murmuration-fallback-"));
  });

  afterEach(async () => {
    if (rootDir) await rm(rootDir, { recursive: true, force: true });
  });

  const writeFixture = async (relativePath: string, content: string): Promise<void> => {
    const full = join(rootDir, relativePath);
    await mkdir(full.substring(0, full.lastIndexOf("/")), { recursive: true });
    await writeFile(full, content, "utf8");
  };

  it("synthesizes a functional identity when role.md and soul.md are both missing", async () => {
    await writeFixture("murmuration/soul.md", "# Murmuration\n");
    // agents/new-agent/ directory doesn't exist at all — still should load
    const calls: { agentDir: string; reason: string; missing: readonly string[] }[] = [];
    const loader = new IdentityLoader({
      rootDir,
      fallbackOnMissing: true,
      onFallback: (agentDir, reason) => {
        calls.push({ agentDir, reason: reason.reason, missing: reason.missingFiles });
      },
    });
    const loaded = await loader.load("new-agent");

    expect(loaded.fallback).toBeDefined();
    expect(loaded.fallback?.reason).toBe("missing-files");
    expect(loaded.frontmatter.agent_id).toBe("new-agent");
    expect(loaded.frontmatter.name).toContain("new-agent");
    expect(loaded.frontmatter.model_tier).toBe("balanced");
    expect(loaded.frontmatter.plugins).toEqual([]);
    // onFallback was invoked exactly once for this agent
    expect(calls).toHaveLength(1);
    expect(calls[0]?.agentDir).toBe("new-agent");
  });

  it("synthesizes a fallback identity when role.md is present but soul.md is missing", async () => {
    await writeFixture("murmuration/soul.md", "# Murmuration\n");
    await writeFixture(
      "agents/half/role.md",
      `---
agent_id: "half"
name: "Half Agent"
model_tier: fast
---

# Half Agent
`,
    );
    const loader = new IdentityLoader({ rootDir, fallbackOnMissing: true });
    const loaded = await loader.load("half");

    expect(loaded.fallback).toBeDefined();
    expect(loaded.fallback?.missingFiles).toContain("soul.md");
  });

  it("preserves the old IdentityFileMissingError when fallbackOnMissing is not set", async () => {
    await writeFixture("murmuration/soul.md", "# Murmuration\n");
    // no agent files at all
    const loader = new IdentityLoader({ rootDir });
    await expect(loader.load("ghost")).rejects.toBeInstanceOf(IdentityFileMissingError);
  });

  it("prefers operator-provided default templates over built-ins", async () => {
    await writeFixture("murmuration/soul.md", "# Murmuration\n");
    await writeFixture(
      "murmuration/default-agent/soul.md",
      "# Operator default soul for {{agent_id}}\n",
    );
    await writeFixture(
      "murmuration/default-agent/role.md",
      `---
agent_id: "{{agent_id}}"
name: "Operator Default ({{agent_id}})"
model_tier: fast
plugins: []
---

# Operator Default Role — {{agent_id}}

Custom operator content.
`,
    );

    const loader = new IdentityLoader({ rootDir, fallbackOnMissing: true });
    const loaded = await loader.load("custom");

    expect(loaded.fallback).toBeDefined();
    expect(loaded.frontmatter.agent_id).toBe("custom");
    expect(loaded.frontmatter.name).toBe("Operator Default (custom)");
    expect(loaded.frontmatter.model_tier).toBe("fast");

    // Agent-soul layer carries the interpolated operator soul content
    const agentSoulLayer = loaded.chain.layers.find((l) => l.kind === "agent-soul");
    expect(agentSoulLayer?.content).toContain("Operator default soul for custom");
  });
});
