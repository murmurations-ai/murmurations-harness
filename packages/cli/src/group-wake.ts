/**
 * `murmuration group-wake` — trigger a group meeting on demand.
 *
 * Usage:
 *   murmuration group-wake --root ../my-murmuration --group content
 *   murmuration group-wake --root ../my-murmuration --group content --governance
 *   murmuration group-wake --root ../my-murmuration --group content --directive "What's our top priority?"
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";

import {
  makeSecretKey,
  IdentityLoader,
  runGroupWake,
  type GroupConfig,
  type GroupWakeContext,
  type GroupWakeKind,
  type GovernanceItem,
  type MeetingAction,
  type ActionReceipt,
  GovernanceStateStore,
} from "@murmuration/core";
import {
  createGithubClient,
  makeRepoCoordinate,
  makeIssueNumber,
  type GithubClient,
  type RepoCoordinate,
} from "@murmuration/github";
import { createLLMClient, type LLMClient } from "@murmuration/llm";
import { DotenvSecretsProvider } from "@murmuration/secrets-dotenv";

const GITHUB_TOKEN = makeSecretKey("GITHUB_TOKEN");

/** Map LLM provider names to their env key names. */
const PROVIDER_SECRET_KEY: Record<string, string | null> = {
  gemini: "GEMINI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  ollama: null,
};

/** Find the GitHub repo from the first available agent's signal scopes via IdentityLoader. */
const findRepoFromAgents = async (
  rootDir: string,
  memberIds: readonly string[],
): Promise<{ owner: string; repo: string } | null> => {
  try {
    const loader = new IdentityLoader({ rootDir });
    for (const memberId of memberIds) {
      try {
        const identity = await loader.load(memberId);
        const scopes = identity.frontmatter.signals.github_scopes;
        if (scopes && scopes.length > 0) {
          const scope = scopes[0]!;
          return { owner: scope.owner, repo: scope.repo };
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* skip */
  }
  return null;
};

/** Resolve LLM provider + model from the facilitator's role.md. */
const resolveLLMConfig = async (
  rootDir: string,
  facilitatorId: string,
): Promise<{ provider: string; model: string } | null> => {
  try {
    const loader = new IdentityLoader({ rootDir });
    const identity = await loader.load(facilitatorId);
    const llm = identity.frontmatter.llm;
    if (llm) {
      return { provider: llm.provider, model: llm.model ?? getDefaultModel(llm.provider) };
    }
  } catch {
    /* skip */
  }
  return null;
};

const getDefaultModel = (provider: string): string => {
  switch (provider) {
    case "gemini":
      return "gemini-2.5-flash";
    case "anthropic":
      return "claude-sonnet-4-20250514";
    case "openai":
      return "gpt-4o";
    case "ollama":
      return "llama3";
    default:
      return "unknown";
  }
};

/** Fetch the group's GitHub issues backlog (by label). */
const fetchGroupBacklog = async (
  rootDir: string,
  _groupId: string,
  repoInfo: { owner: string; repo: string },
): Promise<string> => {
  try {
    const envPath = join(rootDir, ".env");
    if (!existsSync(envPath)) return "(no .env — cannot fetch backlog)";
    const { DotenvSecretsProvider } = await import("@murmuration/secrets-dotenv");
    const provider = new DotenvSecretsProvider({ envPath });
    await provider.load({ required: [makeSecretKey("GITHUB_TOKEN")], optional: [] });
    const { createGithubClient, makeRepoCoordinate } = await import("@murmuration/github");
    const gh = createGithubClient({ token: provider.get(makeSecretKey("GITHUB_TOKEN")) });
    const repo = makeRepoCoordinate(repoInfo.owner, repoInfo.repo);
    const result = await gh.listIssues(repo, { state: "open", perPage: 30 });
    if (!result.ok) return `(backlog fetch failed: ${result.error.code})`;
    const issues = result.value;
    if (issues.length === 0) return "(no open issues)";
    return issues
      .map((i) => `- #${String(i.number.value)} ${i.title} [${i.labels.join(", ")}]`)
      .join("\n");
  } catch (err) {
    return `(backlog fetch error: ${err instanceof Error ? err.message : String(err)})`;
  }
};

/** Parse a simple group config from a group doc's content. */
const parseGroupConfig = (groupId: string, content: string): GroupConfig => {
  // Extract members from "- agent-id" lines under "## Members"
  const membersMatch = /## Members\n([\s\S]*?)(?=\n##|\n---|\n$)/i.exec(content);
  const members: string[] = [];
  if (membersMatch) {
    for (const line of membersMatch[1]?.split("\n") ?? []) {
      const m = /^\s*-\s*(.+)/.exec(line);
      if (m) members.push(m[1]!.trim());
    }
  }

  // Extract facilitator from "facilitator:" in frontmatter or body
  const facMatch = /facilitator:\s*"?([^"\n]+)"?/i.exec(content);
  const facilitator = facMatch?.[1]?.trim() ?? members[0] ?? groupId;

  // Extract name from first heading
  const nameMatch = /^#\s+(.+)/m.exec(content);
  const name = nameMatch?.[1]?.trim() ?? groupId;

  return { groupId, name, members, facilitator };
};

// ---------------------------------------------------------------------------
// Action executor — turns structured actions into GitHub state changes
// ---------------------------------------------------------------------------

const executeActions = async (
  actions: readonly MeetingAction[],
  gh: GithubClient,
  repo: RepoCoordinate,
): Promise<ActionReceipt[]> => {
  const receipts: ActionReceipt[] = [];

  for (const action of actions) {
    try {
      switch (action.kind) {
        case "label-issue": {
          if (!action.issueNumber || !action.label) {
            receipts.push({ action, success: false, error: "missing issueNumber or label" });
            break;
          }
          // Remove old label first if this is a label swap
          if (action.removeLabel) {
            await gh.removeLabel(repo, makeIssueNumber(action.issueNumber), action.removeLabel);
          }
          const result = await gh.addLabels(repo, makeIssueNumber(action.issueNumber), [
            action.label,
          ]);
          if (result.ok) {
            const swap = action.removeLabel ? ` (-${action.removeLabel})` : "";
            console.log(
              `    \x1b[32m✓\x1b[0m label-issue #${String(action.issueNumber)} +${action.label}${swap}`,
            );
            receipts.push({ action, success: true });
          } else {
            console.log(
              `    \x1b[31m✗\x1b[0m label-issue #${String(action.issueNumber)}: ${result.error.code}`,
            );
            receipts.push({ action, success: false, error: result.error.code });
          }
          break;
        }
        case "create-issue": {
          if (!action.title) {
            receipts.push({ action, success: false, error: "missing title" });
            break;
          }
          const issueInput: Record<string, unknown> = { title: action.title };
          if (action.body) issueInput.body = action.body;
          if (action.labels && action.labels.length > 0) issueInput.labels = [...action.labels];
          const result = await gh.createIssue(
            repo,
            issueInput as { title: string; body?: string; labels?: string[] },
          );
          if (result.ok) {
            const num = result.value.number.value;
            console.log(`    \x1b[32m✓\x1b[0m create-issue #${String(num)}: ${action.title}`);
            receipts.push({ action, success: true, issueNumber: num });
          } else {
            console.log(`    \x1b[31m✗\x1b[0m create-issue: ${result.error.code}`);
            receipts.push({ action, success: false, error: result.error.code });
          }
          break;
        }
        case "close-issue": {
          if (!action.issueNumber) {
            receipts.push({ action, success: false, error: "missing issueNumber" });
            break;
          }
          const result = await gh.updateIssueState(
            repo,
            makeIssueNumber(action.issueNumber),
            "closed",
          );
          if (result.ok) {
            console.log(`    \x1b[32m✓\x1b[0m close-issue #${String(action.issueNumber)}`);
            receipts.push({ action, success: true });
          } else {
            console.log(
              `    \x1b[31m✗\x1b[0m close-issue #${String(action.issueNumber)}: ${result.error.code}`,
            );
            receipts.push({ action, success: false, error: result.error.code });
          }
          break;
        }
        case "comment-issue": {
          if (!action.issueNumber || !action.body) {
            receipts.push({ action, success: false, error: "missing issueNumber or body" });
            break;
          }
          const result = await gh.createIssueComment(repo, makeIssueNumber(action.issueNumber), {
            body: action.body,
          });
          if (result.ok) {
            console.log(`    \x1b[32m✓\x1b[0m comment-issue #${String(action.issueNumber)}`);
            receipts.push({ action, success: true });
          } else {
            console.log(
              `    \x1b[31m✗\x1b[0m comment-issue #${String(action.issueNumber)}: ${result.error.code}`,
            );
            receipts.push({ action, success: false, error: result.error.code });
          }
          break;
        }
      }
    } catch (err) {
      receipts.push({
        action,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return receipts;
};

export const runGroupWakeCommand = async (
  args: readonly string[],
  rootDir: string,
): Promise<void> => {
  const root = resolve(rootDir);

  // Parse args
  const groupIdx = args.indexOf("--group");
  const groupId = groupIdx >= 0 ? args[groupIdx + 1] : undefined;
  if (!groupId) {
    console.error("murmuration group-wake: --group <id> is required");
    process.exit(2);
  }

  const isGovernance = args.includes("--governance");
  const kind: GroupWakeKind = isGovernance ? "governance" : "operational";

  const directiveIdx = args.indexOf("--directive");
  const directiveBody = directiveIdx >= 0 ? args[directiveIdx + 1] : undefined;

  // Load group config
  const groupDocPath = join(root, "governance", "groups", `${groupId}.md`);
  if (!existsSync(groupDocPath)) {
    console.error(`murmuration group-wake: group doc not found at ${groupDocPath}`);
    process.exit(1);
  }
  const groupContent = await readFile(groupDocPath, "utf8");
  const config = parseGroupConfig(groupId, groupContent);

  console.log(`Circle wake: ${config.name} (${kind})`);
  console.log(`  Members: ${config.members.join(", ")}`);
  console.log(`  Facilitator: ${config.facilitator}`);
  if (directiveBody) console.log(`  Directive: "${directiveBody}"`);
  console.log("");

  // Resolve LLM provider from facilitator's role.md
  const llmConfig = await resolveLLMConfig(root, config.facilitator);
  if (!llmConfig) {
    console.error(
      `murmuration group-wake: could not read LLM config from facilitator "${config.facilitator}" role.md`,
    );
    process.exit(1);
  }
  console.log(`  LLM: ${llmConfig.provider}/${llmConfig.model}`);

  // Load secrets + clients
  const envPath = join(root, ".env");
  let llmClient: LLMClient | undefined;
  let secretsProvider: DotenvSecretsProvider | undefined;
  const secretKeyName = PROVIDER_SECRET_KEY[llmConfig.provider];
  if (existsSync(envPath)) {
    secretsProvider = new DotenvSecretsProvider({ envPath });
    const optionalKeys = [GITHUB_TOKEN];
    if (secretKeyName) optionalKeys.push(makeSecretKey(secretKeyName));
    await secretsProvider.load({ required: [], optional: optionalKeys });
    const tokenKey = secretKeyName ? makeSecretKey(secretKeyName) : null;
    if (llmConfig.provider === "ollama") {
      llmClient = createLLMClient({
        provider: "ollama",
        token: null,
        model: llmConfig.model,
      });
    } else if (tokenKey && secretsProvider.has(tokenKey)) {
      const provider = llmConfig.provider as "gemini" | "anthropic" | "openai";
      llmClient = createLLMClient({
        provider,
        token: secretsProvider.get(tokenKey),
        model: llmConfig.model,
      });
    }
  }

  if (!llmClient) {
    console.error(`murmuration group-wake: ${secretKeyName ?? "LLM token"} not found in .env`);
    process.exit(1);
  }

  // Load governance queue if governance meeting
  const governanceQueue: GovernanceItem[] = [];
  if (isGovernance) {
    const store = new GovernanceStateStore({
      persistDir: join(root, ".murmuration", "governance"),
    });
    await store.load();
    const pending = store.query();
    // Filter to non-terminal items. Terminal state names are governance-model-defined;
    // the store's registered graphs declare them. If no graphs are registered (CLI
    // standalone), fall back to checking if the state store's graphs can tell us.
    const terminalStates = new Set(store.graphs().flatMap((g) => g.terminalStates));
    if (terminalStates.size > 0) {
      governanceQueue.push(...pending.filter((i) => !terminalStates.has(i.currentState)));
    } else {
      // No graphs registered — include all items and let the meeting decide
      governanceQueue.push(...pending);
    }
  }

  // Fetch the group's GitHub issues backlog for context
  const repoInfo = await findRepoFromAgents(root, config.members);
  let backlogContext = "";
  if (repoInfo) {
    console.log(`  Fetching backlog from ${repoInfo.owner}/${repoInfo.repo}...`);
    backlogContext = await fetchGroupBacklog(root, groupId, repoInfo);
  }

  // Build the effective directive with backlog context
  const backlogSection =
    repoInfo && backlogContext
      ? `\n\n## Open Issues (${repoInfo.owner}/${repoInfo.repo})\n\n${backlogContext}`
      : "";
  const effectiveDirective =
    [directiveBody ?? "", backlogSection].filter(Boolean).join("") || undefined;

  // Build context
  const context: GroupWakeContext = {
    groupId,
    kind,
    members: config.members,
    facilitator: config.facilitator,
    signals: [],
    governanceQueue,
    ...(effectiveDirective ? { directiveBody: effectiveDirective } : {}),
  };

  // Run the group wake
  const client = llmClient;
  const model = llmConfig.model;
  const result = await runGroupWake(context, {
    callLLM: async ({ systemPrompt, userPrompt, agentId }) => {
      console.log(`  [${agentId}] contributing...`);
      const r = await client.complete({
        model,
        messages: [{ role: "user", content: userPrompt }],
        systemPromptOverride: systemPrompt,
        maxOutputTokens: 8000,
        temperature: 0.3,
      });
      if (!r.ok) throw new Error(`LLM failed for ${agentId}: ${r.error.code}`);
      return {
        content: r.value.content,
        inputTokens: r.value.inputTokens,
        outputTokens: r.value.outputTokens,
      };
    },
  });

  // Output
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Circle Meeting: ${config.name} (${kind})`);
  console.log(`${"=".repeat(60)}\n`);

  for (const c of result.contributions) {
    console.log(`--- ${c.agentId} ---`);
    console.log(c.content);
    console.log("");
  }

  console.log(`--- ${config.facilitator} (facilitator synthesis) ---`);
  console.log(result.synthesis);
  console.log("");

  // Execute structured actions from the facilitator
  let receipts: ActionReceipt[] = [];
  if (result.actions.length > 0 && repoInfo && secretsProvider?.has(GITHUB_TOKEN)) {
    console.log(`\n--- Executing ${String(result.actions.length)} action(s) ---\n`);
    const actionGh = createGithubClient({
      token: secretsProvider.get(GITHUB_TOKEN),
      writeScopes: {
        issueComments: [`${repoInfo.owner}/${repoInfo.repo}`],
        branchCommits: [],
        labels: [`${repoInfo.owner}/${repoInfo.repo}`],
        issues: [`${repoInfo.owner}/${repoInfo.repo}`],
      },
    });
    const actionRepo = makeRepoCoordinate(repoInfo.owner, repoInfo.repo);
    receipts = await executeActions(result.actions, actionGh, actionRepo);
    const succeeded = receipts.filter((r) => r.success).length;
    const failed = receipts.filter((r) => !r.success).length;
    console.log(`\n  ${String(succeeded)} succeeded, ${String(failed)} failed`);
  } else if (result.actions.length > 0) {
    console.log(
      `\n--- ${String(result.actions.length)} action(s) proposed but no GitHub access — skipped ---`,
    );
  }

  // Print governance position tallies
  if (result.tallies.length > 0) {
    console.log(`\n--- Governance Tallies ---\n`);
    for (const tally of result.tallies) {
      const countsStr = Object.entries(tally.counts)
        .map(([k, v]) => `${String(v)} ${k}`)
        .join(", ");
      console.log(
        `  Item ${tally.itemId}: ${countsStr} → \x1b[1m${tally.recommendation.toUpperCase()}\x1b[0m`,
      );
      for (const p of tally.positions) {
        console.log(`    ${p.agentId}: \x1b[33m${p.position}\x1b[0m — ${p.reasoning.slice(0, 60)}`);
      }
    }
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log(
    `Tokens: ${String(result.totalInputTokens)} in / ${String(result.totalOutputTokens)} out`,
  );
  console.log(
    `Cost: ~$${((result.totalInputTokens * 0.15 + result.totalOutputTokens * 0.6) / 1_000_000).toFixed(4)}`,
  );

  // Post meeting minutes as a GitHub issue
  const dayUtc = new Date().toISOString().slice(0, 10);
  const minutes = [
    `**Members:** ${config.members.join(", ")}`,
    `**Facilitator:** ${config.facilitator}`,
    directiveBody ? `**Directive:** ${directiveBody}` : "",
    "",
    ...result.contributions.map((c) => `## ${c.agentId}\n\n${c.content}\n`),
    `## Facilitator Synthesis\n\n${result.synthesis}`,
    ...(receipts.length > 0
      ? [
          "\n## Actions Executed\n",
          ...receipts.map((r) => {
            const icon = r.success ? "✅" : "❌";
            const detail =
              r.action.kind === "create-issue" && r.issueNumber
                ? ` → #${String(r.issueNumber)}`
                : r.action.kind === "label-issue"
                  ? ` #${String(r.action.issueNumber)} +${r.action.label ?? ""}`
                  : r.action.kind === "close-issue"
                    ? ` #${String(r.action.issueNumber)}`
                    : r.action.kind === "comment-issue"
                      ? ` #${String(r.action.issueNumber)}`
                      : "";
            return `- ${icon} **${r.action.kind}**${detail}${r.error ? ` — ${r.error}` : ""}`;
          }),
        ]
      : []),
    ...(result.tallies.length > 0
      ? [
          "\n## Consent Round Tallies\n",
          ...result.tallies.map((t) => {
            const countsStr = Object.entries(t.counts)
              .map(([k, v]) => `${k}: ${String(v)}`)
              .join(", ");
            return `### Item ${t.itemId}\n- ${countsStr}\n- Recommendation: **${t.recommendation.toUpperCase()}**\n${t.positions.map((p) => `  - ${p.agentId}: ${p.position}${p.reasoning ? ` — ${p.reasoning}` : ""}`).join("\n")}`;
          }),
        ]
      : []),
    "",
    `---`,
    `_Tokens: ${String(result.totalInputTokens)} in / ${String(result.totalOutputTokens)} out_`,
  ].join("\n");

  const meetingLabel = kind === "governance" ? "governance-meeting" : "group-meeting";
  const repoOwner = repoInfo?.owner ?? "unknown";
  const repoName = repoInfo?.repo ?? "unknown";

  try {
    if (!secretsProvider?.has(GITHUB_TOKEN)) throw new Error("no GITHUB_TOKEN");
    const { makeRepoCoordinate, createGithubClient: createGH } =
      await import("@murmuration/github");
    const meetingGh = createGH({
      token: secretsProvider.get(GITHUB_TOKEN),
      writeScopes: {
        issueComments: [`${repoOwner}/${repoName}`],
        branchCommits: [],
        labels: [],
        issues: [`${repoOwner}/${repoName}`],
      },
    });
    const issueResult = await meetingGh.createIssue(makeRepoCoordinate(repoOwner, repoName), {
      title: `[${kind.toUpperCase()} MEETING] ${config.name} — ${dayUtc}`,
      labels: [meetingLabel, `group:${groupId}`],
      body: minutes,
    });
    if (issueResult.ok) {
      console.log(`\nMeeting minutes: ${issueResult.value.htmlUrl}`);
    } else {
      console.log(`\nFailed to create meeting issue: ${issueResult.error.code}`);
      // Fallback: write locally
      const { writeFile: wf, mkdir } = await import("node:fs/promises");
      const meetingDir = join(root, ".murmuration", "runs", `group-${groupId}`, dayUtc);
      await mkdir(meetingDir, { recursive: true });
      await wf(
        join(meetingDir, `meeting-${randomUUID().slice(0, 8)}.md`),
        `# ${config.name} — ${kind} meeting — ${dayUtc}\n\n${minutes}`,
        "utf8",
      );
      console.log(`  (saved locally as fallback)`);
    }
  } catch {
    // Fallback: write locally if GitHub fails
    const { writeFile: wf, mkdir } = await import("node:fs/promises");
    const meetingDir = join(root, ".murmuration", "runs", `group-${groupId}`, dayUtc);
    await mkdir(meetingDir, { recursive: true });
    await wf(
      join(meetingDir, `meeting-${randomUUID().slice(0, 8)}.md`),
      `# ${config.name} — ${kind} meeting — ${dayUtc}\n\n${minutes}`,
      "utf8",
    );
    console.log(`\nMeeting minutes saved locally (GitHub unavailable).`);
  }
};
