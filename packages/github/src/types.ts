/**
 * Domain types the GitHub client exposes. These are the subset of
 * GitHub's REST resources the harness actually consumes — narrow on
 * purpose. Extending them is an additive change.
 */

import type { IssueNumber, RepoCoordinate } from "./branded.js";

/** Re-exported from @murmurations-ai/core for backwards compatibility. */
export type { Result } from "@murmurations-ai/core";

/** The subset of GitHub's issue resource the harness reads. */
export interface GithubIssue {
  readonly number: IssueNumber;
  readonly repo: RepoCoordinate;
  readonly title: string;
  readonly body: string | null;
  readonly state: "open" | "closed";
  readonly labels: readonly string[];
  readonly authorLogin: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly closedAt: Date | null;
  readonly commentCount: number;
  readonly htmlUrl: string;
}

export interface GithubComment {
  readonly id: number;
  readonly issueNumber: IssueNumber;
  readonly authorLogin: string;
  readonly body: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly htmlUrl: string;
}

export interface ListIssuesFilter {
  readonly state?: "open" | "closed" | "all";
  readonly labels?: readonly string[];
  readonly since?: Date;
  readonly perPage?: number;
  readonly bypassCache?: boolean;
}

/**
 * The subset of GitHub's pull-request resource the harness reads.
 * GitHub treats PRs as a specialized issue, but the API surfaces are
 * separate; this type captures the PR-specific fields agents need to
 * review (head/base, mergeability, files-changed count).
 */
export interface GithubPullRequest {
  readonly number: IssueNumber;
  readonly repo: RepoCoordinate;
  readonly title: string;
  readonly body: string | null;
  readonly state: "open" | "closed";
  readonly merged: boolean;
  readonly draft: boolean;
  readonly authorLogin: string;
  readonly headRef: string;
  readonly headSha: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly labels: readonly string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly closedAt: Date | null;
  readonly mergedAt: Date | null;
  readonly commentCount: number;
  readonly reviewCommentCount: number;
  readonly commitCount: number;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  readonly htmlUrl: string;
}

/**
 * One file changed in a pull request, including its unified-diff
 * patch when GitHub returns one. Patches are omitted by GitHub for
 * very large files (>3000 line changes) — `patch` is null in that
 * case and agents must fall back to fetching the file at the head
 * and base refs separately.
 */
export interface GithubPullRequestFile {
  readonly filename: string;
  readonly status:
    | "added"
    | "modified"
    | "removed"
    | "renamed"
    | "copied"
    | "changed"
    | "unchanged";
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
  readonly previousFilename: string | null;
  readonly patch: string | null;
}

/**
 * The subset of GitHub's commit resource the harness reads — commit
 * metadata plus the list of files changed (with patches when small
 * enough). For listing, see `getCommit`.
 */
export interface GithubCommit {
  readonly sha: string;
  readonly repo: RepoCoordinate;
  readonly message: string;
  readonly authorLogin: string | null;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly authoredAt: Date;
  readonly committerName: string;
  readonly committerEmail: string;
  readonly committedAt: Date;
  readonly parentShas: readonly string[];
  readonly additions: number;
  readonly deletions: number;
  readonly totalChanges: number;
  readonly files: readonly GithubPullRequestFile[];
  readonly htmlUrl: string;
}

/**
 * File contents at a specific git ref (commit, branch, or tag).
 * Returns the decoded UTF-8 text when the file is text — for binary
 * files, callers fall back to `htmlUrl` (the raw blob in the GitHub
 * UI) since the harness has no use case for binary inspection today.
 */
export interface GithubFileContent {
  readonly path: string;
  readonly repo: RepoCoordinate;
  readonly ref: string;
  readonly sha: string;
  readonly size: number;
  readonly content: string | null;
  readonly encoding: string;
  readonly htmlUrl: string;
}

export interface ListPullRequestsFilter {
  readonly state?: "open" | "closed" | "all";
  readonly labels?: readonly string[];
  readonly base?: string;
  readonly head?: string;
  readonly perPage?: number;
  readonly bypassCache?: boolean;
}
