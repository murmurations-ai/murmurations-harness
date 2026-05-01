/**
 * Built-in GitHub read extension.
 *
 * MARKER entry: registers the extension id `github` so the loader
 * discovers it, but contributes no tools at load time. The actual
 * tools are constructed per-agent at boot by
 * `buildGithubReadToolsForAgent()` in `packages/cli/src/github-tools/index.ts`,
 * then merged into the agent's tool list by `selectExtensionToolsFor()`
 * in boot. Reason: the GithubClient that backs these tools is bound to
 * the per-agent `defaultCostHook` for accurate `WakeCostBuilder` audit
 * counts, so it cannot be a shared boot-time singleton.
 *
 * Five read-only tools are exposed when an agent declares this plugin
 * and `GITHUB_TOKEN` is present:
 *   read_issue(repo, number)
 *   list_issues(repo, state?, labels?, perPage?)
 *   list_issue_comments(repo, number)
 *   list_issue_labels(repo, number)
 *   get_branch_head(repo, branch)
 *
 * Writes are not added here — the existing WakeAction pipeline
 * already handles labels/comments/issue creation post-wake under
 * the agent's declared `github.write_scopes` (ADR-0017). Direct
 * write tools would re-open the Boundary 5 narrative-vs-action
 * audit hole that #240 closes.
 *
 * Declare in `role.md`:
 *   plugins:
 *     - provider: "@murmurations-ai/github"
 */

/** @type {import("@murmurations-ai/core").ExtensionEntry} */
export default {
  id: "github",
  name: "GitHub Read Tools",
  description:
    "Read issues, comments, labels, and branch heads via the harness's existing GithubClient. Tools are agent-bound and built per-agent in boot, not registered here.",
  register(_api) {
    // Intentional no-op: tools are agent-bound and injected
    // per-agent in selectExtensionToolsFor, not at load time.
  },
};
