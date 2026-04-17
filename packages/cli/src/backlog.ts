/**
 * `murmuration backlog` — view and manage a group's work queue via the
 * configured {@link CollaborationProvider} (GitHub issues or local items).
 *
 * Usage:
 *   murmuration backlog --root ../my-murmuration --group content
 *   murmuration backlog --root ../my-murmuration --group content --refresh
 */

import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";

import { buildCollaborationProvider, CollaborationBuildError } from "./collaboration-factory.js";

export interface BacklogItem {
  readonly number: string;
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

  const doRefresh = args.includes("--refresh");
  const backlogDir = join(root, ".murmuration", "backlogs");
  const backlogFile = join(backlogDir, `${groupId}.json`);

  // Load group config to get backlog label
  const groupDocPath = join(root, "governance", "groups", `${groupId}.md`);
  let backlogLabel = `group:${groupId}`;

  if (existsSync(groupDocPath)) {
    const content = await readFile(groupDocPath, "utf8");
    const labelMatch = /backlog_label:\s*"?([^"\n]+)"?/i.exec(content);
    if (labelMatch?.[1]) backlogLabel = labelMatch[1].trim();
  }

  if (doRefresh) {
    let provider;
    try {
      ({ provider } = await buildCollaborationProvider(root));
    } catch (err) {
      if (err instanceof CollaborationBuildError) {
        console.error(`murmuration backlog: ${err.message}`);
        process.exit(1);
      }
      throw err;
    }

    console.log(
      `Refreshing ${groupId} backlog via ${provider.displayName} (label: "${backlogLabel}")...`,
    );

    const result = await provider.listItems({
      state: "open",
      labels: [backlogLabel],
      limit: 30,
    });

    if (!result.ok) {
      console.error(
        `${provider.displayName} error: ${result.error.code} — ${result.error.message}`,
      );
      process.exit(1);
    }

    const items: BacklogItem[] = result.value.map((item) => ({
      number: item.ref.id,
      title: item.title,
      labels: item.labels,
      state: item.state,
      url: item.ref.url ?? "",
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
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
    console.log(`No backlog cached for ${groupId}. Run with --refresh to fetch.`);
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
      `  ${String(idx + 1).padStart(2)}. ${item.number.padEnd(6)} ${item.title.slice(0, 60)}${labelStr}`,
    );
  }
};
