/**
 * Default agent runner — generic harness-level behavior that every
 * murmuration needs. Operators customize via wake prompts and options,
 * not by reimplementing the runner.
 *
 * Handles:
 *   - Prompt assembly via PromptAssembler (Proposal 07 Phase 2)
 *   - Wake action parsing from LLM output (Near-Term #3)
 *   - Self-reflection parsing (EFFECTIVENESS/OBSERVATION/GOVERNANCE_EVENT)
 *   - Emits a generic `agent-governance-event` — model-specific
 *     interpretation (e.g. S3's TENSION/PROPOSAL/REPORT prefixes)
 *     happens in the governance plugin's `onEventsEmitted` hook,
 *     not here
 *   - Artifact commit via CollaborationProvider (ADR-0021)
 *   - Capability display
 */

import { resolve, dirname } from "node:path";

import {
  deriveVerifiedActions,
  parseSelfReflection,
  parseWakeActions,
} from "../execution/index.js";
import type {
  AgentOutputArtifact,
  AgentSpawnContext,
  EmittedGovernanceEvent,
  VerifiedAction,
  WakeAction,
} from "../execution/index.js";
import { PromptAssembler } from "../runtime/prompt-assembler.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DefaultRunnerOptions {
  /** Paths to commit output to (e.g. "drafts/articles"). */
  readonly commitPathPrefix?: string;
  /** Extension tools available to all agents (ADR-0023). */
  readonly extensionTools?: readonly RunnerToolDefinition[];
  /** Number of the agent's own prior wake digests to inject into the
   *  prompt as a "Recent work" block (ADR-0029 §2). Default 3. Set to
   *  0 to disable the self-digest tail entirely. */
  readonly selfDigestTail?: number;
  /** Max tool-use steps per wake. Each step is one LLM round-trip plus
   *  its tool calls. Too low truncates multi-step workflows mid-action;
   *  too high wastes tokens. Default 256 (effectively unlimited for
   *  normal agent work). Configurable via harness.yaml `agent.maxSteps`. */
  readonly maxSteps?: number;
}

/** Tool definition compatible with LLM tool calling (ADR-0020 Phase 2). */
export interface RunnerToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
  readonly execute: (input: Record<string, unknown>) => Promise<unknown>;
}

/** MCP server config for tool loading (ADR-0020 Phase 3). */
export interface RunnerMcpServerConfig {
  readonly name: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

export interface DefaultRunnerClients {
  readonly llm?: {
    complete(
      opts: {
        /**
         * Concrete model id is optional — the underlying LLMClient binds
         * its model at construction and ignores this field. Pass it for
         * observability when known; the bound model wins regardless.
         * See harness#252.
         */
        model?: string;
        messages: { role: string; content: string }[];
        systemPromptOverride?: string;
        maxOutputTokens?: number;
        temperature?: number;
        tools?: readonly RunnerToolDefinition[];
        maxSteps?: number;
      },
      extra?: {
        signal?: AbortSignal;
        /** Langfuse telemetry enrichment (Near-Term #8 / ADR-0022 §1). */
        telemetryContext?: {
          readonly agentId: string;
          readonly wakeId: string;
          readonly groupIds: readonly string[];
          readonly wakeMode: string;
        };
      },
    ): Promise<
      | {
          ok: true;
          value: {
            content: string;
            inputTokens: number;
            outputTokens: number;
            cacheReadTokens?: number;
            modelUsed: string;
            /** Number of LLM→tool round-trips. */
            steps?: number;
            /** Tool invocations across all steps. */
            toolCalls?: readonly unknown[];
          };
        }
      | {
          ok: false;
          error: { code: string; message: string };
        }
    >;
    /**
     * Reports the bound client's tool-delivery contract. The runner
     * consults `supportsToolUse` before spreading `request.tools` —
     * subscription-CLI clients (ADR-0034, ADR-0038) report `false`
     * because tools reach those clients via Spirit MCP at construction
     * time, not on the per-request wire. Only the field the runner
     * reads is declared here; the underlying `LLMClient` interface
     * surfaces more.
     */
    capabilities(): {
      readonly supportsToolUse: boolean;
      /** Optional provider id (e.g. "claude-cli", "anthropic"); used to
       *  describe the runtime in the prompt when no per-request tools
       *  are advertised. Narrowed locally; full LLMClient capabilities
       *  surface this and more. */
      readonly provider?: string | undefined;
    };
  };
  /** MCP tool loader — connects to MCP servers and returns tool definitions. */
  readonly mcpToolLoader?: {
    loadTools(
      servers: readonly RunnerMcpServerConfig[],
      parentEnv?: Readonly<Record<string, string>>,
    ): Promise<RunnerToolDefinition[]>;
    close(): Promise<void>;
  };
  /** CollaborationProvider for artifact commits (ADR-0021). Preferred over github. */
  readonly collaborationProvider?: {
    commitArtifact(input: {
      readonly path: string;
      readonly content: string;
      readonly message: string;
    }): Promise<{
      ok: boolean;
      value?: { id: string; url?: string; path: string };
      error?: { code: string; message: string };
    }>;
  };
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
  /** Confirmed in-subprocess tool calls, derived from the LLM response (#364B). */
  readonly verifiedActions?: readonly VerifiedAction[];
}

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
  const effectiveRoot = rootDir ?? resolve(dirname(""), "..");
  const assembler = new PromptAssembler({
    rootDir: effectiveRoot,
    agentDir,
    ...(options.selfDigestTail !== undefined ? { selfDigestTail: options.selfDigestTail } : {}),
    upstreamAgentIds,
  });

  return async function runWake(ctx: DefaultRunnerContext): Promise<DefaultRunnerResult> {
    const { spawn, clients, signal } = ctx;
    const wakeId = spawn.wakeId.value;
    const agentId = spawn.agentId.value;

    if (!clients.llm) {
      return { wakeSummary: `[${agentId}] wake ${wakeId}\n  status: skipped — no LLM client` };
    }

    // 7a. Load tools first — the system prompt needs to surface them
    //     so the LLM uses tool calls instead of narration. Live
    //     regression 2026-04-30: 7 tools threaded via the API but
    //     tool_calls: 0 across Gemini and Anthropic because the prompt
    //     never told the LLM the tools existed (Boundary 5 root cause).
    //
    // When the bound client reports `supportsToolUse: false`
    // (subscription-CLI family, ADR-0034 / ADR-0038), per-request
    // tool delivery is disabled. We do not pass `request.tools` and
    // do not list per-request tools in the prompt — but we MUST tell
    // the agent it has its runtime's own tool ecosystem (Bash incl.
    // `gh`, file editing, code search, plus any MCP servers wired
    // via the subprocess's --mcp-config). The previous "_None._"
    // fallback caused 18 agents in a single round (live run
    // 2026-05-03) to file convergent TENSION/PROPOSAL issues
    // complaining their declared capabilities (e.g. "Comment on
    // issues: YES") didn't match the prompt's empty tools list.
    const llmCaps = clients.llm.capabilities();
    const supportsRequestTools = llmCaps.supportsToolUse;
    const mcpConfigs = supportsRequestTools ? (spawn.mcpServerConfigs ?? []) : [];
    const allTools: RunnerToolDefinition[] = [];
    if (supportsRequestTools) {
      if (options.extensionTools && options.extensionTools.length > 0) {
        allTools.push(...options.extensionTools);
      }
      if (clients.mcpToolLoader && mcpConfigs.length > 0) {
        const mcpTools = await clients.mcpToolLoader.loadTools(mcpConfigs, spawn.environment);
        allTools.push(...mcpTools);
      }
    }
    const tools: RunnerToolDefinition[] | undefined = allTools.length > 0 ? allTools : undefined;

    // 7b. Capabilities — including the live tool inventory.
    const caps = spawn.capabilities;
    // MCP servers like jdocmunch / jcodemunch persist their indexes to
    // disk across wakes. Triggering an indexing operation in-wake when a
    // fresh index already exists wastes 1M+ tokens of confirmation data.
    // Live regression 2026-04-30 (harness#255): GPT-5.5 wake re-ran
    // doc_index_repo on the harness despite the index being current,
    // costing $1.42 of pure overhead. We pattern-match the typical
    // expensive/inventory tool name shapes and tell the agent to check
    // before indexing. Pattern-based so this fires for any future MCP
    // server that follows the same naming convention.
    const expensiveSetupTools =
      tools?.filter((t) =>
        /__(?:doc_index_repo|index_repo|index_folder|index_local|index_file|embed_repo)$/.test(
          t.name,
        ),
      ) ?? [];
    const inventoryTools =
      tools?.filter((t) => /__(?:doc_list_repos|list_repos)$/.test(t.name)) ?? [];
    const setupDisciplineBlock =
      expensiveSetupTools.length > 0 && inventoryTools.length > 0
        ? `\n\n**MCP setup discipline.** Some tools above (${expensiveSetupTools
            .map((t) => `\`${t.name}\``)
            .join(
              ", ",
            )}) trigger expensive indexing/embedding operations whose state persists across wakes. Before calling them, use the inventory tools (${inventoryTools
            .map((t) => `\`${t.name}\``)
            .join(
              ", ",
            )}) to check whether the repo is already indexed. Skip indexing when state is current — re-indexing dumps massive confirmation payloads into your context (verified: 1M+ tokens for one needless re-index).`
        : "";
    // The "no per-request tools" message branches on whether the
    // client runs its own tool loop. Subscription-CLI clients do —
    // their runtime (claude-cli, codex-cli, gemini-cli) provides
    // Bash, file editing, gh CLI, etc. natively, plus any MCP
    // servers wired via --mcp-config. API-tool clients with no
    // tools loaded truly have nothing.
    const noPerRequestToolsBlock = supportsRequestTools
      ? `\n### Tools you can call this wake\n_None._ If your task requires a tool you don't have, file a GOVERNANCE_EVENT requesting the capability rather than narrating fictional completion.`
      : `\n### Tools you can call this wake\nPer-request tools are not advertised — your runtime${llmCaps.provider ? ` (\`${llmCaps.provider}\`)` : ""} runs its own tool loop and provides them directly: shell access (use \`gh\` for GitHub operations matching your declared capabilities above), file editing, code search, and any MCP servers configured for your subprocess. **Use them to act on issues** — do not narrate "I will comment on #N" or "I would post Y." Call the tool. If a capability you need is genuinely missing from your runtime, file a GOVERNANCE_EVENT naming the specific gap.`;
    const toolsBlock =
      tools && tools.length > 0
        ? `\n### Tools you can call this wake\n${tools
            .map((t) => `- \`${t.name}\`${t.description ? ` — ${t.description}` : ""}`)
            .join(
              "\n",
            )}\n\nThese are real tool calls. **Use them** — do not narrate "I will read X" or "I would post Y." Either call the tool to do the work, or file a GOVERNANCE_EVENT explaining the specific blocker that prevents the call. Narrating an action without calling its tool is a Boundary 5 hallucination and will be flagged in your wake artifacts.${setupDisciplineBlock}`
        : noPerRequestToolsBlock;
    const capsContent = caps
      ? `\n\n## Your Capabilities\nIf any capability you need to fulfill your role is missing, file a GOVERNANCE_EVENT requesting it.\n### GitHub\n- Commit files: ${caps.github.canCommit ? `YES (paths: ${caps.github.commitPaths.join(", ")})` : "NO"}\n- Comment on issues: ${caps.github.canCommentIssues ? "YES" : "NO"}\n- Create issues: ${caps.github.canCreateIssues ? "YES" : "NO"}\n- Label issues: ${caps.github.canLabelIssues ? "YES" : "NO"}${caps.cliTools.length > 0 ? `\n### CLI Tools\n${caps.cliTools.map((t) => `- ${t}`).join("\n")}` : ""}${caps.mcpServers.length > 0 ? `\n### MCP Servers\n${caps.mcpServers.map((s) => `- ${s}`).join("\n")}` : ""}\n### Signal Sources\n${caps.signalSources.map((s) => `- ${s}`).join("\n") || "- (none configured)"}${toolsBlock}`
      : toolsBlock;

    // 8. Assemble prompt bundle via PromptAssembler (Proposal 07 Phase 2)
    const dayUtc = new Date().toISOString().slice(0, 10);
    const bundle = await assembler.assemble({ spawn, capsContent, dayUtc });
    const systemPrompt = bundle.system.map((s) => s.content).join("\n\n---\n\n");
    const userPrompt = bundle.messages[0]?.content ?? "";

    // 9. Call LLM (tools loaded above as section 7a)
    //
    // We do NOT pass a model — the LLMClient was constructed with the
    // agent's resolved provider+model at boot, and the Vercel adapter
    // uses that bound model regardless of what's in the request. The
    // bound model is the single source of truth.
    //
    // Previous code (harness#252) synthesized a Gemini model name from
    // modelTier here regardless of the agent's actual provider. The
    // adapter ignored it for non-Gemini agents (which is why nothing
    // visibly broke), but it was a latent regression — any future
    // adapter that respected request.model would silently swap every
    // agent to a Gemini name. It also produced the wrong default for
    // the one provider it actually applied to (balanced → flash, not
    // pro). The actual model used in the wake is reported back via
    // `result.value.modelUsed` and logged below.
    //
    // Tool delivery is gated on the client's reported capability. The
    // subscription-CLI provider family (ADR-0034, ADR-0038) reports
    // `supportsToolUse: false` because tools reach those clients via
    // the Spirit MCP bridge at construction time, not via the per-
    // request wire. Passing `tools` regardless would trip the CF-A
    // fail-loudly guard in `SubprocessAdapter.complete()`. The runner
    // honors the contract: skip the request-side spread when the
    // bound client doesn't support it. Tools that need to reach a
    // subscription-CLI agent must be configured via mcpConfigPath at
    // client construction (boot.ts wiring, harness#291).
    // `supportsRequestTools` was computed at section 7a so the prompt-
    // building stage could honor the same gate. Reused here for the
    // request-side spread.
    const passToolsOnRequest = supportsRequestTools && tools !== undefined && tools.length > 0;
    // Diagnostic logging for v0.7.0 live-test 2026-05-04: wakes were
    // stalling between "fire" and "timeout" with no visibility into
    // whether the LLM call started, hung, or returned. These three
    // log lines give every phase a stderr breadcrumb so future
    // hangs are pinpointable from the wake log alone.
    process.stderr.write(
      `${JSON.stringify({ ts: new Date().toISOString(), level: "info", event: "runner.llm.complete.begin", wakeId, agentId, provider: llmCaps.provider ?? null, supportsToolUse: llmCaps.supportsToolUse, toolCount: tools?.length ?? 0, promptBytes: userPrompt.length, systemPromptBytes: systemPrompt.length, promptHash: bundle.hash.slice(0, 16) })}\n`,
    );
    let result: Awaited<ReturnType<NonNullable<DefaultRunnerClients["llm"]>["complete"]>>;
    try {
      result = await clients.llm.complete(
        {
          messages: [{ role: "user", content: userPrompt }],
          systemPromptOverride: systemPrompt,
          maxOutputTokens: 16000,
          temperature: 0.3,
          ...(passToolsOnRequest ? { tools, maxSteps: options.maxSteps ?? 256 } : {}),
        },
        {
          ...(signal ? { signal } : {}),
          telemetryContext: {
            agentId,
            wakeId,
            groupIds: [],
            wakeMode: spawn.wakeMode,
          },
        },
      );
      process.stderr.write(
        `${JSON.stringify({ ts: new Date().toISOString(), level: "info", event: "runner.llm.complete.end", wakeId, agentId, ok: result.ok, ...(result.ok ? { inputTokens: result.value.inputTokens, outputTokens: result.value.outputTokens, contentBytes: result.value.content.length } : { errorCode: result.error.code, errorMessage: result.error.message }) })}\n`,
      );
    } finally {
      // Always close MCP connections after LLM call
      if (clients.mcpToolLoader && mcpConfigs.length > 0) {
        await clients.mcpToolLoader.close();
      }
    }

    if (!result.ok) {
      throw new Error(`LLM failed: ${result.error.code} — ${result.error.message}`);
    }

    const content = result.value.content.trim();
    const stepCount = result.value.steps ?? 1;
    const toolCallCount = result.value.toolCalls?.length ?? 0;
    const stepBudget = options.maxSteps ?? 256;
    const exhaustedBudget = stepCount >= stepBudget;

    // 10. Parse self-reflection
    const reflection = parseSelfReflection(content);
    const cacheReadTokens = result.value.cacheReadTokens ?? 0;
    const summaryLines = [
      `[${agentId}] wake ${wakeId}`,
      `  model: ${result.value.modelUsed}`,
      `  prompt_hash: ${bundle.hash.slice(0, 16)}`,
      `  input_tokens: ${String(result.value.inputTokens)}`,
      ...(cacheReadTokens > 0 ? [`  cache_read_tokens: ${String(cacheReadTokens)}`] : []),
      `  output_tokens: ${String(result.value.outputTokens)}`,
      `  steps: ${String(stepCount)} / ${String(stepBudget)}`,
      `  tool_calls: ${String(toolCallCount)}`,
      `  signal_count: ${String(spawn.signals.signals.length)}`,
      `  effectiveness: ${reflection.effectiveness}`,
      ...(reflection.governanceEvent
        ? [`  governance_event: ${reflection.governanceEvent.slice(0, 80)}`]
        : []),
      ...(exhaustedBudget
        ? [
            "",
            `  ⚠ BUDGET EXHAUSTED: ran through all ${String(stepBudget)} tool-use`,
            `    steps without finishing. Next wake should note this and`,
            `    either narrow scope, raise agent.maxSteps in harness.yaml,`,
            `    or surface a tension suggesting the step budget is too low.`,
          ]
        : []),
    ];

    const outputs: AgentOutputArtifact[] = [];
    const governanceEvents: EmittedGovernanceEvent[] = [];

    // 10b. Parse wake actions from LLM output (Near-Term #3)
    const wakeActions = parseWakeActions(content);

    // 11. Emit governance event. Core stays generic — the active
    // GovernancePlugin decides what kind of item (if any) to create
    // in its `onEventsEmitted` handler. The raw agent text goes in
    // `payload.topic` verbatim; any model-specific prefix parsing
    // (e.g. S3's `TENSION:` / `PROPOSAL:` / `REPORT:`) belongs to
    // the plugin, not to core.
    if (reflection.governanceEvent) {
      governanceEvents.push({
        kind: "agent-governance-event",
        payload: {
          topic: reflection.governanceEvent,
          observation: reflection.observation,
          effectiveness: reflection.effectiveness,
          agentId,
          filedAt: dayUtc,
        },
        sourceAgentId: spawn.agentId,
      });
    }

    // 12. Commit artifact if configured (ADR-0021 CollaborationProvider).
    if (options.commitPathPrefix && clients.collaborationProvider) {
      const filePath = `${options.commitPathPrefix}/${dayUtc}-${agentDir}.md`;
      const commitMessage = `${agentDir}: ${dayUtc}`;
      try {
        const commitResult = await clients.collaborationProvider.commitArtifact({
          path: filePath,
          content: content + "\n",
          message: commitMessage,
        });
        if (commitResult.ok && commitResult.value) {
          summaryLines.push(`  commit_id: ${commitResult.value.id}`);
          if (commitResult.value.url) summaryLines.push(`  commit_url: ${commitResult.value.url}`);
          summaryLines.push(`  file: ${filePath}`);
          outputs.push({
            kind: "file-written",
            description: `committed ${filePath}`,
            ref: commitResult.value.url ?? commitResult.value.path,
          });
        }
      } catch (err) {
        summaryLines.push(`  commit_error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // #364B: surface the agent's confirmed in-subprocess tool calls (e.g. a
    // `create_issue_comment`) so the daemon can credit them as real evidence
    // instead of treating a tool-driven comment as a narrative-only wake.
    const verifiedActions = deriveVerifiedActions(result.value.toolCalls ?? []);

    return {
      wakeSummary: [...summaryLines, "", "---", "", content].join("\n"),
      ...(outputs.length > 0 ? { outputs } : {}),
      ...(governanceEvents.length > 0 ? { governanceEvents } : {}),
      ...(wakeActions.length > 0 ? { actions: wakeActions } : {}),
      ...(verifiedActions.length > 0 ? { verifiedActions } : {}),
    };
  };
}
