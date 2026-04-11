/**
 * `murmuration backlog` — view and manage a circle's GitHub work queue.
 *
 * Usage:
 *   murmuration backlog --root ../my-murmuration --circle content
 *   murmuration backlog --root ../my-murmuration --circle content --refresh
 */

import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";

import { makeSecretKey } from "@murmuration/core";
import { createGithubClient, makeRepoCoordinate } from "@murmuration/github";
import { DotenvSecretsProvider } from "@murmuration/secrets-dotenv";

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

  const circleIdx = args.indexOf("--circle");
  const circleId = circleIdx >= 0 ? args[circleIdx + 1] : undefined;
  if (!circleId) {
    console.error("murmuration backlog: --circle <id> is required");
    process.exit(2);
  }

  const doRefresh = args.includes("--refresh");
  const backlogDir = join(root, ".murmuration", "backlogs");
  const backlogFile = join(backlogDir, `${circleId}.json`);

  // Load circle config to get backlog label + repo
  const circleDocPath = join(root, "governance", "circles", `${circleId}.md`);
  let backlogLabel = `circle: ${circleId}`;
  let backlogRepo = "xeeban/emergent-praxis"; // default, should be configurable

  if (existsSync(circleDocPath)) {
    const content = await readFile(circleDocPath, "utf8");
    const labelMatch = /backlog_label:\s*"?([^"\n]+)"?/i.exec(content);
    if (labelMatch) backlogLabel = labelMatch[1]!.trim();
    const repoMatch = /backlog_repo:\s*"?([^"\n]+)"?/i.exec(content);
    if (repoMatch) backlogRepo = repoMatch[1]!.trim();
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

    console.log(`Refreshing ${circleId} backlog from ${backlogRepo} (label: "${backlogLabel}")...`);

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
    console.log(`No backlog cached for ${circleId}. Run with --refresh to fetch from GitHub.`);
    return;
  }

  if (items.length === 0) {
    console.log(`${circleId} backlog is empty.`);
    return;
  }

  console.log(`${circleId} backlog (${String(items.length)} items):\n`);
  for (const [idx, item] of items.entries()) {
    const labels = item.labels.filter((l) => l !== backlogLabel).join(", ");
    const labelStr = labels ? ` [${labels}]` : "";
    console.log(`  ${String(idx + 1).padStart(2)}. #${String(item.number).padEnd(5)} ${item.title.slice(0, 60)}${labelStr}`);
  }
};
