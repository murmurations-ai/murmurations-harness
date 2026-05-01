/**
 * Zod schemas for GitHub REST responses. All response bodies cross a
 * trust boundary (untrusted network input) and are parsed here before
 * being handed to branded primitives.
 */

import { z } from "zod";

import { makeIssueNumber, type RepoCoordinate } from "./branded.js";
import { GithubParseError } from "./errors.js";
import type {
  GithubComment,
  GithubCommit,
  GithubFileContent,
  GithubIssue,
  GithubPullRequest,
  GithubPullRequestFile,
  Result,
} from "./types.js";

const labelSchema = z.union([z.string(), z.object({ name: z.string() }).transform((o) => o.name)]);

const issueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(["open", "closed"]),
  labels: z.array(labelSchema),
  user: z.object({ login: z.string() }).nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.string().nullable(),
  comments: z.number().int().nonnegative().default(0),
  html_url: z.string(),
});

const commentSchema = z.object({
  id: z.number(),
  user: z.object({ login: z.string() }).nullable(),
  body: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  html_url: z.string(),
});

const parseDate = (iso: string, field: string): Result<Date, GithubParseError> => {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) {
    return { ok: false, error: new GithubParseError(`invalid ${field}: ${iso}`) };
  }
  return { ok: true, value: d };
};

export const parseIssue = (
  raw: unknown,
  repo: RepoCoordinate,
): Result<GithubIssue, GithubParseError> => {
  const parsed = issueSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: new GithubParseError(`issue body failed validation: ${parsed.error.message}`),
    };
  }
  const data = parsed.data;
  const createdAt = parseDate(data.created_at, "created_at");
  if (!createdAt.ok) return createdAt;
  const updatedAt = parseDate(data.updated_at, "updated_at");
  if (!updatedAt.ok) return updatedAt;
  let closedAt: Date | null = null;
  if (data.closed_at !== null) {
    const p = parseDate(data.closed_at, "closed_at");
    if (!p.ok) return p;
    closedAt = p.value;
  }
  return {
    ok: true,
    value: {
      number: makeIssueNumber(data.number),
      repo,
      title: data.title,
      body: data.body,
      state: data.state,
      labels: data.labels,
      authorLogin: data.user?.login ?? "ghost",
      createdAt: createdAt.value,
      updatedAt: updatedAt.value,
      closedAt,
      commentCount: data.comments,
      htmlUrl: data.html_url,
    },
  };
};

export const parseIssueArray = (
  raw: unknown,
  repo: RepoCoordinate,
): Result<readonly GithubIssue[], GithubParseError> => {
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error: new GithubParseError("expected array of issues"),
    };
  }
  const out: GithubIssue[] = [];
  for (const item of raw) {
    const r = parseIssue(item, repo);
    if (!r.ok) return r;
    out.push(r.value);
  }
  return { ok: true, value: out };
};

export const parseComment = (
  raw: unknown,
  issueNumber: ReturnType<typeof makeIssueNumber>,
): Result<GithubComment, GithubParseError> => {
  const parsed = commentSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: new GithubParseError(`comment body failed validation: ${parsed.error.message}`),
    };
  }
  const data = parsed.data;
  const createdAt = parseDate(data.created_at, "created_at");
  if (!createdAt.ok) return createdAt;
  const updatedAt = parseDate(data.updated_at, "updated_at");
  if (!updatedAt.ok) return updatedAt;
  return {
    ok: true,
    value: {
      id: data.id,
      issueNumber,
      authorLogin: data.user?.login ?? "ghost",
      body: data.body,
      createdAt: createdAt.value,
      updatedAt: updatedAt.value,
      htmlUrl: data.html_url,
    },
  };
};

export const parseCommentArray = (
  raw: unknown,
  issueNumber: ReturnType<typeof makeIssueNumber>,
): Result<readonly GithubComment[], GithubParseError> => {
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error: new GithubParseError("expected array of comments"),
    };
  }
  const out: GithubComment[] = [];
  for (const item of raw) {
    const r = parseComment(item, issueNumber);
    if (!r.ok) return r;
    out.push(r.value);
  }
  return { ok: true, value: out };
};

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

const pullRequestSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(["open", "closed"]),
  merged: z.boolean().optional(),
  draft: z.boolean().optional(),
  user: z.object({ login: z.string() }).nullable(),
  head: z.object({ ref: z.string(), sha: z.string() }),
  base: z.object({ ref: z.string(), sha: z.string() }),
  labels: z.array(labelSchema),
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.string().nullable(),
  merged_at: z.string().nullable(),
  // Aggregate fields are present on the single-PR endpoint but not in
  // list responses. Mark optional so listPullRequests parses cleanly.
  comments: z.number().int().nonnegative().optional(),
  review_comments: z.number().int().nonnegative().optional(),
  commits: z.number().int().nonnegative().optional(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  changed_files: z.number().int().nonnegative().optional(),
  html_url: z.string(),
});

export const parsePullRequest = (
  raw: unknown,
  repo: RepoCoordinate,
): Result<GithubPullRequest, GithubParseError> => {
  const parsed = pullRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: new GithubParseError(`pull-request body failed validation: ${parsed.error.message}`),
    };
  }
  const data = parsed.data;
  const createdAt = parseDate(data.created_at, "created_at");
  if (!createdAt.ok) return createdAt;
  const updatedAt = parseDate(data.updated_at, "updated_at");
  if (!updatedAt.ok) return updatedAt;
  let closedAt: Date | null = null;
  if (data.closed_at !== null) {
    const p = parseDate(data.closed_at, "closed_at");
    if (!p.ok) return p;
    closedAt = p.value;
  }
  let mergedAt: Date | null = null;
  if (data.merged_at !== null) {
    const p = parseDate(data.merged_at, "merged_at");
    if (!p.ok) return p;
    mergedAt = p.value;
  }
  return {
    ok: true,
    value: {
      number: makeIssueNumber(data.number),
      repo,
      title: data.title,
      body: data.body,
      state: data.state,
      merged: data.merged ?? mergedAt !== null,
      draft: data.draft ?? false,
      authorLogin: data.user?.login ?? "ghost",
      headRef: data.head.ref,
      headSha: data.head.sha,
      baseRef: data.base.ref,
      baseSha: data.base.sha,
      labels: data.labels,
      createdAt: createdAt.value,
      updatedAt: updatedAt.value,
      closedAt,
      mergedAt,
      commentCount: data.comments ?? 0,
      reviewCommentCount: data.review_comments ?? 0,
      commitCount: data.commits ?? 0,
      additions: data.additions ?? 0,
      deletions: data.deletions ?? 0,
      changedFiles: data.changed_files ?? 0,
      htmlUrl: data.html_url,
    },
  };
};

export const parsePullRequestArray = (
  raw: unknown,
  repo: RepoCoordinate,
): Result<readonly GithubPullRequest[], GithubParseError> => {
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error: new GithubParseError("expected array of pull requests"),
    };
  }
  const out: GithubPullRequest[] = [];
  for (const item of raw) {
    const r = parsePullRequest(item, repo);
    if (!r.ok) return r;
    out.push(r.value);
  }
  return { ok: true, value: out };
};

// ---------------------------------------------------------------------------
// PR files / commit files (same shape on both endpoints)
// ---------------------------------------------------------------------------

const fileChangeSchema = z.object({
  filename: z.string(),
  status: z.enum(["added", "modified", "removed", "renamed", "copied", "changed", "unchanged"]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changes: z.number().int().nonnegative(),
  previous_filename: z.string().optional(),
  patch: z.string().optional(),
});

const parseFileChange = (raw: unknown): Result<GithubPullRequestFile, GithubParseError> => {
  const parsed = fileChangeSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: new GithubParseError(`file change body failed validation: ${parsed.error.message}`),
    };
  }
  const data = parsed.data;
  return {
    ok: true,
    value: {
      filename: data.filename,
      status: data.status,
      additions: data.additions,
      deletions: data.deletions,
      changes: data.changes,
      previousFilename: data.previous_filename ?? null,
      patch: data.patch ?? null,
    },
  };
};

export const parsePullRequestFiles = (
  raw: unknown,
): Result<readonly GithubPullRequestFile[], GithubParseError> => {
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error: new GithubParseError("expected array of files"),
    };
  }
  const out: GithubPullRequestFile[] = [];
  for (const item of raw) {
    const r = parseFileChange(item);
    if (!r.ok) return r;
    out.push(r.value);
  }
  return { ok: true, value: out };
};

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

const commitSchema = z.object({
  sha: z.string(),
  commit: z.object({
    message: z.string(),
    author: z
      .object({
        name: z.string(),
        email: z.string(),
        date: z.string(),
      })
      .nullable(),
    committer: z
      .object({
        name: z.string(),
        email: z.string(),
        date: z.string(),
      })
      .nullable(),
  }),
  author: z.object({ login: z.string() }).nullable(),
  parents: z.array(z.object({ sha: z.string() })),
  stats: z
    .object({
      additions: z.number().int().nonnegative().optional(),
      deletions: z.number().int().nonnegative().optional(),
      total: z.number().int().nonnegative().optional(),
    })
    .optional(),
  files: z.array(fileChangeSchema).optional(),
  html_url: z.string(),
});

export const parseCommit = (
  raw: unknown,
  repo: RepoCoordinate,
): Result<GithubCommit, GithubParseError> => {
  const parsed = commitSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: new GithubParseError(`commit body failed validation: ${parsed.error.message}`),
    };
  }
  const data = parsed.data;
  const author = data.commit.author;
  const committer = data.commit.committer;
  if (!author || !committer) {
    return {
      ok: false,
      error: new GithubParseError("commit missing author/committer"),
    };
  }
  const authoredAt = parseDate(author.date, "commit.author.date");
  if (!authoredAt.ok) return authoredAt;
  const committedAt = parseDate(committer.date, "commit.committer.date");
  if (!committedAt.ok) return committedAt;
  const files: GithubPullRequestFile[] = [];
  for (const item of data.files ?? []) {
    const r = parseFileChange(item);
    if (!r.ok) return r;
    files.push(r.value);
  }
  return {
    ok: true,
    value: {
      sha: data.sha,
      repo,
      message: data.commit.message,
      authorLogin: data.author?.login ?? null,
      authorName: author.name,
      authorEmail: author.email,
      authoredAt: authoredAt.value,
      committerName: committer.name,
      committerEmail: committer.email,
      committedAt: committedAt.value,
      parentShas: data.parents.map((p) => p.sha),
      additions: data.stats?.additions ?? 0,
      deletions: data.stats?.deletions ?? 0,
      totalChanges: data.stats?.total ?? 0,
      files,
      htmlUrl: data.html_url,
    },
  };
};

// ---------------------------------------------------------------------------
// File contents at ref
// ---------------------------------------------------------------------------

const fileContentSchema = z.object({
  type: z.literal("file"),
  path: z.string(),
  sha: z.string(),
  size: z.number().int().nonnegative(),
  content: z.string().optional(),
  encoding: z.string().optional(),
  html_url: z.string(),
});

export const parseFileContent = (
  raw: unknown,
  repo: RepoCoordinate,
  ref: string,
): Result<GithubFileContent, GithubParseError> => {
  const parsed = fileContentSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: new GithubParseError(
        `file content body failed validation (note: directories aren't supported, only files): ${parsed.error.message}`,
      ),
    };
  }
  const data = parsed.data;
  let decoded: string | null = null;
  const encoding = data.encoding ?? "none";
  if (data.content !== undefined && encoding === "base64") {
    try {
      // GitHub returns base64-encoded content with newlines every 60 chars.
      const cleaned = data.content.replace(/\n/g, "");
      decoded = Buffer.from(cleaned, "base64").toString("utf8");
    } catch {
      decoded = null;
    }
  } else if (data.content !== undefined && encoding === "utf-8") {
    decoded = data.content;
  }
  return {
    ok: true,
    value: {
      path: data.path,
      repo,
      ref,
      sha: data.sha,
      size: data.size,
      content: decoded,
      encoding,
      htmlUrl: data.html_url,
    },
  };
};
