/**
 * `murmuration directive` — Source → murmuration communication via GitHub issues.
 *
 * Directives are GitHub issues with the `source-directive` label + scope labels.
 * Agents see them through the existing signal aggregator (listIssues).
 * Responses are issue comments.
 *
 * Usage:
 *   murmuration directive --root ../my-murmuration --agent 01-research "Validate this topic"
 *   murmuration directive --root ../my-murmuration --group content "Should this group hold meetings?"
 *   murmuration directive --root ../my-murmuration --all "Propose your ideal wake cadence"
 *   murmuration directive --root ../my-murmuration --list
 */

import { existsSync } from "node:fs";
import { resolve, join } from "node:path";

import { makeSecretKey, IdentityLoader } from "@murmurations-ai/core";
import { createGithubClient, makeRepoCoordinate } from "@murmurations-ai/github";
import { DotenvSecretsProvider } from "@murmurations-ai/secrets-dotenv";

const GITHUB_TOKEN = makeSecretKey("GITHUB_TOKEN");

/** Read the target repo — first from harness.yaml, then from agent signal scopes. */
const findDefaultRepo = async (
  rootDir: string,
): Promise<{ owner: string; repo: string } | null> => {
  // Try harness.yaml first (ADR-0021: murmuration repo is the governance target)
  try {
    const { loadHarnessConfig } = await import("./harness-config.js");
    const config = await loadHarnessConfig(rootDir);
    if (config.collaboration.repo) {
      const parts = config.collaboration.repo.split("/");
      if (parts.length === 2 && parts[0] && parts[1]) {
        return { owner: parts[0], repo: parts[1] };
      }
    }
  } catch {
    /* no harness.yaml — try agent scopes */
  }

  // Fall back to agent signal scopes
  try {
    const loader = new IdentityLoader({ rootDir });
    const agentIds = await loader.discover();
    for (const agentId of agentIds) {
      try {
        const identity = await loader.load(agentId);
        const scopes = identity.frontmatter.signals.github_scopes;
        if (scopes && scopes.length > 0) {
          const scope = scopes[0]!;
          return { owner: scope.owner, repo: scope.repo };
        }
      } catch {
        /* skip agents that can't be loaded */
      }
    }
  } catch {
    /* skip */
  }
  return null;
};

export const runDirective = async (args: readonly string[], rootDir: string): Promise<void> => {
  const root = resolve(rootDir);

  // Load harness config to determine collaboration provider
  const { loadHarnessConfig } = await import("./harness-config.js");
  const config = await loadHarnessConfig(root);

  // Determine scope
  const agentIdx = args.indexOf("--agent");
  const groupIdx = args.indexOf("--group");
  const allFlag = args.includes("--all");

  let scopeLabel: string;
  let scopeDesc: string;
  const agentArg = args[agentIdx + 1];
  const groupArg = args[groupIdx + 1];
  if (agentIdx >= 0 && agentArg) {
    scopeLabel = `scope:agent:${agentArg}`;
    scopeDesc = `agent ${agentArg}`;
  } else if (groupIdx >= 0 && groupArg) {
    scopeLabel = `scope:group:${groupArg}`;
    scopeDesc = `group ${groupArg}`;
  } else if (allFlag) {
    scopeLabel = "scope:all";
    scopeDesc = "all agents";
  } else {
    throw new Error("murmuration directive: specify --agent <id>, --group <id>, or --all");
  }

  // Body is the last positional argument
  const body = args.filter((a) => !a.startsWith("--")).pop();
  if (!body || body.startsWith("--")) {
    throw new Error("murmuration directive: provide a message body as the last argument");
  }

  const directiveBody = [
    `**From:** Source`,
    `**Scope:** ${scopeDesc}`,
    `**Kind:** question`,
    ``,
    body,
    ``,
    `---`,
    `_Created by \`murmuration directive\`. Agents will respond on their next wake._`,
  ].join("\n");

  // Use CollaborationProvider (local or GitHub) based on harness.yaml
  if (config.collaboration.provider === "local") {
    // Local mode — create item in filesystem
    const { LocalCollaborationProvider } = await import("@murmurations-ai/core");
    const collab = new LocalCollaborationProvider({
      itemsDir: join(root, ".murmuration", "items"),
      artifactsDir: root,
    });
    const result = await collab.createItem({
      title: `[DIRECTIVE] ${body.slice(0, 80)}`,
      body: directiveBody,
      labels: ["source-directive", scopeLabel],
    });
    if (!result.ok) {
      throw new Error(`Local provider error: ${result.error.message}`);
    }
    console.log(`Directive created: ${result.value.id}`);
    console.log(`  Scope: ${scopeDesc}`);
    console.log(`  Labels: source-directive, ${scopeLabel}`);
    console.log(`\nAgents will see this item as a signal on their next wake.`);
    return;
  }

  // GitHub mode — create issue
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) {
    throw new Error("murmuration directive: .env not found (need GITHUB_TOKEN)");
  }
  const secretsProvider = new DotenvSecretsProvider({ envPath });
  await secretsProvider.load({ required: [GITHUB_TOKEN], optional: [] });

  const repoInfo = await findDefaultRepo(root);
  if (!repoInfo) {
    throw new Error(
      "murmuration directive: could not determine target repo. Set collaboration.repo in murmuration/harness.yaml or configure github_scopes in an agent's role.md.",
    );
  }
  const repoKey = `${repoInfo.owner}/${repoInfo.repo}`;
  const repo = makeRepoCoordinate(repoInfo.owner, repoInfo.repo);
  const gh = createGithubClient({
    token: secretsProvider.get(GITHUB_TOKEN),
    writeScopes: {
      issueComments: [repoKey],
      branchCommits: [],
      labels: [],
      issues: [repoKey],
    },
  });

  // --list mode
  if (args.includes("--list")) {
    const result = await gh.listIssues(repo, {
      state: "all",
      labels: ["source-directive"],
      perPage: 20,
    });
    if (!result.ok) {
      throw new Error(`GitHub error: ${result.error.code}`);
    }
    if (result.value.length === 0) {
      console.log("No directives found.");
      return;
    }
    for (const issue of result.value) {
      const state = issue.state === "open" ? "pending" : "responded";
      const scope = issue.labels.find((l) => l.startsWith("scope:")) ?? "scope:?";
      console.log(
        `  #${String(issue.number.value).padEnd(5)} ${state.padEnd(10)} ${scope.padEnd(20)} ${issue.title.slice(0, 60)}`,
      );
    }
    return;
  }

  const issueResult = await gh.createIssue(repo, {
    title: `[DIRECTIVE] ${body.slice(0, 80)}`,
    labels: ["source-directive", scopeLabel],
    body: directiveBody,
  });

  if (!issueResult.ok) {
    throw new Error(`GitHub error: ${issueResult.error.code} — ${issueResult.error.message}`);
  }

  console.log(`Directive created: #${String(issueResult.value.number.value)}`);
  console.log(`  URL: ${issueResult.value.htmlUrl}`);
  console.log(`  Scope: ${scopeDesc}`);
  console.log(`  Labels: source-directive, ${scopeLabel}`);
  console.log(`\nAgents will see this issue as a signal on their next wake.`);
};
