/**
 * Branded primitives for GitHub coordinates per ADR-0006. All
 * constructors validate format on construction; parse untrusted input
 * through a Zod schema before calling these.
 */

const OWNER_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-_.]{0,99}$/;

/** GitHub repository owner (user or org login). */
export interface GithubOwner {
  readonly kind: "github-owner";
  readonly value: string;
}
export const makeGithubOwner = (value: string): GithubOwner => {
  if (!OWNER_REPO_RE.test(value)) {
    throw new Error(`invalid github owner: "${value}"`);
  }
  return { kind: "github-owner", value };
};

/** GitHub repository name. */
export interface GithubRepoName {
  readonly kind: "github-repo-name";
  readonly value: string;
}
export const makeGithubRepoName = (value: string): GithubRepoName => {
  if (!OWNER_REPO_RE.test(value)) {
    throw new Error(`invalid github repo name: "${value}"`);
  }
  return { kind: "github-repo-name", value };
};

/** A fully-qualified `owner/repo` coordinate. */
export interface RepoCoordinate {
  readonly kind: "repo-coordinate";
  readonly owner: GithubOwner;
  readonly name: GithubRepoName;
}
export const makeRepoCoordinate = (owner: string, name: string): RepoCoordinate => ({
  kind: "repo-coordinate",
  owner: makeGithubOwner(owner),
  name: makeGithubRepoName(name),
});

/** A GitHub issue number (positive integer). */
export interface IssueNumber {
  readonly kind: "issue-number";
  readonly value: number;
}
export const makeIssueNumber = (value: number): IssueNumber => {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`invalid issue number: ${String(value)}`);
  }
  return { kind: "issue-number", value };
};
