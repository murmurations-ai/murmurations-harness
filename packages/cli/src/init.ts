/**
 * `murmuration init` — interactive scaffolding for a new murmuration.
 *
 * Creates a directory structure the daemon can boot against:
 *
 *   <target>/
 *     murmuration/
 *       soul.md              — murmuration purpose + bright lines
 *     agents/
 *       <agent-name>/
 *         soul.md            — agent identity
 *         role.md            — frontmatter + accountabilities
 *     governance/
 *       groups/
 *         <group>.md         — group context (if any groups declared)
 *     .env                   — secret placeholders (0600)
 *     .gitignore             — ignores .env, .murmuration/
 *
 * The command asks a few questions interactively, writes the files,
 * and prints the next steps. Designed to be the first thing a new
 * operator runs after installing the harness.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (question: string): Promise<string> =>
  new Promise((resolve) => {
    rl.question(question, resolve);
  });

export const runInit = async (targetArg?: string): Promise<void> => {
  console.log("\nmurmuration init — create a new murmuration\n");

  // 1. Target directory
  const target = targetArg ?? (await ask("Directory to create (e.g. ../my-murmuration): "));
  const targetDir = resolve(target.trim());

  if (existsSync(targetDir)) {
    const existing = await ask(`${targetDir} already exists. Continue? (y/N): `);
    if (existing.trim().toLowerCase() !== "y") {
      console.log("Aborted.");
      rl.close();
      return;
    }
  }

  // 2. Murmuration purpose
  const purpose = await ask("What is this murmuration's purpose? (one sentence): ");

  // 3. First agent
  const agentName = await ask("Name your first agent (e.g. research, coordinator, builder): ");
  const agentDir = agentName.trim().toLowerCase().replace(/\s+/g, "-");

  // 4. Agent's LLM provider
  const providerInput = await ask(
    "LLM provider for this agent (gemini / anthropic / openai / ollama) [gemini]: ",
  );
  const provider = providerInput.trim().toLowerCase() || "gemini";

  // 5. Circle (optional)
  const groupInput = await ask("Group this agent belongs to (or press Enter for none): ");
  const group = groupInput.trim().toLowerCase().replace(/\s+/g, "-") || "";

  // 6. Governance model
  const govInput = await ask(
    "Governance model (self-organizing / chain-of-command / meritocratic / consensus / parliamentary / none) [none]: ",
  );
  const governance = govInput.trim().toLowerCase() || "none";

  rl.close();

  // -------------------------------------------------------------------
  // Write the files
  // -------------------------------------------------------------------

  console.log(`\nCreating murmuration at ${targetDir}...\n`);

  // Directories
  await mkdir(join(targetDir, "murmuration"), { recursive: true });
  await mkdir(join(targetDir, "agents", agentDir), { recursive: true });
  if (group) {
    await mkdir(join(targetDir, "governance", "groups"), { recursive: true });
  }

  // murmuration/soul.md
  await writeFile(
    join(targetDir, "murmuration", "soul.md"),
    `# Murmuration Soul

## Purpose

${purpose.trim()}

## Bright lines

_Define the non-negotiable principles every agent in this murmuration must follow._

- (add your bright lines here)

## Values

_What does this murmuration optimize for?_

- (add your values here)
`,
    "utf8",
  );

  // agents/<name>/soul.md
  await writeFile(
    join(targetDir, "agents", agentDir, "soul.md"),
    `# ${agentName.trim()} — Soul

## Who I am

_Describe this agent's character, perspective, and approach._

## What I will never do

_Define the agent-specific bright lines beyond the murmuration soul._
`,
    "utf8",
  );

  // agents/<name>/role.md
  const secretName = provider === "ollama" ? "" : `${provider.toUpperCase()}_API_KEY`;
  const groupLine = group ? `\n  - "${group}"` : "";
  await writeFile(
    join(targetDir, "agents", agentDir, "role.md"),
    `---
agent_id: "${agentDir}"
name: "${agentName.trim()}"
model_tier: "balanced"
max_wall_clock_ms: 120000
group_memberships:${groupLine || "\n  []"}

llm:
  provider: "${provider}"

wake_schedule:
  delayMs: 2000  # Change to cron for scheduled wakes: cron: "0 18 * * *"

signals:
  sources:
    - "github-issue"
    - "private-note"

github:
  write_scopes:
    issue_comments: []
    branch_commits: []
    labels: []
    issues: []

budget:
  max_cost_micros: 100000
  max_github_api_calls: 10
  on_breach: "warn"

secrets:
  required: [${secretName ? `"${secretName}"` : ""}]
  optional: ["GITHUB_TOKEN"]
---

# ${agentName.trim()} — Role

## Accountabilities

1. _(define what this agent is responsible for)_

## Decision tiers

- **Autonomous:** _(what this agent can do without asking)_
- **Notify:** _(what requires notification to Source)_
- **Consent:** _(what requires group consent)_
`,
    "utf8",
  );

  // governance/groups/<group>.md
  if (group) {
    await writeFile(
      join(targetDir, "governance", "groups", `${group}.md`),
      `# ${group.charAt(0).toUpperCase() + group.slice(1)} Group

## Purpose

_Define this group's purpose._

## Members

- ${agentDir}
`,
      "utf8",
    );
  }

  // .env
  const envLines: string[] = [];
  if (secretName) {
    envLines.push(`${secretName}=your-api-key-here`);
  }
  envLines.push("# GITHUB_TOKEN=ghp_your-token-here");
  const envContent = envLines.join("\n") + "\n";
  const envPath = join(targetDir, ".env");
  await writeFile(envPath, envContent, "utf8");
  await chmod(envPath, 0o600);

  // .gitignore
  await writeFile(
    join(targetDir, ".gitignore"),
    `.env
.murmuration/
`,
    "utf8",
  );

  // -------------------------------------------------------------------
  // Print next steps
  // -------------------------------------------------------------------

  const governanceNote =
    governance !== "none"
      ? `\n4. Boot with governance:\n   murmuration start --root ${target} --governance examples/governance-s3/index.mjs`
      : "";

  console.log(`Done! Created:
  ${targetDir}/
    murmuration/soul.md
    agents/${agentDir}/soul.md
    agents/${agentDir}/role.md${group ? `\n    governance/groups/${group}.md` : ""}
    .env (0600)
    .gitignore

Next steps:

1. Edit .env — add your real API keys
2. Edit the soul.md and role.md files — fill in the placeholders
3. Boot the daemon:
   murmuration start --root ${target}${governanceNote}
`);
};
