/**
 * Murmuration overview — Workstream P.
 *
 * Walks the canonical murmuration layout (ADR-0026) and produces a
 * structured summary that Spirit can serve in lieu of "let me read 10
 * files first" every time Source asks "what is this murmuration?"
 *
 * Sources read:
 *   <root>/murmuration/harness.yaml          — governance model, plugin
 *   <root>/murmuration/soul.md               — first paragraph (purpose)
 *   <root>/agents/<slug>/role.md             — frontmatter only
 *   <root>/governance/groups/<id>.md         — first line + Members section
 *
 * Result is auto-cached at:
 *   <root>/.murmuration/spirit/memory/project_murmuration_overview.md
 *
 * Cache invalidates when any source file's mtime is newer than the
 * cache file's mtime. Force re-walk via { refresh: true }.
 *
 * @see docs/specs/0002-spirit-meta-agent.md §5 Workstream P
 */

import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import { SpiritMemory } from "./memory.js";

export interface AgentSummary {
  readonly agentId: string;
  readonly name: string | undefined;
  readonly modelTier: string | undefined;
  readonly wakeSchedule: string | undefined;
  readonly groups: readonly string[];
  readonly writeScopes: readonly string[];
}

export interface GroupSummary {
  readonly groupId: string;
  readonly title: string | undefined;
  readonly facilitator: string | undefined;
  readonly members: readonly string[];
}

export interface MurmurationOverview {
  readonly governanceModel: string | undefined;
  readonly governancePlugin: string | undefined;
  readonly llmProvider: string | undefined;
  readonly llmModel: string | undefined;
  readonly purpose: string | undefined;
  readonly agents: readonly AgentSummary[];
  readonly groups: readonly GroupSummary[];
  readonly generatedAt: string;
  readonly fromCache: boolean;
}

const CACHE_NAME = "project_murmuration_overview";

export interface DescribeOptions {
  readonly refresh?: boolean;
}

/**
 * Build a structured + markdown overview of the murmuration. Reads
 * cached result when available + still fresh; otherwise walks the
 * source files and writes a new cache entry.
 */
export const describeMurmuration = async (
  rootDir: string,
  options: DescribeOptions = {},
): Promise<{ readonly overview: MurmurationOverview; readonly markdown: string }> => {
  const memory = new SpiritMemory(rootDir);
  const cachePath = join(memory.dir, `${CACHE_NAME}.md`);
  const refresh = options.refresh === true;

  // Try cache first.
  if (!refresh) {
    const cached = await tryReadCache(rootDir, cachePath);
    if (cached) return cached;
  }

  // Fresh walk.
  const overview = await walkMurmuration(rootDir);
  const markdown = renderMarkdown(overview);
  await memory.remember({
    type: "project",
    name: CACHE_NAME,
    description:
      "Auto-generated murmuration overview (governance, agents, groups). Refreshed when source files change.",
    body: markdown,
  });
  return { overview, markdown };
};

// ---------------------------------------------------------------------------
// Cache check
// ---------------------------------------------------------------------------

const tryReadCache = async (
  rootDir: string,
  cachePath: string,
): Promise<{ readonly overview: MurmurationOverview; readonly markdown: string } | null> => {
  if (!existsSync(cachePath)) return null;

  let cacheStat: Awaited<ReturnType<typeof stat>>;
  try {
    cacheStat = await stat(cachePath);
  } catch {
    return null;
  }

  // Check if any source file is newer than cache.
  const sourcePaths = await collectSourcePaths(rootDir);
  for (const p of sourcePaths) {
    try {
      const s = await stat(p);
      if (s.mtimeMs > cacheStat.mtimeMs) return null;
    } catch {
      /* missing source — skip */
    }
  }

  // Cache is fresh — read + parse it back. The cache is the rendered
  // markdown plus a frontmatter; we re-walk to rebuild the structured
  // overview because the markdown is lossy. Walking is cheap.
  const overview = await walkMurmuration(rootDir);
  let cacheBody: string;
  try {
    cacheBody = await readFile(cachePath, "utf8");
  } catch {
    return null;
  }
  const fm = /^---\n[\s\S]*?\n---\n?/m.exec(cacheBody);
  const markdown = fm ? cacheBody.slice(fm[0].length).trim() : cacheBody.trim();
  return { overview: { ...overview, fromCache: true }, markdown };
};

const collectSourcePaths = async (rootDir: string): Promise<readonly string[]> => {
  const paths: string[] = [
    join(rootDir, "murmuration", "harness.yaml"),
    join(rootDir, "murmuration", "soul.md"),
  ];
  // agents/*/role.md
  try {
    const agentEntries = await readdir(join(rootDir, "agents"), { withFileTypes: true });
    for (const e of agentEntries) {
      if (e.isDirectory()) paths.push(join(rootDir, "agents", e.name, "role.md"));
    }
  } catch {
    /* no agents/ */
  }
  // governance/groups/*.md
  try {
    const groupEntries = await readdir(join(rootDir, "governance", "groups"), {
      withFileTypes: true,
    });
    for (const e of groupEntries) {
      if (e.isFile() && e.name.endsWith(".md")) {
        paths.push(join(rootDir, "governance", "groups", e.name));
      }
    }
  } catch {
    /* no groups */
  }
  return paths;
};

// ---------------------------------------------------------------------------
// Walk the source layout
// ---------------------------------------------------------------------------

const walkMurmuration = async (rootDir: string): Promise<MurmurationOverview> => {
  const harness = await readHarnessYaml(rootDir);
  const purpose = await readSoulPurpose(rootDir);
  const agents = await readAgents(rootDir);
  const groups = await readGroups(rootDir);

  return {
    governanceModel: harness.governanceModel,
    governancePlugin: harness.governancePlugin,
    llmProvider: harness.llmProvider,
    llmModel: harness.llmModel,
    purpose,
    agents,
    groups,
    generatedAt: new Date().toISOString(),
    fromCache: false,
  };
};

interface HarnessFields {
  readonly governanceModel: string | undefined;
  readonly governancePlugin: string | undefined;
  readonly llmProvider: string | undefined;
  readonly llmModel: string | undefined;
}

interface HarnessYamlShape {
  readonly governance?: { readonly model?: unknown; readonly plugin?: unknown };
  readonly llm?: { readonly provider?: unknown; readonly model?: unknown };
}

const readHarnessYaml = async (rootDir: string): Promise<HarnessFields> => {
  const path = join(rootDir, "murmuration", "harness.yaml");
  try {
    const content = await readFile(path, "utf8");
    const parsed = parseYaml(content) as HarnessYamlShape | undefined;
    if (!parsed) return emptyHarness();
    return {
      governanceModel:
        typeof parsed.governance?.model === "string" ? parsed.governance.model : undefined,
      governancePlugin:
        typeof parsed.governance?.plugin === "string" ? parsed.governance.plugin : undefined,
      llmProvider: typeof parsed.llm?.provider === "string" ? parsed.llm.provider : undefined,
      llmModel: typeof parsed.llm?.model === "string" ? parsed.llm.model : undefined,
    };
  } catch {
    return emptyHarness();
  }
};

const emptyHarness = (): HarnessFields => ({
  governanceModel: undefined,
  governancePlugin: undefined,
  llmProvider: undefined,
  llmModel: undefined,
});

const readSoulPurpose = async (rootDir: string): Promise<string | undefined> => {
  const path = join(rootDir, "murmuration", "soul.md");
  try {
    const content = await readFile(path, "utf8");
    // Strip frontmatter if present, then take the first non-empty,
    // non-heading paragraph.
    const stripped = content.replace(/^---\n[\s\S]*?\n---\n?/m, "");
    const paragraphs = stripped.split(/\n\s*\n/);
    for (const p of paragraphs) {
      const trimmed = p.trim();
      if (trimmed.length === 0) continue;
      if (trimmed.startsWith("#")) continue;
      return trimmed.slice(0, 400);
    }
    return undefined;
  } catch {
    return undefined;
  }
};

const readAgents = async (rootDir: string): Promise<readonly AgentSummary[]> => {
  const agentsDir = join(rootDir, "agents");
  let entries: { name: string; isDirectory: () => boolean }[];
  try {
    entries = await readdir(agentsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: AgentSummary[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const summary = await readAgentRole(rootDir, e.name);
    out.push(summary);
  }
  out.sort((a, b) => a.agentId.localeCompare(b.agentId));
  return out;
};

const readAgentRole = async (rootDir: string, agentDir: string): Promise<AgentSummary> => {
  const path = join(rootDir, "agents", agentDir, "role.md");
  try {
    const content = await readFile(path, "utf8");
    const fm = /^---\n([\s\S]*?)\n---/m.exec(content);
    if (!fm) {
      return blankAgent(agentDir);
    }
    const yamlText = fm[1] ?? "";
    const parsed = parseYaml(yamlText) as RoleYamlShape | undefined;
    if (!parsed) return blankAgent(agentDir);

    const cron =
      typeof parsed.wake_schedule?.cron === "string" ? parsed.wake_schedule.cron : undefined;
    const tz = typeof parsed.wake_schedule?.tz === "string" ? ` ${parsed.wake_schedule.tz}` : "";

    const groupsRaw = parsed.group_memberships;
    const groups = Array.isArray(groupsRaw)
      ? groupsRaw.filter((g): g is string => typeof g === "string")
      : [];

    const writeScopesRaw = parsed.github?.write_scopes;
    const writeScopes = Array.isArray(writeScopesRaw)
      ? writeScopesRaw.filter((s): s is string => typeof s === "string")
      : [];

    return {
      agentId: typeof parsed.agent_id === "string" ? parsed.agent_id : agentDir,
      name: typeof parsed.name === "string" ? parsed.name : undefined,
      modelTier: typeof parsed.model_tier === "string" ? parsed.model_tier : undefined,
      wakeSchedule: cron ? `${cron}${tz}` : undefined,
      groups,
      writeScopes,
    };
  } catch {
    return blankAgent(agentDir);
  }
};

interface RoleYamlShape {
  readonly agent_id?: unknown;
  readonly name?: unknown;
  readonly model_tier?: unknown;
  readonly wake_schedule?: { readonly cron?: unknown; readonly tz?: unknown };
  readonly group_memberships?: unknown;
  readonly github?: { readonly write_scopes?: unknown };
}

const blankAgent = (agentDir: string): AgentSummary => ({
  agentId: agentDir,
  name: undefined,
  modelTier: undefined,
  wakeSchedule: undefined,
  groups: [],
  writeScopes: [],
});

const readGroups = async (rootDir: string): Promise<readonly GroupSummary[]> => {
  const groupsDir = join(rootDir, "governance", "groups");
  let entries: string[];
  try {
    entries = (await readdir(groupsDir)).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const out: GroupSummary[] = [];
  for (const e of entries) {
    const groupId = e.replace(/\.md$/, "");
    const summary = await readGroup(rootDir, groupId);
    out.push(summary);
  }
  out.sort((a, b) => a.groupId.localeCompare(b.groupId));
  return out;
};

const readGroup = async (rootDir: string, groupId: string): Promise<GroupSummary> => {
  const path = join(rootDir, "governance", "groups", `${groupId}.md`);
  try {
    const content = await readFile(path, "utf8");
    const titleMatch = /^#\s+(.+)$/m.exec(content);
    const facilitatorMatch = /^facilitator:\s*(.+)$/im.exec(content);
    const membersMatch = /##\s*Members\s*\n([\s\S]*?)(\n##|$)/i.exec(content);
    const members: string[] = [];
    if (membersMatch) {
      const block = membersMatch[1] ?? "";
      for (const line of block.split("\n")) {
        const m = /^[-*]\s+([a-z0-9][a-z0-9_-]*)/i.exec(line.trim());
        if (m?.[1]) members.push(m[1]);
      }
    }
    return {
      groupId,
      title: titleMatch?.[1]?.trim(),
      facilitator: facilitatorMatch?.[1]?.trim(),
      members,
    };
  } catch {
    return { groupId, title: undefined, facilitator: undefined, members: [] };
  }
};

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

const renderMarkdown = (o: MurmurationOverview): string => {
  const lines: string[] = ["# Murmuration overview", ""];

  if (o.governanceModel || o.governancePlugin) {
    const plugin = o.governancePlugin ? ` (plugin: \`${o.governancePlugin}\`)` : "";
    lines.push(`**Governance:** ${o.governanceModel ?? "unspecified"}${plugin}`);
  }
  if (o.llmProvider) {
    const m = o.llmModel ? ` · ${o.llmModel}` : "";
    lines.push(`**LLM:** ${o.llmProvider}${m}`);
  }
  if (o.purpose) {
    lines.push("", "**Purpose** (from soul.md):", "", `> ${o.purpose.replace(/\n/g, "\n> ")}`);
  }

  lines.push("", `**Agents (${String(o.agents.length)}):**`, "");
  if (o.agents.length === 0) {
    lines.push("_(none — `<root>/agents/` is empty)_");
  } else {
    lines.push("| Agent | Tier | Wake | Groups | Write scopes |");
    lines.push("|---|---|---|---|---|");
    for (const a of o.agents) {
      lines.push(
        `| ${a.agentId} | ${a.modelTier ?? "—"} | ${a.wakeSchedule ?? "dispatch-only"} | ${a.groups.join(", ") || "—"} | ${a.writeScopes.length > 0 ? a.writeScopes.join(", ") : "—"} |`,
      );
    }
  }

  lines.push("", `**Groups (${String(o.groups.length)}):**`, "");
  if (o.groups.length === 0) {
    lines.push("_(none — `<root>/governance/groups/` is empty)_");
  } else {
    lines.push("| Group | Facilitator | Members |");
    lines.push("|---|---|---|");
    for (const g of o.groups) {
      lines.push(
        `| ${g.title ?? g.groupId} | ${g.facilitator ?? "—"} | ${g.members.join(", ") || "—"} |`,
      );
    }
  }

  lines.push("", `_(generated ${o.generatedAt}${o.fromCache ? "; cached" : ""})_`);
  return lines.join("\n");
};
