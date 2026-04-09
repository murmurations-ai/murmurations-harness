/**
 * Zod schemas for GitHub REST responses. All response bodies cross a
 * trust boundary (untrusted network input) and are parsed here before
 * being handed to branded primitives.
 */

import { z } from "zod";

import { makeIssueNumber, type RepoCoordinate } from "./branded.js";
import { GithubParseError } from "./errors.js";
import type { GithubComment, GithubIssue, Result } from "./types.js";

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
