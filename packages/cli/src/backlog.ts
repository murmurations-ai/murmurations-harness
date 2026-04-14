/**
 * `murmuration backlog` — view and manage a group's GitHub work queue.
 *
 * Usage:
 *   murmuration backlog --root ../my-murmuration --group content
 *   murmuration backlog --root ../my-murmuration --group content --refresh
 */

import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";

import { makeSecretKey } from "@murmurations-ai/core";
import { createGithubClient, makeRepoCoordinate } from "@murmurations-ai/github";
import { DotenvSecretsProvider } from "@murmurations-ai/secrets-dotenv";

const GITHUB_TOKEN = makeSecretKey("GITHUB_TOKEN");

export interface BacklogItem {
  readonly number: number;
  readonly title: string;
  readonly labels: readonly string[];
  readonly state: "open" | "closed";
  readonly url: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const runBacklog = async (args: readonly string[], rootDir: string): Promise<void> => {
  const root = resolve(rootDir);

  const groupIdx = args.indexOf("--group");
  const groupId = groupIdx >= 0 ? args[groupIdx + 1] : undefined;
  if (!groupId) {
    console.error("murmuration backlog: --group <id> is required");
    process.exit(2);
  }

  const repoIdx = args.indexOf("--repo");
  const repoArg = repoIdx >= 0 ? args[repoIdx + 1] : undefined;

  const doRefresh = args.includes("--refresh");
  const backlogDir = join(root, ".murmuration", "backlogs");
  const backlogFile = join(backlogDir, `${groupId}.json`);

  // Load group config to get backlog label + repo
  const groupDocPath = join(root, "governance", "groups", `${groupId}.md`);
  let backlogLabel = `group:${groupId}`;
  let backlogRepo = repoArg ?? "";

  if (existsSync(groupDocPath)) {
    const content = await readFile(groupDocPath, "utf8");
    const labelMatch = /backlog_label:\s*"?([^"\n]+)"?/i.exec(content);
    if (labelMatch) backlogLabel = labelMatch[1]!.trim();
    const repoMatch = /backlog_repo:\s*"?([^"\n]+)"?/i.exec(content);
    if (repoMatch) backlogRepo = repoMatch[1]!.trim();
  }

  if (doRefresh && !backlogRepo) {
    console.error(
      "murmuration backlog: no repo configured. Use --repo owner/repo or set backlog_repo: in the group doc.",
    );
    process.exit(2);
  }

  if (doRefresh) {
    // Fetch from GitHub
    const envPath = join(root, ".env");
    if (!existsSync(envPath)) {
      console.error("murmuration backlog: .env not found (need GITHUB_TOKEN for --refresh)");
      process.exit(1);
    }
    const provider = new DotenvSecretsProvider({ envPath });
    await provider.load({ required: [GITHUB_TOKEN], optional: [] });

    const [owner, repo] = backlogRepo.split("/");
    if (!owner || !repo) {
      console.error(`murmuration backlog: invalid repo "${backlogRepo}"`);
      process.exit(1);
    }

    const gh = createGithubClient({ token: provider.get(GITHUB_TOKEN) });
    const repoCoord = makeRepoCoordinate(owner, repo);

    console.log(`Refreshing ${groupId} backlog from ${backlogRepo} (label: "${backlogLabel}")...`);

    const result = await gh.listIssues(repoCoord, {
      state: "open",
      labels: [backlogLabel],
      perPage: 30,
    });

    if (!result.ok) {
      console.error(`GitHub error: ${result.error.code} — ${result.error.message}`);
      process.exit(1);
    }

    const items: BacklogItem[] = result.value.map((issue) => ({
      number: issue.number.value,
      title: issue.title,
      labels: issue.labels,
      state: issue.state,
      url: issue.htmlUrl,
      createdAt: issue.createdAt.toISOString(),
      updatedAt: issue.updatedAt.toISOString(),
    }));

    await mkdir(backlogDir, { recursive: true });
    await writeFile(backlogFile, JSON.stringify(items, null, 2) + "\n", "utf8");
    console.log(`Saved ${String(items.length)} items to ${backlogFile}\n`);
  }

  // Display backlog
  let items: BacklogItem[];
  try {
    const content = await readFile(backlogFile, "utf8");
    items = JSON.parse(content) as BacklogItem[];
  } catch {
    console.log(`No backlog cached for ${groupId}. Run with --refresh to fetch from GitHub.`);
    return;
  }

  if (items.length === 0) {
    console.log(`${groupId} backlog is empty.`);
    return;
  }

  console.log(`${groupId} backlog (${String(items.length)} items):\n`);
  for (const [idx, item] of items.entries()) {
    const labels = item.labels.filter((l) => l !== backlogLabel).join(", ");
    const labelStr = labels ? ` [${labels}]` : "";
    console.log(
      `  ${String(idx + 1).padStart(2)}. #${String(item.number).padEnd(5)} ${item.title.slice(0, 60)}${labelStr}`,
    );
  }
};
