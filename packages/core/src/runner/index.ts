/**
 * Default agent runner — generic harness-level behavior that every
 * murmuration needs. Operators customize via wake prompts and options,
 * not by reimplementing the runner.
 *
 * Handles:
 *   - Identity chain → system prompt assembly
 *   - Signal rendering
 *   - Action item surfacing
 *   - Wake mode handling
 *   - Capability display
 *   - Self-reflection parsing (EFFECTIVENESS/OBSERVATION/GOVERNANCE_EVENT)
 *   - Governance event type detection (TENSION:/PROPOSAL:/REPORT:)
 *   - GitHub commit logic
 *   - Upstream digest reading
 */

import { readFile, readdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";

import { parseSelfReflection } from "../execution/index.js";
import type {
  AgentOutputArtifact,
  AgentSpawnContext,
  EmittedGovernanceEvent,
  Signal,
  WakeAction,
} from "../execution/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DefaultRunnerOptions {
  /** Paths to commit output to (e.g. "drafts/articles"). */
  readonly commitPathPrefix?: string;
}

export interface DefaultRunnerClients {
  readonly llm?: {
    complete(
      opts: {
        model: string;
        messages: { role: string; content: string }[];
        systemPromptOverride?: string;
        maxOutputTokens?: number;
        temperature?: number;
      },
      extra?: { signal?: AbortSignal },
    ): Promise<
      | {
          ok: true;
          value: { content: string; inputTokens: number; outputTokens: number; modelUsed: string };
        }
      | {
          ok: false;
          error: { code: string; message: string };
        }
    >;
  };
  readonly github?: {
    getRef(repo: unknown, branch: string): Promise<{ ok: boolean; value?: { oid: string } }>;
    createCommitOnBranch(
      repo: unknown,
      branch: string,
      message: { headline: string; body?: string },
      fileChanges: { additions?: { path: string; contents: string }[] },
      oid: string,
    ): Promise<{ ok: boolean; value?: { oid: string; url: string } }>;
  };
  readonly targetRepo?: unknown;
  readonly targetBranch?: string;
}

export interface DefaultRunnerContext {
  readonly spawn: AgentSpawnContext;
  readonly clients: DefaultRunnerClients;
  readonly signal?: AbortSignal;
}

export interface DefaultRunnerResult {
  readonly wakeSummary: string;
  readonly outputs?: readonly AgentOutputArtifact[];
  readonly governanceEvents?: readonly EmittedGovernanceEvent[];
  readonly actions?: readonly WakeAction[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const renderSignal = (s: Signal): string => {
  if (s.kind === "github-issue") {
    const issue = s as unknown as {
      number: number;
      title: string;
      labels: string[];
      url: string;
      excerpt: string;
    };
    return `- [gh-issue #${String(issue.number)}] ${issue.title}\n  labels: ${issue.labels.join(", ") || "(none)"}\n  url: ${issue.url}\n  excerpt: ${issue.excerpt}`;
  }
  if (s.kind === "custom") {
    const custom = s as unknown as { sourceId?: string; data?: unknown };
    if (custom.sourceId === "governance-inbox") {
      const data = custom.data as { kind?: string; payload?: unknown } | undefined;
      return `- [governance] kind=${data?.kind ?? "unknown"} payload=${JSON.stringify(data?.payload ?? null)}`;
    }
  }
  return `- [${s.kind}] ${JSON.stringify(s).slice(0, 120)}`;
};

/** Read the most recent digest from an upstream agent's runs directory. */
const readUpstreamDigest = async (
  rootDir: string,
  upstreamAgentId: string,
): Promise<string | null> => {
  try {
    const runsDir = join(rootDir, ".murmuration", "runs", upstreamAgentId);
    const dates = await readdir(runsDir);
    const sorted = dates
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort()
      .reverse();
    const latest = sorted[0];
    if (!latest) return null;
    const latestDir = join(runsDir, latest);
    const files = await readdir(latestDir);
    const digestFile = files.find((f) => f.startsWith("digest-"));
    if (!digestFile) return null;
    const content = await readFile(join(latestDir, digestFile), "utf8");
    return content.replace(/^---[\s\S]*?---\n*/, "").trim();
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Default runner factory
// ---------------------------------------------------------------------------

/**
 * Create a default agent runner with all harness-level behavior built in.
 *
 * @param agentDir — agent directory name (e.g. "02-content-production")
 * @param upstreamAgentIds — agent IDs whose latest output to include
 * @param options — commit path prefix, etc.
 * @param rootDir — murmuration root (defaults to resolving from import.meta)
 */
export function createDefaultRunner(
  agentDir: string,
  upstreamAgentIds: readonly string[] = [],
  options: DefaultRunnerOptions = {},
  rootDir?: string,
): (ctx: DefaultRunnerContext) => Promise<DefaultRunnerResult> {
  return async function runWake(ctx: DefaultRunnerContext): Promise<DefaultRunnerResult> {
    const { spawn, clients, signal } = ctx;
    const wakeId = spawn.wakeId.value;
    const agentId = spawn.agentId.value;

    if (!clients.llm) {
      return { wakeSummary: `[${agentId}] wake ${wakeId}\n  status: skipped — no LLM client` };
    }

    // 1. System prompt from identity chain
    const systemPrompt = spawn.identity.layers
      .map((layer) => {
        const title =
          layer.kind === "murmuration-soul"
            ? "# Murmuration Soul"
            : layer.kind === "agent-soul"
              ? "# Agent Soul"
              : layer.kind === "agent-role"
                ? "# Agent Role"
                : `# ${layer.kind}`;
        return `${title}\n\n${layer.content.trim()}`;
      })
      .join("\n\n---\n\n");

    // 2. Wake prompt from agent's prompts/wake.md
    const effectiveRoot = rootDir ?? resolve(dirname(""), "..");
    const promptPath = join(effectiveRoot, "agents", agentDir, "prompts", "wake.md");
    let wakePrompt: string;
    try {
      wakePrompt = await readFile(promptPath, "utf8");
    } catch {
      return {
        wakeSummary: `[${agentId}] wake ${wakeId}\n  status: failed — could not load ${promptPath}`,
      };
    }

    // 3. Render signals
    const signalBlock =
      spawn.signals.signals.length === 0
        ? "_No signals received this wake._"
        : spawn.signals.signals.map(renderSignal).join("\n");

    // 4. Upstream digests
    let upstreamBlock = "";
    for (const upId of upstreamAgentIds) {
      const digest = await readUpstreamDigest(effectiveRoot, upId);
      if (digest) {
        upstreamBlock += `\n\n## Upstream: ${upId} (latest output)\n\n${digest}`;
      }
    }

    // 5. Action items
    const actionItems = spawn.signals.actionItems;
    const actionItemBlock =
      actionItems.length === 0
        ? ""
        : `\n\n## ⚡ ACTION ITEMS ASSIGNED TO YOU (${String(actionItems.length)})\n\nThese are concrete tasks from a group meeting that YOU must complete this wake. They take priority over your default role.\n\n${actionItems.map(renderSignal).join("\n")}\n\nFor EACH action item: do the work, then state what you did. If you cannot complete it, explain why.`;

    // 6. Wake mode
    const wakeMode = spawn.wakeMode;
    const modeBlock =
      wakeMode !== "individual"
        ? `\n\n_Wake mode: ${wakeMode} — you are participating in a group meeting. Contribute your perspective; do NOT execute action items._`
        : "";

    // 7. Capabilities
    const caps = spawn.capabilities;
    const capsBlock = caps
      ? `\n\n## Your Capabilities\nIf any capability you need to fulfill your role is missing, file a GOVERNANCE_EVENT requesting it.\n### GitHub\n- Commit files: ${caps.github.canCommit ? `YES (paths: ${caps.github.commitPaths.join(", ")})` : "NO"}\n- Comment on issues: ${caps.github.canCommentIssues ? "YES" : "NO"}\n- Create issues: ${caps.github.canCreateIssues ? "YES" : "NO"}\n- Label issues: ${caps.github.canLabelIssues ? "YES" : "NO"}${caps.cliTools.length > 0 ? `\n### CLI Tools\n${caps.cliTools.map((t) => `- ${t}`).join("\n")}` : ""}${caps.mcpServers.length > 0 ? `\n### MCP Servers\n${caps.mcpServers.map((s) => `- ${s}`).join("\n")}` : ""}\n### Signal Sources\n${caps.signalSources.map((s) => `- ${s}`).join("\n") || "- (none configured)"}`
      : "";

    // 8. Assemble user prompt
    const dayUtc = new Date().toISOString().slice(0, 10);
    const userPrompt = `${wakePrompt.trim()}
${actionItemBlock}${modeBlock}${capsBlock}

---

## Signal bundle (${String(spawn.signals.signals.length)} items)

${signalBlock}
${upstreamBlock}

---

Return your output. Date: ${dayUtc}.

IMPORTANT — You MUST end your response with this exact block (no exceptions):

## Self-Reflection
EFFECTIVENESS: high / medium / low
OBSERVATION: one sentence
GOVERNANCE_EVENT: none — OR one of:
  TENSION: <description of a problem that needs addressing>
  PROPOSAL: <description of a proposed solution to a problem>
  REPORT: <status update for the authority>
If you were asked to draft a proposal (e.g. an action item saying "draft proposal for X"), file it as PROPOSAL: <your proposal>
`;

    // 9. Call LLM
    const llmModel =
      spawn.identity.frontmatter.modelTier === "fast"
        ? "gemini-2.5-flash"
        : spawn.identity.frontmatter.modelTier === "deep"
          ? "gemini-2.5-pro"
          : "gemini-2.5-flash";

    const result = await clients.llm.complete(
      {
        model: llmModel,
        messages: [{ role: "user", content: userPrompt }],
        systemPromptOverride: systemPrompt,
        maxOutputTokens: 16000,
        temperature: 0.3,
      },
      ...(signal ? [{ signal }] : []),
    );

    if (!result.ok) {
      throw new Error(`LLM failed: ${result.error.code} — ${result.error.message}`);
    }

    const content = result.value.content.trim();

    // 10. Parse self-reflection
    const reflection = parseSelfReflection(content);
    const summaryLines = [
      `[${agentId}] wake ${wakeId}`,
      `  model: ${result.value.modelUsed}`,
      `  input_tokens: ${String(result.value.inputTokens)}`,
      `  output_tokens: ${String(result.value.outputTokens)}`,
      `  signal_count: ${String(spawn.signals.signals.length)}`,
      `  effectiveness: ${reflection.effectiveness}`,
      ...(reflection.governanceEvent
        ? [`  governance_event: ${reflection.governanceEvent.slice(0, 80)}`]
        : []),
    ];

    const outputs: AgentOutputArtifact[] = [];
    const governanceEvents: EmittedGovernanceEvent[] = [];

    // 11. Parse governance event with type detection
    if (reflection.governanceEvent) {
      let govKind = "agent-governance-event";
      let govTopic = reflection.governanceEvent;
      if (govTopic.startsWith("PROPOSAL:")) {
        govKind = "proposal-opened";
        govTopic = govTopic.slice("PROPOSAL:".length).trim();
      } else if (govTopic.startsWith("TENSION:")) {
        govKind = "tension";
        govTopic = govTopic.slice("TENSION:".length).trim();
      } else if (govTopic.startsWith("REPORT:")) {
        govKind = "report";
        govTopic = govTopic.slice("REPORT:".length).trim();
      }
      governanceEvents.push({
        kind: govKind,
        payload: {
          topic: govTopic,
          observation: reflection.observation,
          effectiveness: reflection.effectiveness,
          agentId,
          filedAt: dayUtc,
        },
        sourceAgentId: spawn.agentId,
      });
    }

    // 12. Commit to GitHub if configured
    if (options.commitPathPrefix && clients.github && clients.targetRepo) {
      try {
        const filePath = `${options.commitPathPrefix}/${dayUtc}-${agentDir}.md`;
        const targetBranch = clients.targetBranch ?? "main";
        const headResult = await clients.github.getRef(clients.targetRepo, targetBranch);
        if (headResult.ok && headResult.value) {
          const commitResult = await clients.github.createCommitOnBranch(
            clients.targetRepo,
            targetBranch,
            {
              headline: `${agentDir}: ${dayUtc}`,
              body: `Generated by ${agentId} via Murmuration Harness. wake_id=${wakeId}`,
            },
            { additions: [{ path: filePath, contents: content + "\n" }] },
            headResult.value.oid,
          );
          if (commitResult.ok && commitResult.value) {
            summaryLines.push(`  commit_oid: ${commitResult.value.oid}`);
            summaryLines.push(`  commit_url: ${commitResult.value.url}`);
            summaryLines.push(`  file: ${filePath}`);
            outputs.push({
              kind: "file-written",
              description: `committed ${filePath}`,
              ref: commitResult.value.url,
            });
          }
        }
      } catch {
        // Commit is best-effort
      }
    }

    return {
      wakeSummary: [...summaryLines, "", "---", "", content].join("\n"),
      ...(outputs.length > 0 ? { outputs } : {}),
      ...(governanceEvents.length > 0 ? { governanceEvents } : {}),
    };
  };
}
