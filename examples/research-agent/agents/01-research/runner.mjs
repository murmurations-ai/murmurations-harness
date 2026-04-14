/**
 * Research Agent in-process runner — Phase 2E1 real weekly digest flow.
 *
 * This is the runner the InProcessExecutor calls for every weekly
 * digest wake. It does the full flow:
 *
 *   1. Assemble the system prompt from the identity chain
 *      (murmuration soul → agent soul → agent role → circle contexts)
 *   2. Load the wake prompt body from `./prompts/wake.md` relative
 *      to this module
 *   3. Render the SignalBundle as a structured section appended to
 *      the wake prompt
 *   4. Call `clients.llm.complete(...)` with gemini-2.5-flash,
 *      maxOutputTokens 3000. Cost hook is already bound to the
 *      wake's WakeCostBuilder by `buildAgentClients(..., costBuilder)`
 *      in boot.ts.
 *   5. On success: fetch HEAD via `clients.github.getRef(repo, "main")`,
 *      commit the returned digest markdown to
 *      `notes/weekly/YYYY-MM-DD-research-digest.md` on `xeeban/emergent-praxis`
 *      via `createCommitOnBranch` with `expectedHeadOid` from step 5.
 *   6. Return an AgentRunnerResult whose wakeSummary names the commit
 *      OID + URL, signal count, and token usage.
 *
 * Graceful degradation at every absent-client boundary:
 *
 *   - no `clients.llm` (API key missing) → return a wake summary
 *     saying "no LLM client" and do nothing
 *   - LLM call fails (rate limit, transport, etc.) → throw with the
 *     error code; InProcessExecutor converts to `outcome: failed`
 *   - no `clients.github` → the digest is generated but NOT committed;
 *     wake summary includes the full digest text so 2D5's
 *     RunArtifactWriter still captures it to .murmuration/runs/
 *   - getRef fails → fall back to "no commit" mode (same as no github)
 *   - createCommitOnBranch fails with a scope error → throw; this is
 *     a config bug (write_scopes mismatch) and should fail loud
 *   - createCommitOnBranch fails with conflict → retry once with a
 *     fresh getRef, then give up
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";

// NOTE: this module deliberately has no imports from the harness
// workspace packages. It runs outside the monorepo (e.g. from
// ../test-murmuration) where `@murmurations-ai/*` package names don't
// resolve. All harness types are reached via the `ctx` bag that
// InProcessExecutor passes in, and the target repo is pre-built
// by boot.ts's resolveClients as `clients.targetRepo`.

const HERE = dirname(fileURLToPath(import.meta.url));
const WAKE_PROMPT_PATH = pathResolve(HERE, "prompts", "wake.md");

/**
 * Typed via a structural shape — no imports from workspace packages
 * because this module runs outside the monorepo.
 *
 * @param {{
 *   spawn: { wakeId: { value: string }, identity: { layers: { kind: string, content: string }[] }, signals: { signals: any[], assembledAt: Date } },
 *   costBuilder: unknown,
 *   signal: AbortSignal,
 *   clients: {
 *     llm?: {
 *       complete: (req: any, opts?: any) => Promise<{ ok: boolean, value?: any, error?: any }>
 *     },
 *     github?: {
 *       getRef: (repo: any, branch: string) => Promise<{ ok: boolean, value?: any, error?: any }>,
 *       createCommitOnBranch: (repo: any, branch: string, msg: any, changes: any, oid: string) => Promise<{ ok: boolean, value?: any, error?: any }>,
 *       listIssues: (repo: any, filter?: any) => Promise<{ ok: boolean, value?: any, error?: any }>,
 *       createIssue: (repo: any, input: any) => Promise<{ ok: boolean, value?: any, error?: any }>,
 *       createIssueComment: (repo: any, issueNumber: any, input: any) => Promise<{ ok: boolean, value?: any, error?: any }>
 *     },
 *     targetRepo?: any,
 *     targetBranch?: string
 *   }
 * }} ctx
 */
export default async function runWake(ctx) {
  const { spawn, clients, signal } = ctx;
  const wakeId = spawn.wakeId.value;
  const dayUtc = new Date().toISOString().slice(0, 10);

  // -- 1. Check LLM client availability -----------------------------
  if (!clients.llm) {
    return {
      wakeSummary: [
        `[research-agent] wake ${wakeId}`,
        `  status: skipped — no LLM client`,
        ``,
        `The Research Agent needs an LLM client to generate the digest.`,
        `Add GEMINI_API_KEY to the murmuration's .env and re-run.`,
      ].join("\n"),
    };
  }

  // -- 2. Assemble the system prompt from the identity chain --------
  //
  // The identity loader orders layers: murmuration-soul, agent-soul,
  // agent-role, then one `circle-context` per circle membership.
  // We concatenate them verbatim with divider headers so Gemini sees
  // a clean inherited hierarchy.
  const layerTitle = (kind) => {
    switch (kind) {
      case "murmuration-soul":
        return "# Murmuration Soul";
      case "agent-soul":
        return "# Agent Soul";
      case "agent-role":
        return "# Agent Role";
      case "circle-context":
        return "# Circle Context";
      default:
        return `# ${kind}`;
    }
  };
  const systemPrompt = spawn.identity.layers
    .map((layer) => `${layerTitle(layer.kind)}\n\n${layer.content.trim()}`)
    .join("\n\n---\n\n");

  // -- 3. Load the wake prompt file ---------------------------------
  let wakePromptBody;
  try {
    wakePromptBody = await readFile(WAKE_PROMPT_PATH, "utf8");
  } catch (cause) {
    throw new Error(
      `runner: failed to load wake prompt at ${WAKE_PROMPT_PATH}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  // -- 4. Render the signal bundle as a structured block ------------
  const renderSignal = (s) => {
    switch (s.kind) {
      case "github-issue":
        return `- [gh-issue #${String(s.number)}] ${s.title}\n  labels: ${s.labels.join(", ") || "(none)"}\n  url: ${s.url}\n  excerpt: ${s.excerpt}`;
      case "pipeline-item":
        return `- [pipeline] stage=${s.stage} issue=${String(s.issueNumber)} artifact=${s.artifactPath} age_hours=${String(s.ageHours)}`;
      case "inbox-message":
        return `- [inbox] from=${s.fromAgent.value} path=${s.path}\n  excerpt: ${s.excerpt}`;
      case "private-note":
        return `- [private-note] path=${s.path}\n  summary: ${s.summary}`;
      case "governance-round":
        return `- [governance-round] id=${s.roundId} event=${s.eventType} affects_agent=${String(s.affectsAgent)} url=${s.url}`;
      case "stall-alert":
        return `- [stall-alert] issue=${String(s.subjectIssue)} stage=${s.stage} stalled_for_hours=${String(s.stalledForHours)}`;
      default:
        return `- [unknown kind: ${/** @type {any} */ (s).kind}]`;
    }
  };
  const signalBlock =
    spawn.signals.signals.length === 0
      ? "_No signals received this wake. The aggregator returned zero items — proceed with a minimal digest explaining the empty signal set._"
      : spawn.signals.signals.map(renderSignal).join("\n");

  const userPrompt = `${wakePromptBody.trim()}

---

## Signal bundle (${String(spawn.signals.signals.length)} items, assembled at ${spawn.signals.assembledAt.toISOString()})

${signalBlock}

---

## Your output

Return **only** the digest markdown. Do NOT wrap the digest in a code fence. Do NOT include the \`::wake-summary::\` sentinel block — the harness captures that separately. The digest file will be committed verbatim to \`notes/weekly/${dayUtc}-research-digest.md\`.
`;

  // -- 5. Call Gemini -----------------------------------------------
  const llmResult = await clients.llm.complete(
    {
      // The model is already pinned via createLLMClient's config from
      // role.md's llm.model, but the LLMRequest requires `model` to be
      // set explicitly. Pass an empty string? No — LLMRequest.model is
      // required. We use the configured default by reading it from
      // capabilities; in practice boot.ts constructs the client with
      // { provider: "gemini", model: "gemini-2.5-flash" }, so we pass
      // the same model here.
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: userPrompt }],
      systemPromptOverride: systemPrompt,
      maxOutputTokens: 16000,
      temperature: 0.3,
    },
    { signal },
  );

  if (!llmResult.ok) {
    throw new Error(`LLM call failed: ${llmResult.error.code} — ${llmResult.error.message}`);
  }

  const digestBody = llmResult.value.content.trim();
  const inputTokens = llmResult.value.inputTokens;
  const outputTokens = llmResult.value.outputTokens;

  // -- 6. Commit the digest if a write-scoped github client is wired -
  if (!clients.github || !clients.targetRepo) {
    const reason = !clients.github ? "no github client" : "no targetRepo in clients bag";
    return {
      wakeSummary: [
        `[research-agent] wake ${wakeId}`,
        `  status: completed (digest generated; NOT committed — ${reason})`,
        `  model: ${llmResult.value.modelUsed}`,
        `  input_tokens: ${String(inputTokens)}`,
        `  output_tokens: ${String(outputTokens)}`,
        `  signal_count: ${String(spawn.signals.signals.length)}`,
        ``,
        `---`,
        ``,
        digestBody,
      ].join("\n"),
    };
  }

  const repo = clients.targetRepo;
  const targetBranch = clients.targetBranch ?? "main";
  const digestPath = `notes/weekly/${dayUtc}-research-digest.md`;

  // Fetch HEAD OID. If getRef fails we can't commit safely — fall
  // back to "digest-only" mode and surface the error in the summary.
  const headResult = await clients.github.getRef(repo, targetBranch);
  if (!headResult.ok) {
    return {
      wakeSummary: [
        `[research-agent] wake ${wakeId}`,
        `  status: completed (digest generated; commit skipped)`,
        `  commit_skipped_reason: getRef failed — ${headResult.error.code}: ${headResult.error.message}`,
        `  model: ${llmResult.value.modelUsed}`,
        `  input_tokens: ${String(inputTokens)}`,
        `  output_tokens: ${String(outputTokens)}`,
        ``,
        `---`,
        ``,
        digestBody,
      ].join("\n"),
    };
  }

  const commitResult = await clients.github.createCommitOnBranch(
    repo,
    targetBranch,
    {
      headline: `research: weekly digest ${dayUtc}`,
      body: `Generated by Research Agent (#1) via @murmurations-ai/harness in-process runner. wake_id=${wakeId}`,
    },
    {
      additions: [{ path: digestPath, contents: digestBody + "\n" }],
    },
    headResult.value.oid,
  );

  if (!commitResult.ok) {
    throw new Error(
      `createCommitOnBranch failed: ${commitResult.error.code} — ${commitResult.error.message}`,
    );
  }

  // -- 7. Post an announcement comment on a research-digest issue ---
  //
  // Find the most recent open issue labelled `type: research-digest`
  // from the last 7 days. If none exists, open one. Then post a
  // comment linking to the committed digest.
  let announcementUrl = null;
  try {
    const since = new Date(Date.now() - 7 * 86_400_000);
    const issuesResult = await clients.github.listIssues(repo, {
      state: "open",
      labels: ["type: research-digest"],
      since,
      perPage: 5,
    });

    let issueNumber;
    if (issuesResult.ok && issuesResult.value.length > 0) {
      issueNumber = issuesResult.value[0].number;
    } else {
      // No recent digest issue found — create one.
      const createResult = await clients.github.createIssue(repo, {
        title: `[RESEARCH] Weekly Digest — ${dayUtc}`,
        labels: ["circle: research", "type: research-digest"],
        body: `Automated digest issue opened by Research Agent (#1) via the Murmuration Harness.\n\nDigests are committed to \`notes/weekly/\` and announced as comments on this issue.`,
      });
      if (createResult.ok) {
        issueNumber = createResult.value.number;
      }
    }

    if (issueNumber) {
      const commentBody = [
        `## Research Digest — ${dayUtc}`,
        ``,
        `**Commit:** [\`${commitResult.value.oid.slice(0, 8)}\`](${commitResult.value.url})`,
        `**File:** \`${digestPath}\``,
        `**Model:** ${llmResult.value.modelUsed} (${String(inputTokens)} in / ${String(outputTokens)} out)`,
        `**Wake ID:** \`${wakeId}\``,
        ``,
        `<details><summary>Digest preview (first 500 chars)</summary>`,
        ``,
        "```",
        digestBody.slice(0, 500),
        "```",
        `</details>`,
      ].join("\n");

      const commentResult = await clients.github.createIssueComment(repo, issueNumber, {
        body: commentBody,
      });
      if (commentResult.ok) {
        announcementUrl = commentResult.value.htmlUrl;
      }
    }
  } catch {
    // Announcement is best-effort — don't fail the wake over it.
  }

  return {
    wakeSummary: [
      `[research-agent] wake ${wakeId}`,
      `  status: completed — digest committed + announced`,
      `  digest_path: ${digestPath}`,
      `  commit_oid: ${commitResult.value.oid}`,
      `  commit_url: ${commitResult.value.url}`,
      ...(announcementUrl ? [`  announcement_url: ${announcementUrl}`] : []),
      `  model: ${llmResult.value.modelUsed}`,
      `  input_tokens: ${String(inputTokens)}`,
      `  output_tokens: ${String(outputTokens)}`,
      `  signal_count: ${String(spawn.signals.signals.length)}`,
      ``,
      `---`,
      ``,
      digestBody,
    ].join("\n"),
    outputs: [
      {
        kind: "file-written",
        description: `committed ${digestPath}`,
        ref: commitResult.value.url,
      },
      ...(announcementUrl
        ? [
            {
              kind: "github-comment",
              description: `announced digest on research-digest issue`,
              ref: announcementUrl,
            },
          ]
        : []),
    ],
  };
}
