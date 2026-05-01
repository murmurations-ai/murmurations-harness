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
import type { GithubClient, GithubIssue } from "@murmurations-ai/github";

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
    ...overrides,
  }) as unknown as GithubClient;

describe("buildGithubReadToolsForAgent", () => {
  it("registers the five read tools by name", () => {
    const tools = buildGithubReadToolsForAgent(stubClient());
    expect(tools.map((t) => t.name)).toEqual([
      "read_issue",
      "list_issues",
      "list_issue_comments",
      "list_issue_labels",
      "get_branch_head",
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
});
