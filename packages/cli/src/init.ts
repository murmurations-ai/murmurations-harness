/**
 * `murmuration init` — interactive scaffolding for a new murmuration.
 *
 * Creates a directory structure the daemon can boot against:
 *
 *   <target>/
 *     murmuration/
 *       soul.md              — murmuration purpose + bright lines
 *       harness.yaml         — runtime config (governance, etc.)
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
 * The init interview is minimal — ask a few questions, produce maximum
 * scaffolding with inline comments guiding later hand-edits.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline";

import { providerEnvKeyName } from "@murmurations-ai/llm";

import { seedBuiltinProviders } from "./builtin-providers/seed.js";

// DO NOT create readline at module scope — it grabs stdin and corrupts
// terminal mode for other commands (e.g., attach REPL double echo).
let rl: Interface | null = null;
const getRL = (): Interface => {
  rl ??= createInterface({ input: process.stdin, output: process.stdout });
  return rl;
};
const ask = (question: string): Promise<string> =>
  new Promise((r) => {
    getRL().question(question, r);
  });

// ---------------------------------------------------------------------------
// Agent question helper
// ---------------------------------------------------------------------------

interface AgentAnswers {
  readonly name: string;
  readonly dir: string;
  readonly provider: string;
  readonly group: string;
  readonly schedule: string;
}

const VALID_PROVIDERS = new Set(["gemini", "anthropic", "openai", "ollama"]);

const normalizeProvider = (input: string, fallback: string): string => {
  const v = input.trim().toLowerCase();
  if (!v) return fallback;
  return VALID_PROVIDERS.has(v) ? v : fallback;
};

const askAgentQuestions = async (
  isFirst: boolean,
  defaultProvider: string,
): Promise<AgentAnswers> => {
  const namePrompt = isFirst
    ? "Name your first agent (e.g. research, coordinator, builder): "
    : "Agent name: ";
  const name = await ask(namePrompt);
  const dir = name.trim().toLowerCase().replace(/\s+/g, "-");

  const providerInput = await ask(
    `  LLM provider override (gemini / anthropic / openai / ollama) [${defaultProvider}]: `,
  );
  const provider = normalizeProvider(providerInput, defaultProvider);

  const groupInput = await ask("  Group this agent belongs to (or Enter for none): ");
  const group = groupInput.trim().toLowerCase().replace(/\s+/g, "-") || "";

  const scheduleInput = await ask(
    "  Wake schedule (daily / hourly / custom cron / Enter for 2s delay): ",
  );
  const schedule = scheduleInput.trim().toLowerCase();

  return { name: name.trim(), dir, provider, group, schedule };
};

const formatScheduleYaml = (schedule: string): string => {
  if (schedule === "daily") return 'cron: "0 9 * * *"  # daily at 9am UTC';
  if (schedule === "hourly") return 'cron: "0 * * * *"  # every hour';
  if (schedule.includes("*") || schedule.includes("/")) return `cron: "${schedule}"`;
  return 'delayMs: 2000  # Change to cron for scheduled wakes: cron: "0 18 * * *"';
};

// ---------------------------------------------------------------------------
// Main init
// ---------------------------------------------------------------------------

export const runInit = async (targetArg?: string): Promise<void> => {
  seedBuiltinProviders();
  console.log("\nmurmuration init — create a new murmuration\n");

  // 1. Target directory
  const target = targetArg ?? (await ask("Directory to create (e.g. ../my-murmuration): "));
  const targetDir = resolve(target.trim());

  if (existsSync(targetDir)) {
    const existing = await ask(`${targetDir} already exists. Continue? (y/N): `);
    if (existing.trim().toLowerCase() !== "y") {
      console.log("Aborted.");
      rl?.close();
      return;
    }
  }

  // 2. Murmuration purpose
  const purpose = await ask("What is this murmuration's purpose? (one sentence): ");

  // 3. Default LLM provider (harness-level). Agents + the Spirit inherit this
  //    unless an agent's role.md or a spirit.md (Phase 2) overrides.
  const defaultProviderInput = await ask(
    "Default LLM provider (gemini / anthropic / openai / ollama) [gemini]: ",
  );
  const defaultProvider = normalizeProvider(defaultProviderInput, "gemini");

  // 4. GitHub config (optional)
  const githubInput = await ask("GitHub repo (e.g. org/repo, or Enter to skip): ");
  const githubRepo = githubInput.trim();
  let githubOwner = "";
  let githubRepoName = "";
  if (githubRepo.includes("/")) {
    const parts = githubRepo.split("/");
    githubOwner = parts[0] ?? "";
    githubRepoName = parts[1] ?? "";
  }

  // 5. Agents
  const agents: AgentAnswers[] = [];
  agents.push(await askAgentQuestions(true, defaultProvider));

  let addMore = await ask("\nAdd another agent? (y/N): ");
  while (addMore.trim().toLowerCase() === "y") {
    agents.push(await askAgentQuestions(false, defaultProvider));
    addMore = await ask("\nAdd another agent? (y/N): ");
  }

  // 5. Governance model
  const govInput = await ask(
    "\nGovernance model (self-organizing / chain-of-command / meritocratic / consensus / parliamentary / none) [none]: ",
  );
  const governance = govInput.trim().toLowerCase() || "none";

  rl?.close();

  // -------------------------------------------------------------------
  // Write the files
  // -------------------------------------------------------------------

  console.log(`\nCreating murmuration at ${targetDir}...\n`);

  // Collect all groups
  const groups = [...new Set(agents.map((a) => a.group).filter(Boolean))];

  // Directories
  await mkdir(join(targetDir, "murmuration"), { recursive: true });
  for (const agent of agents) {
    await mkdir(join(targetDir, "agents", agent.dir), { recursive: true });
  }
  if (groups.length > 0) {
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

  // murmuration/harness.yaml
  const governancePluginMap: Record<string, string> = {
    "self-organizing": "@murmurations-ai/governance-s3",
    "chain-of-command": "@murmurations-ai/governance-command",
    meritocratic: "@murmurations-ai/governance-meritocratic",
    consensus: "@murmurations-ai/governance-consensus",
    parliamentary: "@murmurations-ai/governance-parliamentary",
  };
  const governancePlugin = governancePluginMap[governance];
  const governanceBlock =
    governance !== "none"
      ? `governance:\n  model: "${governance}"\n  plugin: "${governancePlugin ?? governance}"`
      : `governance:\n  model: none`;
  await writeFile(
    join(targetDir, "murmuration", "harness.yaml"),
    `# Murmuration Harness configuration
# This file is read by the daemon at boot.

# Default LLM for agents and the Spirit of the Murmuration.
# Agents may override via their role.md 'llm:' frontmatter.
llm:
  provider: "${defaultProvider}"

${governanceBlock}
`,
    "utf8",
  );

  // Write each agent
  const secretNames = new Set<string>();
  for (const agent of agents) {
    // soul.md
    await writeFile(
      join(targetDir, "agents", agent.dir, "soul.md"),
      `# ${agent.name} — Soul

## Who I am

_Describe this agent's character, perspective, and approach._

## What I will never do

_Define the agent-specific bright lines beyond the murmuration soul._
`,
      "utf8",
    );

    // role.md
    const secretName = providerEnvKeyName(agent.provider) ?? "";
    if (secretName) secretNames.add(secretName);
    const groupLine = agent.group ? `\n  - "${agent.group}"` : "";
    const ghScopes = githubOwner
      ? `
  github_scopes:
    - owner: "${githubOwner}"
      repo: "${githubRepoName}"`
      : "";
    const writeScopes = githubOwner
      ? `
    issue_comments: ["${githubOwner}/${githubRepoName}"]
    branch_commits:
      - repo: "${githubOwner}/${githubRepoName}"
        paths: ["**"]
    labels: ["${githubOwner}/${githubRepoName}"]
    issues: ["${githubOwner}/${githubRepoName}"]`
      : `
    issue_comments: []
    branch_commits: []
    labels: []
    issues: []`;

    await writeFile(
      join(targetDir, "agents", agent.dir, "role.md"),
      `---
agent_id: "${agent.dir}"
name: "${agent.name}"
model_tier: "balanced"
max_wall_clock_ms: 120000
group_memberships:${groupLine || "\n  []"}

llm:
  provider: "${agent.provider}"

wake_schedule:
  ${formatScheduleYaml(agent.schedule)}

signals:
  sources:
    - "github-issue"
    - "private-note"${ghScopes}

github:
  write_scopes:${writeScopes}

budget:
  max_cost_micros: 100000
  max_github_api_calls: 10
  on_breach: "warn"

secrets:
  required: [${secretName ? `"${secretName}"` : ""}]
  optional: ["GITHUB_TOKEN"]
---

# ${agent.name} — Role

## Accountabilities

1. _(define what this agent is responsible for)_

## Decision tiers

- **Autonomous:** _(what this agent can do without asking)_
- **Notify:** _(what requires notification to Source)_
- **Consent:** _(what requires group consent)_
`,
      "utf8",
    );
  }

  // Group docs
  for (const group of groups) {
    const members = agents.filter((a) => a.group === group).map((a) => a.dir);
    await writeFile(
      join(targetDir, "governance", "groups", `${group}.md`),
      `# ${group.charAt(0).toUpperCase() + group.slice(1)} Group

## Purpose

_Define this group's purpose._

## Members

${members.map((m) => `- ${m}`).join("\n")}
`,
      "utf8",
    );
  }

  // .env
  const envLines: string[] = [];
  for (const secret of secretNames) {
    envLines.push(`${secret}=your-api-key-here`);
  }
  if (githubOwner) {
    envLines.push("GITHUB_TOKEN=ghp_your-token-here");
  } else {
    envLines.push("# GITHUB_TOKEN=ghp_your-token-here");
  }
  const envContent = envLines.join("\n") + "\n";
  const envPath = join(targetDir, ".env");
  await writeFile(envPath, envContent, "utf8");
  await chmod(envPath, 0o600);

  // .gitignore
  await writeFile(join(targetDir, ".gitignore"), ".env\n.murmuration/\n", "utf8");

  // Register session
  const sessionName = targetDir.split("/").pop() ?? "murmuration";
  try {
    const { registerSession } = await import("./sessions.js");
    registerSession(sessionName, targetDir);
  } catch {
    // sessions module may not be available in all contexts
  }

  // -------------------------------------------------------------------
  // Print next steps
  // -------------------------------------------------------------------

  const agentList = agents.map((a) => `    agents/${a.dir}/soul.md + role.md`).join("\n");
  const groupList =
    groups.length > 0 ? "\n" + groups.map((g) => `    governance/groups/${g}.md`).join("\n") : "";

  const governanceNote =
    governance !== "none"
      ? `\n4. To use governance, point to the plugin:\n   murmuration start --name ${sessionName} --governance examples/governance-s3/index.mjs`
      : "";

  const githubNote = githubOwner
    ? `\n${governance !== "none" ? "5" : "4"}. Ensure GITHUB_TOKEN has repo scope for ${githubOwner}/${githubRepoName}`
    : "";

  console.log(`Done! Created:
  ${targetDir}/
    murmuration/soul.md
    murmuration/harness.yaml
${agentList}${groupList}
    .env (0600)
    .gitignore

Registered as "${sessionName}".

Next steps:

1. Edit .env — add your real API keys
2. Edit the soul.md and role.md files — fill in the placeholders
3. Boot the daemon:
   murmuration start --name ${sessionName}${governanceNote}${githubNote}
`);
};
