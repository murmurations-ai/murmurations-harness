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
