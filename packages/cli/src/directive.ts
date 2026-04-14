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

/** Read the default repo from the first agent's signal scopes via IdentityLoader. */
const findDefaultRepo = async (
  rootDir: string,
): Promise<{ owner: string; repo: string } | null> => {
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

  // Load GitHub client
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) {
    console.error("murmuration directive: .env not found (need GITHUB_TOKEN)");
    process.exit(1);
  }
  const provider = new DotenvSecretsProvider({ envPath });
  await provider.load({ required: [GITHUB_TOKEN], optional: [] });

  // Find the target repo
  const repoInfo = await findDefaultRepo(root);
  if (!repoInfo) {
    console.error(
      "murmuration directive: could not determine target repo from agent role.md files",
    );
    process.exit(1);
  }
  const repoKey = `${repoInfo.owner}/${repoInfo.repo}`;
  const repo = makeRepoCoordinate(repoInfo.owner, repoInfo.repo);
  const gh = createGithubClient({
    token: provider.get(GITHUB_TOKEN),
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
      console.error(`GitHub error: ${result.error.code}`);
      process.exit(1);
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
    console.error("murmuration directive: specify --agent <id>, --group <id>, or --all");
    process.exit(2);
    return;
  }

  // Body is the last positional argument
  const body = args.filter((a) => !a.startsWith("--")).pop();
  if (!body || body.startsWith("--")) {
    console.error("murmuration directive: provide a message body as the last argument");
    process.exit(2);
    return;
  }

  // Create GitHub issue
  const issueResult = await gh.createIssue(repo, {
    title: `[DIRECTIVE] ${body.slice(0, 80)}`,
    labels: ["source-directive", scopeLabel],
    body: [
      `**From:** Source`,
      `**Scope:** ${scopeDesc}`,
      `**Kind:** question`,
      ``,
      body,
      ``,
      `---`,
      `_Created by \`murmuration directive\`. Agents will respond as issue comments on their next wake._`,
    ].join("\n"),
  });

  if (!issueResult.ok) {
    console.error(`GitHub error: ${issueResult.error.code} — ${issueResult.error.message}`);
    process.exit(1);
  }

  console.log(`Directive created: #${String(issueResult.value.number.value)}`);
  console.log(`  URL: ${issueResult.value.htmlUrl}`);
  console.log(`  Scope: ${scopeDesc}`);
  console.log(`  Labels: source-directive, ${scopeLabel}`);
  console.log(`\nAgents will see this issue as a signal on their next wake.`);
};
