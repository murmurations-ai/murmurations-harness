/**
 * `murmuration convene` — trigger a group meeting on demand.
 *
 * Usage:
 *   murmuration convene --root ../my-murmuration --group content
 *   murmuration convene --root ../my-murmuration --group content --governance
 *   murmuration convene --root ../my-murmuration --group content --directive "What's our top priority?"
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";

import {
  makeSecretKey,
  IdentityLoader,
  IdentityFileMissingError,
  FrontmatterInvalidError,
  runGroupWake,
  type CollaborationProvider,
  type CollaborationError,
  type GroupConfig,
  type GroupWakeContext,
  type GroupWakeKind,
  type GovernanceItem,
  type GovernanceTerminology,
  type MeetingAction,
  type ActionReceipt,
  type GovernanceTally,
  GovernanceStateStore,
} from "@murmurations-ai/core";
import {
  createLLMClient,
  createSubscriptionCliClient,
  formatLLMError,
  type LLMClient,
} from "@murmurations-ai/llm";
import { DotenvSecretsProvider } from "@murmurations-ai/secrets-dotenv";

import { buildBuiltinProviderRegistry } from "./builtin-providers/index.js";
import {
  buildCollaborationProvider,
  CollaborationBuildError,
  findDefaultRepo,
} from "./collaboration-factory.js";

/**
 * Discriminated result for resolving the facilitator's LLM config.
 *
 * The reason field distinguishes the three things that can actually
 * go wrong when a tester first runs `group-wake`, so the CLI can
 * print a specific remediation instead of a generic "could not read
 * LLM config" catch-all. (v0.5.0 Milestone 1 — error legibility.)
 */
type ResolveLLMResult =
  | {
      readonly ok: true;
      readonly config: {
        readonly provider: string;
        readonly model: string;
        /** Set when provider === "subscription-cli". */
        readonly cli?: "claude" | "codex" | "gemini";
        /** Subprocess timeout in ms; only honored for subscription-cli. */
        readonly timeoutMs?: number;
      };
    }
  | { readonly ok: false; readonly reason: "no-llm-block"; readonly rolePath: string }
  | { readonly ok: false; readonly reason: "file-not-found"; readonly path: string }
  | {
      readonly ok: false;
      readonly reason: "frontmatter-invalid";
      readonly path: string;
      readonly issues: readonly string[];
    }
  | { readonly ok: false; readonly reason: "other"; readonly message: string };

/**
 * Resolve LLM provider + model from the facilitator's role.md.
 *
 * Exported for unit tests; callers inside this module use it directly.
 */
export const resolveLLMConfig = async (
  rootDir: string,
  facilitatorId: string,
): Promise<ResolveLLMResult> => {
  const rolePath = resolve(rootDir, "agents", facilitatorId, "role.md");
  try {
    // Engineering Standard #11: cascade harness.yaml's `llm:` into the
    // facilitator's role.md when absent.
    const { loadHarnessConfig } = await import("./harness-config.js");
    const harness = await loadHarnessConfig(rootDir);
    const loader = new IdentityLoader({
      rootDir,
      roleDefaults: {
        llm: harness.llm.model
          ? { provider: harness.llm.provider, model: harness.llm.model }
          : { provider: harness.llm.provider },
      },
    });
    const identity = await loader.load(facilitatorId);
    const llm = identity.frontmatter.llm;
    if (llm) {
      return {
        ok: true,
        config: {
          provider: llm.provider,
          model: llm.model ?? getDefaultModel(llm.provider),
          ...(llm.cli !== undefined ? { cli: llm.cli } : {}),
          ...(llm.timeoutMs !== undefined ? { timeoutMs: llm.timeoutMs } : {}),
        },
      };
    }
    return { ok: false, reason: "no-llm-block", rolePath };
  } catch (err) {
    if (err instanceof IdentityFileMissingError) {
      return { ok: false, reason: "file-not-found", path: err.path };
    }
    if (err instanceof FrontmatterInvalidError) {
      return {
        ok: false,
        reason: "frontmatter-invalid",
        path: err.path,
        issues: err.issues,
      };
    }
    return {
      ok: false,
      reason: "other",
      message: err instanceof Error ? err.message : String(err),
    };
  }
};

/**
 * Print a tester-legible failure message for a non-ok
 * {@link ResolveLLMResult}. Each reason names the real problem and
 * the fix, so operators aren't left googling "could not read LLM
 * config".
 */
const printLLMResolveFailure = (
  facilitatorId: string,
  result: Exclude<ResolveLLMResult, { readonly ok: true }>,
): void => {
  const prefix = "murmuration convene:";
  switch (result.reason) {
    case "no-llm-block":
      console.error(`${prefix} facilitator "${facilitatorId}" role.md has no llm: block`);
      console.error(`  File: ${result.rolePath}`);
      console.error(`  Fix:  add an llm: block to the facilitator's role.md. Example:`);
      console.error(`          llm:`);
      console.error(`            provider: "gemini"   # or anthropic, openai, ollama`);
      console.error(`  Alternative: the harness default in murmuration/harness.yaml applies`);
      console.error(`               only when the daemon spawns agents — convene needs`);
      console.error(`               the facilitator's role.md to set the llm explicitly.`);
      break;
    case "file-not-found":
      console.error(`${prefix} facilitator role.md not found`);
      console.error(`  Expected: ${result.path}`);
      console.error(
        `  Fix:  check that the facilitator id "${facilitatorId}" matches an agents/<id>/ directory,`,
      );
      console.error(`        and that agents/${facilitatorId}/role.md exists.`);
      break;
    case "frontmatter-invalid":
      console.error(`${prefix} facilitator role.md has invalid frontmatter`);
      console.error(`  File: ${result.path}`);
      for (const issue of result.issues) {
        console.error(`    - ${issue}`);
      }
      console.error(`  Hint: run 'murmuration doctor' to auto-diagnose (coming in v0.5.0).`);
      break;
    case "other":
      console.error(`${prefix} unexpected error resolving facilitator's LLM config`);
      console.error(`  ${result.message}`);
      break;
  }
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

/**
 * Format a CollaborationError as `CODE: message` so operators see the
 * real underlying problem instead of just `UNKNOWN`. v0.5.0 Milestone 1.
 *
 * Exported for unit tests.
 */
export const formatCollaborationError = (err: CollaborationError): string => {
  const msg = err.message.trim();
  if (!msg || msg === "Unknown error") return err.code;
  return `${err.code}: ${msg}`;
};

/** Fetch the group's open items backlog via the collaboration provider. */
const fetchGroupBacklog = async (provider: CollaborationProvider): Promise<string> => {
  try {
    const result = await provider.listItems({ state: "open", limit: 30 });
    if (!result.ok) return `(backlog fetch failed: ${formatCollaborationError(result.error)})`;
    const items = result.value;
    if (items.length === 0) return "(no open items)";
    return items.map((i) => `- ${i.ref.id} ${i.title} [${i.labels.join(", ")}]`).join("\n");
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
  provider: CollaborationProvider,
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
          const ref = { id: String(action.issueNumber) };
          if (action.removeLabel) {
            await provider.removeLabel(ref, action.removeLabel);
          }
          const result = await provider.addLabels(ref, [action.label]);
          if (result.ok) {
            const swap = action.removeLabel ? ` (-${action.removeLabel})` : "";
            console.log(
              `    \x1b[32m✓\x1b[0m label-issue #${String(action.issueNumber)} +${action.label}${swap}`,
            );
            receipts.push({ action, success: true });
          } else {
            console.log(
              `    \x1b[31m✗\x1b[0m label-issue #${String(action.issueNumber)}: ${formatCollaborationError(result.error)}`,
            );
            receipts.push({
              action,
              success: false,
              error: formatCollaborationError(result.error),
            });
          }
          break;
        }
        case "create-issue": {
          if (!action.title) {
            receipts.push({ action, success: false, error: "missing title" });
            break;
          }
          const input: { title: string; body: string; labels?: readonly string[] } = {
            title: action.title,
            body: action.body ?? "",
          };
          if (action.labels && action.labels.length > 0) input.labels = action.labels;
          const result = await provider.createItem(input);
          if (result.ok) {
            const parsed = Number(result.value.id);
            const id = Number.isFinite(parsed) ? parsed : undefined;
            console.log(`    \x1b[32m✓\x1b[0m create-issue ${result.value.id}: ${action.title}`);
            receipts.push({
              action,
              success: true,
              ...(id !== undefined ? { issueNumber: id } : {}),
            });
          } else {
            console.log(
              `    \x1b[31m✗\x1b[0m create-issue: ${formatCollaborationError(result.error)}`,
            );
            receipts.push({
              action,
              success: false,
              error: formatCollaborationError(result.error),
            });
          }
          break;
        }
        case "close-issue": {
          if (!action.issueNumber) {
            receipts.push({ action, success: false, error: "missing issueNumber" });
            break;
          }
          const result = await provider.updateItemState(
            { id: String(action.issueNumber) },
            "closed",
          );
          if (result.ok) {
            console.log(`    \x1b[32m✓\x1b[0m close-issue #${String(action.issueNumber)}`);
            receipts.push({ action, success: true });
          } else {
            console.log(
              `    \x1b[31m✗\x1b[0m close-issue #${String(action.issueNumber)}: ${formatCollaborationError(result.error)}`,
            );
            receipts.push({
              action,
              success: false,
              error: formatCollaborationError(result.error),
            });
          }
          break;
        }
        case "comment-issue": {
          if (!action.issueNumber || !action.body) {
            receipts.push({ action, success: false, error: "missing issueNumber or body" });
            break;
          }
          const result = await provider.postComment(
            { id: String(action.issueNumber) },
            action.body,
          );
          if (result.ok) {
            console.log(`    \x1b[32m✓\x1b[0m comment-issue #${String(action.issueNumber)}`);
            receipts.push({ action, success: true });
          } else {
            console.log(
              `    \x1b[31m✗\x1b[0m comment-issue #${String(action.issueNumber)}: ${formatCollaborationError(result.error)}`,
            );
            receipts.push({
              action,
              success: false,
              error: formatCollaborationError(result.error),
            });
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

/** Result returned from runGroupWakeCommand for programmatic callers. */
export interface GroupWakeCommandResult {
  readonly groupId: string;
  readonly kind: string;
  readonly meetingMinutesUrl?: string;
  readonly receipts: readonly ActionReceipt[];
  readonly tallies: readonly GovernanceTally[];
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
}

export class GroupWakeError extends Error {
  public constructor(
    readonly code:
      | "GROUP_NOT_FOUND"
      | "INVALID_LLM_CONFIG"
      | "LLM_CONFIG_FAILED"
      | "MISSING_GROUP_ID"
      | "MISSING_LLM_TOKEN",
    message: string,
  ) {
    super(message);
    this.name = "GroupWakeError";
  }
}

export const runGroupWakeCommand = async (
  args: readonly string[],
  rootDir: string,
): Promise<GroupWakeCommandResult> => {
  const root = resolve(rootDir);

  // Parse args
  const groupIdx = args.indexOf("--group");
  const groupId = groupIdx >= 0 ? args[groupIdx + 1] : undefined;
  if (!groupId) {
    throw new GroupWakeError("MISSING_GROUP_ID", "murmuration convene: --group <id> is required");
  }

  const isGovernance = args.includes("--governance");
  const isRetrospective = args.includes("--retrospective");
  const kind: GroupWakeKind = isGovernance
    ? "governance"
    : isRetrospective
      ? "retrospective"
      : "operational";

  // --directive or --agenda both set the Source directive (which becomes the sole agenda)
  const directiveIdx = Math.max(args.indexOf("--directive"), args.indexOf("--agenda"));
  const directiveBody = directiveIdx >= 0 ? args[directiveIdx + 1] : undefined;

  // Load group config
  const groupDocPath = join(root, "governance", "groups", `${groupId}.md`);
  if (!existsSync(groupDocPath)) {
    throw new GroupWakeError(
      "GROUP_NOT_FOUND",
      `murmuration convene: group doc not found at ${groupDocPath}`,
    );
  }
  const groupContent = await readFile(groupDocPath, "utf8");
  const config = parseGroupConfig(groupId, groupContent);

  console.log(`Circle wake: ${config.name} (${kind})`);
  console.log(`  Members: ${config.members.join(", ")}`);
  console.log(`  Facilitator: ${config.facilitator}`);
  if (directiveBody) console.log(`  Directive: "${directiveBody}"`);
  console.log("");

  // Resolve LLM provider from facilitator's role.md
  const llmResult = await resolveLLMConfig(root, config.facilitator);
  if (!llmResult.ok) {
    printLLMResolveFailure(config.facilitator, llmResult);
    throw new GroupWakeError(
      "LLM_CONFIG_FAILED",
      `could not read LLM config from facilitator "${config.facilitator}" role.md`,
    );
  }
  const llmConfig = llmResult.config;
  console.log(`  LLM: ${llmConfig.provider}/${llmConfig.model}`);

  // Load secrets + clients
  const providerRegistry = buildBuiltinProviderRegistry();
  const envPath = join(root, ".env");
  let llmClient: LLMClient | undefined;
  let secretsProvider: DotenvSecretsProvider | undefined;

  // Subscription-CLI bypasses the registry and the .env entirely — auth
  // lives in the operator's CLI state, not in our secrets file.
  if (llmConfig.provider === "subscription-cli") {
    if (llmConfig.cli !== "claude" && llmConfig.cli !== "codex" && llmConfig.cli !== "gemini") {
      throw new GroupWakeError(
        "INVALID_LLM_CONFIG",
        `murmuration convene: facilitator "${config.facilitator}" has provider "subscription-cli" but llm.cli must be one of claude | codex | gemini`,
      );
    }
    llmClient = createSubscriptionCliClient({
      cli: llmConfig.cli,
      model: llmConfig.model,
      ...(llmConfig.timeoutMs !== undefined ? { timeoutMs: llmConfig.timeoutMs } : {}),
    });
  } else {
    const envKeyName = providerRegistry.envKeyName(llmConfig.provider);
    const secretKeyName = typeof envKeyName === "string" ? envKeyName : undefined;
    if (existsSync(envPath)) {
      secretsProvider = new DotenvSecretsProvider({ envPath });
      const optionalKeys = secretKeyName ? [makeSecretKey(secretKeyName)] : [];
      await secretsProvider.load({ required: [], optional: optionalKeys });
      const tokenKey = secretKeyName ? makeSecretKey(secretKeyName) : null;
      if (envKeyName === null) {
        // Keyless provider (e.g. local Ollama).
        llmClient = createLLMClient({
          registry: providerRegistry,
          provider: llmConfig.provider,
          model: llmConfig.model,
          token: null,
        });
      } else if (tokenKey && secretsProvider.has(tokenKey)) {
        llmClient = createLLMClient({
          registry: providerRegistry,
          provider: llmConfig.provider,
          model: llmConfig.model,
          token: secretsProvider.get(tokenKey),
        });
      }
    }

    if (!llmClient) {
      throw new GroupWakeError(
        "MISSING_LLM_TOKEN",
        `murmuration convene: ${secretKeyName ?? "LLM token"} not found in .env`,
      );
    }
  }

  // Resolve plugin terminology (for meeting prompts) and state graphs
  // (for governance queue filtering). Both are read once up front from
  // the --governance-plugin argument, if supplied.
  let pluginTerminology: GovernanceTerminology | undefined;
  const govPluginIdx = args.indexOf("--governance-plugin");
  const govPluginPath = govPluginIdx >= 0 ? args[govPluginIdx + 1] : undefined;
  let govPluginGraphs:
    | readonly {
        kind: string;
        initialState: string;
        terminalStates: readonly string[];
        transitions: readonly { from: string; to: string; trigger: string }[];
      }[]
    | undefined;
  if (govPluginPath) {
    try {
      const { pathToFileURL } = await import("node:url");
      const pluginMod = (await import(pathToFileURL(resolve(govPluginPath)).href)) as {
        default?: {
          terminology?: GovernanceTerminology;
          stateGraphs?: () => {
            kind: string;
            initialState: string;
            terminalStates: readonly string[];
            transitions: readonly { from: string; to: string; trigger: string }[];
          }[];
        };
      };
      pluginTerminology = pluginMod.default?.terminology;
      govPluginGraphs = pluginMod.default?.stateGraphs?.();
    } catch {
      /* best effort — fall back to generic terminology + no graph validation */
    }
  }

  // Load governance queue if governance meeting (read-only — transitions
  // are applied by the daemon after this function returns)
  const governanceQueue: GovernanceItem[] = [];
  if (isGovernance) {
    const govStore = new GovernanceStateStore({
      persistDir: join(root, ".murmuration", "governance"),
      readOnly: true,
    });

    if (govPluginGraphs) {
      for (const g of govPluginGraphs) govStore.registerGraph(g);
    }

    await govStore.load();
    const pending = govStore.query();
    // Filter to non-terminal items. Terminal state names are governance-model-defined;
    // the store's registered graphs declare them. If no graphs are registered (CLI
    // standalone), fall back to checking if the state store's graphs can tell us.
    const terminalStates = new Set(govStore.graphs().flatMap((g) => g.terminalStates));
    if (terminalStates.size > 0) {
      governanceQueue.push(...pending.filter((i) => !terminalStates.has(i.currentState)));
    } else {
      // No graphs registered — include all items and let the meeting decide
      governanceQueue.push(...pending);
    }
  }

  // Build the collaboration provider once for this command (backlog
  // fetch, meeting action execution, meeting minutes post).
  let collaboration: CollaborationProvider | undefined;
  let repoInfo: { owner: string; repo: string } | undefined;
  try {
    const built = await buildCollaborationProvider(root);
    collaboration = built.provider;
    if (built.repo) repoInfo = built.repo;
  } catch (err) {
    if (err instanceof CollaborationBuildError) {
      console.log(`  (collaboration provider unavailable: ${err.message})`);
    } else {
      console.log(
        `  (collaboration provider error: ${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
  if (!repoInfo) {
    // Fall back to agent-scope lookup for display purposes only.
    const fallback = await findDefaultRepo(root);
    if (fallback) repoInfo = fallback;
  }

  let backlogContext = "";
  if (collaboration) {
    const source = repoInfo ? `${repoInfo.owner}/${repoInfo.repo}` : collaboration.displayName;
    console.log(`  Fetching backlog from ${source}...`);
    backlogContext = await fetchGroupBacklog(collaboration);
  }

  const backlogForAgenda =
    collaboration && backlogContext
      ? `## Open Items (${repoInfo ? `${repoInfo.owner}/${repoInfo.repo}` : collaboration.displayName})\n\n${backlogContext}`
      : undefined;

  // Load retrospective metrics if this is a retrospective
  let retrospectiveMetrics: import("@murmurations-ai/core").RetrospectiveMetrics | undefined;
  if (isRetrospective) {
    const { AgentStateStore } = await import("@murmurations-ai/core");
    const stateStore = new AgentStateStore({
      persistDir: join(root, ".murmuration", "agents"),
      readOnly: true,
    });
    await stateStore.load();
    const agentMetrics = config.members.map((memberId) => {
      const agent = stateStore.getAgent(memberId);
      const totalWakes = agent?.totalWakes ?? 0;
      return {
        agentId: memberId,
        totalWakes,
        totalArtifacts: agent?.totalArtifacts ?? 0,
        idleWakes: agent?.idleWakes ?? 0,
        consecutiveFailures: agent?.consecutiveFailures ?? 0,
        artifactRate: totalWakes > 0 ? (agent?.totalArtifacts ?? 0) / totalWakes : 0,
        idleRate: totalWakes > 0 ? (agent?.idleWakes ?? 0) / totalWakes : 0,
      };
    });
    retrospectiveMetrics = {
      agentMetrics,
      period: `up to ${new Date().toISOString().slice(0, 10)}`,
    };
  }

  // Build context
  const context: GroupWakeContext = {
    groupId,
    kind,
    members: config.members,
    facilitator: config.facilitator,
    signals: [],
    governanceQueue,
    ...(directiveBody ? { directiveBody } : {}),
    ...(backlogForAgenda ? { backlogContext: backlogForAgenda } : {}),
    ...(retrospectiveMetrics ? { retrospectiveMetrics } : {}),
    ...(pluginTerminology ? { terminology: pluginTerminology } : {}),
  };

  // Run the group wake
  // Load extension tools so agents can use them in meetings (same as solo wakes)
  const { loadExtensions } = await import("@murmurations-ai/core");
  const extensionsDir = join(root, "extensions");
  const loadedExtensions = await loadExtensions(extensionsDir, root);
  const extensionTools = loadedExtensions.flatMap((ext) => ext.tools);
  if (extensionTools.length > 0) {
    console.log(
      `  Extensions: ${String(loadedExtensions.length)} loaded (${String(extensionTools.length)} tools)`,
    );
  }

  const client = llmClient;
  const model = llmConfig.model;
  const result = await runGroupWake(context, {
    callLLM: async ({ systemPrompt, userPrompt, agentId }) => {
      console.log(`  [${agentId}] contributing...`);
      const r = await client.complete({
        model,
        messages: [{ role: "user", content: userPrompt }],
        systemPromptOverride: systemPrompt,
        maxOutputTokens: 16000,
        temperature: 0.3,
        ...(extensionTools.length > 0 ? { tools: extensionTools, maxSteps: 5 } : {}),
      });
      if (!r.ok) throw new Error(`\n${formatLLMError(r.error, { agentId, model })}`);
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

  // Show the agenda
  if (result.agenda.length > 0) {
    console.log("AGENDA:");
    for (const [i, item] of result.agenda.entries()) {
      const tag = item.source === "directive" ? " [SOURCE DIRECTIVE]" : "";
      console.log(`  ${String(i + 1)}. ${item.title}${tag}`);
    }
    console.log("");
  }

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
  if (result.actions.length > 0 && collaboration) {
    console.log(`\n--- Executing ${String(result.actions.length)} action(s) ---\n`);
    receipts = await executeActions(result.actions, collaboration);
    const succeeded = receipts.filter((r) => r.success).length;
    const failed = receipts.filter((r) => !r.success).length;
    console.log(`\n  ${String(succeeded)} succeeded, ${String(failed)} failed`);
  } else if (result.actions.length > 0) {
    console.log(
      `\n--- ${String(result.actions.length)} action(s) proposed but no collaboration provider — skipped ---`,
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

  // Governance transitions are now applied by the daemon (DaemonCommandExecutor)
  // after this function returns, per Engineering Standard #3 (single owner for
  // mutable state). group-wake returns tallies; the daemon owns transitions.

  console.log(`\n${"─".repeat(60)}`);
  console.log(
    `Tokens: ${String(result.totalInputTokens)} in / ${String(result.totalOutputTokens)} out`,
  );
  console.log(
    `Cost: ~$${((result.totalInputTokens * 0.15 + result.totalOutputTokens * 0.6) / 1_000_000).toFixed(4)}`,
  );

  // Post meeting minutes as a GitHub issue
  let meetingMinutesUrl: string | undefined;
  const dayUtc = new Date().toISOString().slice(0, 10);
  const agendaSection =
    result.agenda.length > 0
      ? `\n## Agenda\n\n${result.agenda.map((a, i) => `${String(i + 1)}. **${a.title}**${a.source === "directive" ? " [SOURCE DIRECTIVE]" : ""}: ${a.description}`).join("\n")}\n`
      : "";
  const minutes = [
    `**Members:** ${config.members.join(", ")}`,
    `**Facilitator:** ${config.facilitator}`,
    directiveBody ? `**Source Directive:** ${directiveBody}` : "",
    agendaSection,
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

  const writeFallback = async (): Promise<void> => {
    const { writeFile: wf, mkdir } = await import("node:fs/promises");
    const meetingDir = join(root, "runs", `group-${groupId}`, dayUtc);
    await mkdir(meetingDir, { recursive: true });
    await wf(
      join(meetingDir, `meeting-${randomUUID().slice(0, 8)}.md`),
      `# ${config.name} — ${kind} meeting — ${dayUtc}\n\n${minutes}`,
      "utf8",
    );
  };

  if (collaboration) {
    const itemResult = await collaboration.createItem({
      title: `[${kind.toUpperCase()} MEETING] ${config.name} — ${dayUtc}`,
      labels: [meetingLabel, `group:${groupId}`],
      body: minutes,
    });
    if (itemResult.ok) {
      meetingMinutesUrl = itemResult.value.url ?? itemResult.value.id;
      console.log(`\nMeeting minutes: ${meetingMinutesUrl}`);
    } else {
      console.log(`\nFailed to create meeting item: ${itemResult.error.code}`);
      await writeFallback();
      console.log(`  (saved locally as fallback)`);
    }
  } else {
    await writeFallback();
    console.log(`\nMeeting minutes saved locally (no collaboration provider).`);
  }

  return {
    groupId,
    kind,
    ...(meetingMinutesUrl ? { meetingMinutesUrl } : {}),
    receipts,
    tallies: result.tallies,
    totalInputTokens: result.totalInputTokens,
    totalOutputTokens: result.totalOutputTokens,
  };
};
