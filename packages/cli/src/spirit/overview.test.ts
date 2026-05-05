/**
 * describeMurmuration tests — Workstream P.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { describeMurmuration } from "./overview.js";

describe("describeMurmuration (Workstream P)", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "spirit-overview-"));
  });

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const writeMurmurationFile = (relPath: string, content: string): void => {
    const full = join(root, relPath);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf8");
  };

  it("walks an empty murmuration without throwing", async () => {
    const { overview } = await describeMurmuration(root);
    expect(overview.agents).toEqual([]);
    expect(overview.groups).toEqual([]);
    expect(overview.governanceModel).toBeUndefined();
  });

  it("extracts governance model + LLM provider from harness.yaml", async () => {
    writeMurmurationFile(
      "murmuration/harness.yaml",
      `
governance:
  model: sociocracy-3.0
  plugin: "@murmurations-ai/governance-s3"
llm:
  provider: subscription-cli
  model: claude-sonnet-4-6
`,
    );
    const { overview } = await describeMurmuration(root);
    expect(overview.governanceModel).toBe("sociocracy-3.0");
    expect(overview.governancePlugin).toBe("@murmurations-ai/governance-s3");
    expect(overview.llmProvider).toBe("subscription-cli");
    expect(overview.llmModel).toBe("claude-sonnet-4-6");
  });

  it("extracts the first non-heading paragraph of soul.md as purpose", async () => {
    writeMurmurationFile(
      "murmuration/soul.md",
      `# Murmuration purpose

We exist to coordinate research, content, and pricing decisions across
the Emergent Praxis knowledge business. Our north star is operator
sovereignty.

## Bright lines
- Source decides
`,
    );
    const { overview } = await describeMurmuration(root);
    expect(overview.purpose).toContain("coordinate research, content");
    expect(overview.purpose).not.toContain("Bright lines");
  });

  it("collects agents with frontmatter fields", async () => {
    writeMurmurationFile(
      "agents/facilitator-agent/role.md",
      `---
agent_id: facilitator-agent
name: Facilitator
model_tier: balanced
wake_schedule:
  cron: "0 7,18 * * *"
  tz: "UTC"
group_memberships: [facilitation]
github:
  write_scopes: [labels, comments, close_issues]
---

# Facilitator
`,
    );
    writeMurmurationFile(
      "agents/research-agent/role.md",
      `---
agent_id: research-agent
name: Research
model_tier: deep
wake_schedule:
  cron: "0 9 * * *"
group_memberships: [research]
---
`,
    );

    const { overview } = await describeMurmuration(root);
    expect(overview.agents).toHaveLength(2);
    const facilitator = overview.agents.find((a) => a.agentId === "facilitator-agent");
    expect(facilitator?.modelTier).toBe("balanced");
    expect(facilitator?.wakeSchedule).toBe("0 7,18 * * * UTC");
    expect(facilitator?.groups).toEqual(["facilitation"]);
    expect(facilitator?.writeScopes).toEqual(["labels", "comments", "close_issues"]);
  });

  it("collects groups with title + facilitator + members", async () => {
    writeMurmurationFile(
      "governance/groups/research.md",
      `# Research Circle
facilitator: research-lead

## Members
- research-agent
- writing-agent

Some prose.
`,
    );
    writeMurmurationFile(
      "governance/groups/facilitation.md",
      `# Facilitation
facilitator: facilitator-agent

## Members
- facilitator-agent
`,
    );
    const { overview } = await describeMurmuration(root);
    expect(overview.groups).toHaveLength(2);
    const research = overview.groups.find((g) => g.groupId === "research");
    expect(research?.title).toBe("Research Circle");
    expect(research?.facilitator).toBe("research-lead");
    expect(research?.members).toEqual(["research-agent", "writing-agent"]);
  });

  it("renders a usable markdown summary", async () => {
    writeMurmurationFile("murmuration/harness.yaml", "governance:\n  model: s3\n");
    writeMurmurationFile(
      "agents/a/role.md",
      `---
agent_id: a
model_tier: balanced
wake_schedule:
  cron: "0 7 * * *"
group_memberships: []
---
`,
    );
    const { markdown } = await describeMurmuration(root);
    expect(markdown).toContain("# Murmuration overview");
    expect(markdown).toContain("**Governance:** s3");
    expect(markdown).toContain("| a |");
  });

  it("walks the source files on every call (no cache)", async () => {
    writeMurmurationFile("murmuration/harness.yaml", "governance:\n  model: s3\n");
    const first = await describeMurmuration(root);
    expect(first.overview.governanceModel).toBe("s3");

    // Mutate harness.yaml; the next call should reflect it immediately.
    writeMurmurationFile("murmuration/harness.yaml", "governance:\n  model: consensus\n");
    const second = await describeMurmuration(root);
    expect(second.overview.governanceModel).toBe("consensus");
  });
});
