/**
 * GitHub read tools — agent-callable wrappers around the
 * harness's existing GithubClient. Constructed per-agent at boot
 * so each tool's underlying client carries the agent's per-wake
 * cost hook and (eventually) per-agent read scopes.
 *
 * Five read-only tools (replacement for harness#256, which was
 * filed against the wrong premise — bodies were already in the
 * SignalBundle, but agents had no GitHub-aware tools at all):
 *
 *   read_issue            — fetch one issue by repo + number
 *   list_issues           — list issues in a repo (filterable)
 *   list_issue_comments   — fetch comment thread for one issue
 *   list_issue_labels     — fetch labels for one issue
 *   get_branch_head       — fetch HEAD oid of a branch
 *
 * Writes are intentionally NOT added here. The existing WakeAction
 * pipeline handles writes post-wake under ADR-0017 scope enforcement
 * with the Boundary 5 narrative-vs-action audit (#240). Direct write
 * tools would reopen that hole.
 *
 * The `repo` parameter accepts the natural "owner/name" string form;
 * we parse it into a `RepoCoordinate` internally so the LLM doesn't
 * have to construct the branded shape.
 */

import { z } from "zod";

import { makeIssueNumber, makeRepoCoordinate, type GithubClient } from "@murmurations-ai/github";

interface GithubReadTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
  readonly execute: (input: Record<string, unknown>) => Promise<unknown>;
}

const REPO_RE = /^([\w.-]+)\/([\w.-]+)$/;

/**
 * Parse "owner/name" into a RepoCoordinate. Returns the structural
 * error message string on bad input so the tool can surface it as
 * a normal error response (LLMs handle plain-text errors better
 * than thrown exceptions inside tool execution).
 */
const parseRepo = (
  raw: string,
): { ok: true; value: ReturnType<typeof makeRepoCoordinate> } | { ok: false; message: string } => {
  const m = REPO_RE.exec(raw);
  if (!m?.[1] || !m[2]) {
    return {
      ok: false,
      message: `repo must be "owner/name" (got: "${raw}")`,
    };
  }
  try {
    return { ok: true, value: makeRepoCoordinate(m[1], m[2]) };
  } catch (err) {
    return {
      ok: false,
      message: `invalid repo "${raw}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

/**
 * Build the read-only tool surface against `client`. The client must
 * be one constructed for this agent's wake (cost hook bound) so calls
 * land in the per-wake `WakeCostBuilder`.
 */
export const buildGithubReadToolsForAgent = (client: GithubClient): readonly GithubReadTool[] => [
  {
    name: "read_issue",
    description:
      'Fetch a single GitHub issue by repository and number. Returns title, body, state, labels, author, timestamps. The `repo` argument is "owner/name" (e.g. "murmurations-ai/murmurations-harness").',
    parameters: z.object({
      repo: z.string().describe('"owner/name", e.g. "murmurations-ai/murmurations-harness"'),
      number: z.number().int().positive().describe("Issue number"),
    }),
    execute: async ({ repo, number }) => {
      const parsed = parseRepo(String(repo));
      if (!parsed.ok) return `read_issue error: ${parsed.message}`;
      const result = await client.getIssue(parsed.value, makeIssueNumber(Number(number)));
      if (!result.ok) {
        return `read_issue error: ${result.error.code} — ${result.error.message}`;
      }
      const issue = result.value;
      return JSON.stringify(
        {
          number: issue.number.value,
          title: issue.title,
          state: issue.state,
          body: issue.body ?? "",
          labels: issue.labels,
          authorLogin: issue.authorLogin,
          createdAt: issue.createdAt.toISOString(),
          updatedAt: issue.updatedAt.toISOString(),
          closedAt: issue.closedAt?.toISOString() ?? null,
          commentCount: issue.commentCount,
          htmlUrl: issue.htmlUrl,
        },
        null,
        2,
      );
    },
  },
  {
    name: "list_issues",
    description:
      "List GitHub issues in a repository, optionally filtered by state and labels. Returns up to `perPage` results (default 30, max 100). Useful for finding related/referenced issues that aren't in the agent's signal bundle.",
    parameters: z.object({
      repo: z.string().describe('"owner/name"'),
      state: z.enum(["open", "closed", "all"]).optional().describe('Default "open"'),
      labels: z.array(z.string()).optional().describe("Issues must carry ALL listed labels"),
      perPage: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Max issues to return (default 30, max 100)"),
    }),
    execute: async ({ repo, state, labels, perPage }) => {
      const parsed = parseRepo(String(repo));
      if (!parsed.ok) return `list_issues error: ${parsed.message}`;
      const filter: {
        state?: "open" | "closed" | "all";
        labels?: readonly string[];
        perPage?: number;
      } = {};
      if (state !== undefined) filter.state = state as "open" | "closed" | "all";
      if (Array.isArray(labels) && labels.length > 0) filter.labels = labels as string[];
      if (typeof perPage === "number") filter.perPage = perPage;
      const result = await client.listIssues(parsed.value, filter);
      if (!result.ok) {
        return `list_issues error: ${result.error.code} — ${result.error.message}`;
      }
      return JSON.stringify(
        result.value.map((issue) => ({
          number: issue.number.value,
          title: issue.title,
          state: issue.state,
          labels: issue.labels,
          authorLogin: issue.authorLogin,
          updatedAt: issue.updatedAt.toISOString(),
          htmlUrl: issue.htmlUrl,
        })),
        null,
        2,
      );
    },
  },
  {
    name: "list_issue_comments",
    description:
      "Fetch the comment thread for a GitHub issue. Returns all comments in chronological order with author + body. Use this when the issue body alone doesn't contain the resolution context (e.g., decisions reached in the comment thread).",
    parameters: z.object({
      repo: z.string().describe('"owner/name"'),
      number: z.number().int().positive().describe("Issue number"),
    }),
    execute: async ({ repo, number }) => {
      const parsed = parseRepo(String(repo));
      if (!parsed.ok) return `list_issue_comments error: ${parsed.message}`;
      const result = await client.listIssueComments(parsed.value, makeIssueNumber(Number(number)));
      if (!result.ok) {
        return `list_issue_comments error: ${result.error.code} — ${result.error.message}`;
      }
      return JSON.stringify(
        result.value.map((c) => ({
          id: c.id,
          authorLogin: c.authorLogin,
          body: c.body,
          createdAt: c.createdAt.toISOString(),
          htmlUrl: c.htmlUrl,
        })),
        null,
        2,
      );
    },
  },
  {
    name: "list_issue_labels",
    description:
      "Fetch the current labels on a GitHub issue. Useful for checking governance state (e.g. assigned:<agent>, status:*) without re-reading the whole issue.",
    parameters: z.object({
      repo: z.string().describe('"owner/name"'),
      number: z.number().int().positive().describe("Issue number"),
    }),
    execute: async ({ repo, number }) => {
      const parsed = parseRepo(String(repo));
      if (!parsed.ok) return `list_issue_labels error: ${parsed.message}`;
      const result = await client.listIssueLabels(parsed.value, makeIssueNumber(Number(number)));
      if (!result.ok) {
        return `list_issue_labels error: ${result.error.code} — ${result.error.message}`;
      }
      return result.value.join("\n");
    },
  },
  {
    name: "get_branch_head",
    description:
      "Fetch the HEAD commit oid of a branch in a repository. Read-only lookup; useful before proposing a commit (the WakeAction pipeline needs the expected head to safely commit).",
    parameters: z.object({
      repo: z.string().describe('"owner/name"'),
      branch: z.string().describe('Branch name (e.g. "main")'),
    }),
    execute: async ({ repo, branch }) => {
      const parsed = parseRepo(String(repo));
      if (!parsed.ok) return `get_branch_head error: ${parsed.message}`;
      const result = await client.getRef(parsed.value, String(branch));
      if (!result.ok) {
        return `get_branch_head error: ${result.error.code} — ${result.error.message}`;
      }
      return JSON.stringify(
        {
          repo: `${result.value.repo.owner.value}/${result.value.repo.name.value}`,
          branch: result.value.branch,
          oid: result.value.oid,
        },
        null,
        2,
      );
    },
  },
];
