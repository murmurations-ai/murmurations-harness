/**
 * Unit tests for buildGithubReadToolsForAgent.
 *
 * Mocks a minimal GithubClient with just the read methods exercised
 * by the five tools. Verifies (a) tool list shape, (b) repo parsing,
 * (c) error surfaces flow back as plain strings, (d) successful
 * responses are JSON-serialized predictably.
 */

import { describe, it, expect } from "vitest";

import { makeIssueNumber, makeRepoCoordinate } from "@murmurations-ai/github";
import type {
  GithubClient,
  GithubCommit,
  GithubFileContent,
  GithubIssue,
  GithubPullRequest,
  GithubPullRequestFile,
} from "@murmurations-ai/github";

import { buildGithubReadToolsForAgent } from "./index.js";

const minimalIssue: GithubIssue = {
  number: makeIssueNumber(42),
  repo: makeRepoCoordinate("owner", "repo"),
  title: "Test issue",
  body: "Issue body content",
  state: "open",
  labels: ["bug", "good-first-issue"],
  authorLogin: "test-user",
  createdAt: new Date("2026-04-30T00:00:00Z"),
  updatedAt: new Date("2026-04-30T01:00:00Z"),
  closedAt: null,
  commentCount: 3,
  htmlUrl: "https://github.com/owner/repo/issues/42",
};

const successOf = <T>(value: T) => Promise.resolve({ ok: true as const, value });
const errorOf = (code: string, message: string) =>
  Promise.resolve({
    ok: false as const,
    error: { code, message } as never,
  });

const minimalPullRequest: GithubPullRequest = {
  number: makeIssueNumber(101),
  repo: makeRepoCoordinate("owner", "repo"),
  title: "Test PR",
  body: "PR body",
  state: "open",
  merged: false,
  draft: false,
  authorLogin: "test-user",
  headRef: "feature",
  headSha: "headsha",
  baseRef: "main",
  baseSha: "basesha",
  labels: ["enhancement"],
  createdAt: new Date("2026-04-30T00:00:00Z"),
  updatedAt: new Date("2026-04-30T01:00:00Z"),
  closedAt: null,
  mergedAt: null,
  commentCount: 2,
  reviewCommentCount: 5,
  commitCount: 3,
  additions: 100,
  deletions: 20,
  changedFiles: 4,
  htmlUrl: "https://github.com/owner/repo/pull/101",
};

const minimalPRFile: GithubPullRequestFile = {
  filename: "src/foo.ts",
  status: "modified",
  additions: 10,
  deletions: 2,
  changes: 12,
  previousFilename: null,
  patch: "@@ -1,3 +1,11 @@\n+added\n line",
};

const minimalCommit: GithubCommit = {
  sha: "55f66a0",
  repo: makeRepoCoordinate("owner", "repo"),
  message: "Test commit",
  authorLogin: "test-user",
  authorName: "Test User",
  authorEmail: "test@example.com",
  authoredAt: new Date("2026-04-30T00:00:00Z"),
  committerName: "Test User",
  committerEmail: "test@example.com",
  committedAt: new Date("2026-04-30T00:00:00Z"),
  parentShas: ["aaa111"],
  additions: 10,
  deletions: 2,
  totalChanges: 12,
  files: [minimalPRFile],
  htmlUrl: "https://github.com/owner/repo/commit/55f66a0",
};

const minimalFileContent: GithubFileContent = {
  path: "docs/adr/0017.md",
  repo: makeRepoCoordinate("owner", "repo"),
  ref: "main",
  sha: "filesha",
  size: 42,
  content: "# ADR 0017\n",
  encoding: "base64",
  htmlUrl: "https://github.com/owner/repo/blob/main/docs/adr/0017.md",
};

const stubClient = (
  overrides: Partial<{
    [K in keyof GithubClient]: GithubClient[K];
  }> = {},
): GithubClient =>
  ({
    getIssue: () => successOf(minimalIssue),
    listIssues: () => successOf([minimalIssue]),
    listIssueComments: () =>
      successOf([
        {
          id: 1,
          issueNumber: makeIssueNumber(42),
          authorLogin: "commenter",
          body: "First comment",
          createdAt: new Date("2026-04-30T00:30:00Z"),
          updatedAt: new Date("2026-04-30T00:30:00Z"),
          htmlUrl: "https://github.com/owner/repo/issues/42#comment-1",
        },
      ]),
    listIssueLabels: () => successOf(["bug", "good-first-issue"]),
    getRef: () =>
      successOf({
        repo: makeRepoCoordinate("owner", "repo"),
        branch: "main",
        oid: "abc123def",
      }),
    getPullRequest: () => successOf(minimalPullRequest),
    listPullRequests: () => successOf([minimalPullRequest]),
    getPullRequestFiles: () => successOf([minimalPRFile]),
    getCommit: () => successOf(minimalCommit),
    getFileAtRef: () => successOf(minimalFileContent),
    ...overrides,
  }) as unknown as GithubClient;

describe("buildGithubReadToolsForAgent", () => {
  it("registers all ten read tools by name", () => {
    const tools = buildGithubReadToolsForAgent(stubClient());
    expect(tools.map((t) => t.name)).toEqual([
      "read_issue",
      "list_issues",
      "list_issue_comments",
      "list_issue_labels",
      "get_branch_head",
      "read_pull_request",
      "list_pull_requests",
      "list_pull_request_files",
      "read_commit",
      "read_file_at_ref",
    ]);
  });

  it("read_issue returns serialized issue JSON for a valid repo", async () => {
    const tools = buildGithubReadToolsForAgent(stubClient());
    const tool = tools.find((t) => t.name === "read_issue");
    expect(tool).toBeDefined();
    const result = (await tool!.execute({ repo: "owner/repo", number: 42 })) as string;
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed.title).toBe("Test issue");
    expect(parsed.state).toBe("open");
    expect(parsed.body).toBe("Issue body content");
    expect(parsed.labels).toEqual(["bug", "good-first-issue"]);
  });

  it("read_issue surfaces parse errors as plain strings", async () => {
    const tools = buildGithubReadToolsForAgent(stubClient());
    const tool = tools.find((t) => t.name === "read_issue")!;
    const result = (await tool.execute({ repo: "not-a-valid-repo", number: 1 })) as string;
    expect(result).toMatch(/^read_issue error: repo must be "owner\/name"/);
  });

  it("read_issue surfaces client errors as plain strings", async () => {
    const client = stubClient({ getIssue: () => errorOf("not-found", "Issue not found") });
    const tools = buildGithubReadToolsForAgent(client);
    const tool = tools.find((t) => t.name === "read_issue")!;
    const result = (await tool.execute({ repo: "owner/repo", number: 9999 })) as string;
    expect(result).toBe("read_issue error: not-found — Issue not found");
  });

  it("list_issues passes through state and labels filters", async () => {
    let lastFilter: unknown;
    const client = stubClient({
      listIssues: (_repo, filter) => {
        lastFilter = filter;
        return successOf([minimalIssue]);
      },
    });
    const tools = buildGithubReadToolsForAgent(client);
    const tool = tools.find((t) => t.name === "list_issues")!;
    await tool.execute({
      repo: "owner/repo",
      state: "open",
      labels: ["assigned:agent"],
      perPage: 5,
    });
    expect(lastFilter).toEqual({
      state: "open",
      labels: ["assigned:agent"],
      perPage: 5,
    });
  });

  it("list_issues with no optional args sends an empty filter", async () => {
    let lastFilter: unknown;
    const client = stubClient({
      listIssues: (_repo, filter) => {
        lastFilter = filter;
        return successOf([]);
      },
    });
    const tools = buildGithubReadToolsForAgent(client);
    const tool = tools.find((t) => t.name === "list_issues")!;
    await tool.execute({ repo: "owner/repo" });
    expect(lastFilter).toEqual({});
  });

  it("list_issue_comments serializes each comment", async () => {
    const tools = buildGithubReadToolsForAgent(stubClient());
    const tool = tools.find((t) => t.name === "list_issue_comments")!;
    const result = (await tool.execute({ repo: "owner/repo", number: 42 })) as string;
    const parsed = JSON.parse(result) as { authorLogin: string; body: string }[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.authorLogin).toBe("commenter");
    expect(parsed[0]?.body).toBe("First comment");
  });

  it("list_issue_labels returns newline-joined labels", async () => {
    const tools = buildGithubReadToolsForAgent(stubClient());
    const tool = tools.find((t) => t.name === "list_issue_labels")!;
    const result = (await tool.execute({ repo: "owner/repo", number: 42 })) as string;
    expect(result).toBe("bug\ngood-first-issue");
  });

  it("get_branch_head returns repo + branch + oid as JSON", async () => {
    const tools = buildGithubReadToolsForAgent(stubClient());
    const tool = tools.find((t) => t.name === "get_branch_head")!;
    const result = (await tool.execute({ repo: "owner/repo", branch: "main" })) as string;
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed.repo).toBe("owner/repo");
    expect(parsed.branch).toBe("main");
    expect(parsed.oid).toBe("abc123def");
  });

  it("rejects empty-string repo with parse error", async () => {
    const tools = buildGithubReadToolsForAgent(stubClient());
    const tool = tools.find((t) => t.name === "read_issue")!;
    const result = (await tool.execute({ repo: "", number: 1 })) as string;
    expect(result).toMatch(/repo must be "owner\/name"/);
  });

  // -------------------------------------------------------------------------
  // PR / commit / file-at-ref tools
  // -------------------------------------------------------------------------

  it("read_pull_request returns serialized PR JSON", async () => {
    const tools = buildGithubReadToolsForAgent(stubClient());
    const tool = tools.find((t) => t.name === "read_pull_request")!;
    const result = (await tool.execute({ repo: "owner/repo", number: 101 })) as string;
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed.number).toBe(101);
    expect(parsed.title).toBe("Test PR");
    expect(parsed.headRef).toBe("feature");
    expect(parsed.baseRef).toBe("main");
    expect(parsed.changedFiles).toBe(4);
  });

  it("list_pull_requests passes filters through", async () => {
    let lastFilter: unknown;
    const client = stubClient({
      listPullRequests: (_repo, filter) => {
        lastFilter = filter;
        return successOf([minimalPullRequest]);
      },
    });
    const tools = buildGithubReadToolsForAgent(client);
    const tool = tools.find((t) => t.name === "list_pull_requests")!;
    await tool.execute({
      repo: "owner/repo",
      state: "open",
      base: "main",
      head: "feature",
      labels: ["enhancement"],
      perPage: 10,
    });
    expect(lastFilter).toEqual({
      state: "open",
      base: "main",
      head: "feature",
      labels: ["enhancement"],
      perPage: 10,
    });
  });

  it("list_pull_request_files surfaces patches", async () => {
    const tools = buildGithubReadToolsForAgent(stubClient());
    const tool = tools.find((t) => t.name === "list_pull_request_files")!;
    const result = (await tool.execute({ repo: "owner/repo", number: 101 })) as string;
    const parsed = JSON.parse(result) as { filename: string; patch: string }[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.filename).toBe("src/foo.ts");
    expect(parsed[0]?.patch).toContain("+added");
  });

  it("read_commit returns metadata + files", async () => {
    const tools = buildGithubReadToolsForAgent(stubClient());
    const tool = tools.find((t) => t.name === "read_commit")!;
    const result = (await tool.execute({ repo: "owner/repo", ref: "55f66a0" })) as string;
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed.sha).toBe("55f66a0");
    expect(parsed.message).toBe("Test commit");
    expect(parsed.parentShas).toEqual(["aaa111"]);
    expect(Array.isArray(parsed.files)).toBe(true);
  });

  it("read_file_at_ref returns the decoded content directly when present", async () => {
    const tools = buildGithubReadToolsForAgent(stubClient());
    const tool = tools.find((t) => t.name === "read_file_at_ref")!;
    const result = (await tool.execute({
      repo: "owner/repo",
      path: "docs/adr/0017.md",
      ref: "main",
    })) as string;
    expect(result).toBe("# ADR 0017\n");
  });

  it("read_file_at_ref surfaces a JSON descriptor when content is null (binary/large)", async () => {
    const client = stubClient({
      getFileAtRef: () => successOf({ ...minimalFileContent, content: null, encoding: "base64" }),
    });
    const tools = buildGithubReadToolsForAgent(client);
    const tool = tools.find((t) => t.name === "read_file_at_ref")!;
    const result = (await tool.execute({
      repo: "owner/repo",
      path: "img/logo.png",
      ref: "main",
    })) as string;
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed.content).toBeNull();
    expect(parsed.note).toContain("Binary file");
  });

  it("PR tools surface client errors as plain strings", async () => {
    const client = stubClient({
      getPullRequest: () => errorOf("not-found", "PR not found"),
    });
    const tools = buildGithubReadToolsForAgent(client);
    const tool = tools.find((t) => t.name === "read_pull_request")!;
    const result = (await tool.execute({ repo: "owner/repo", number: 999 })) as string;
    expect(result).toBe("read_pull_request error: not-found — PR not found");
  });
});
