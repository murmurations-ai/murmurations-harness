/**
 * Research Agent in-process runner (Phase 2D8 reference).
 *
 * This runner is the function the InProcessExecutor calls for every
 * weekly digest wake. It receives:
 *
 *   - `spawn`        — the AgentSpawnContext the daemon built (identity
 *                      chain, signal bundle, wake reason, budget)
 *   - `costBuilder`  — the per-wake WakeCostBuilder; LLM + GitHub
 *                      cost hooks are already bound to it at
 *                      construction time via boot.ts's
 *                      `buildAgentClients` + `makeDaemonHook`
 *   - `signal`       — an AbortSignal the runner should observe for
 *                      wall-clock-budget kills
 *   - `clients`      — { llm?, github? } constructed per wake so the
 *                      cost hook lands on THIS wake's record
 *
 * The reference implementation deliberately does NOT make a live
 * LLM call or a real GitHub mutation — Phase 2D8 proves the
 * composition plumbing works end-to-end without spending money.
 * The real Research Agent wake lands in Phase 2E1 once the dual-run
 * week is authorized.
 *
 * Structure of the real wake (Phase 2E1+):
 *
 *   1. Pull signals from `spawn.signals.signals` (already aggregated
 *      per the role's `signals.github_scopes`)
 *   2. Call `clients.llm.complete({ model, messages, maxOutputTokens })`
 *      — one call; the catalog lookup + WakeCostBuilder.addLlmTokens
 *      happens inside the LLMClient's default cost hook automatically
 *   3. Render the digest markdown body
 *   4. `clients.github.createCommitOnBranch(repo, "main", message,
 *      fileChanges, expectedHeadOid)` to commit the digest to
 *      `notes/weekly/**`
 *   5. `clients.github.createIssueComment(repo, issueNumber, body)` to
 *      announce the digest on the most-recent `type: research-digest`
 *      issue, or `createIssue(repo, input)` if none exists in the
 *      last 7 days
 *   6. Return an AgentRunnerResult with the wake summary + optional
 *      output artifacts
 */

/**
 * @param {import('@murmuration/core').AgentRunnerContext<{
 *   llm?: import('@murmuration/llm').LLMClient;
 *   github?: import('@murmuration/github').GithubClient;
 * }>} ctx
 */
export default async function runWake(ctx) {
  const { spawn, clients, signal } = ctx;
  const wakeId = spawn.wakeId.value;
  const signalCount = spawn.signals.signals.length;
  const wakeReasonKind = spawn.wakeReason.kind;

  // Reference implementation — no live calls. Just emit a wake
  // summary that reports what the runner *saw* so the operator can
  // verify the seam is wired end-to-end.
  const summaryLines = [
    `[research-agent] wake ${wakeId}`,
    `  reason: ${wakeReasonKind}`,
    `  signals received: ${String(signalCount)}`,
    `  llm client: ${clients.llm ? "wired" : "absent"}`,
    `  github client: ${clients.github ? "wired" : "absent"}`,
    `  abort signal: ${signal.aborted ? "already aborted" : "pending"}`,
    ``,
    `NOTE: this is the Phase 2D8 reference runner. It does not make a`,
    `live Gemini call or a live GitHub commit. The in-process executor`,
    `+ per-wake client handoff + cost hook binding are structurally`,
    `proven by reaching this point. Phase 2E1 replaces this stub with`,
    `the real weekly digest workflow.`,
  ];

  return {
    wakeSummary: summaryLines.join("\n"),
    outputs: [],
    governanceEvents: [],
  };
}
