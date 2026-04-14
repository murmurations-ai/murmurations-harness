/**
 * @murmurations-ai/github
 *
 * Typed GitHub REST client for the Murmuration Harness. Ships in
 * Phase 1B step B2. See `docs/adr/0012-github-client.md`.
 */

export { createGithubClient, DEFAULT_RETRY_POLICY } from "./client.js";
export type {
  CallOptions,
  GithubClient,
  GithubClientConfig,
  GithubCostHook,
  GithubCreateCommentInput,
  GithubCreatedComment,
  GithubCreateIssueInput,
  GithubCreatedIssue,
  GithubFileAddition,
  GithubFileDeletion,
  GithubFileChanges,
  GithubCommitMessage,
  GithubCreatedCommit,
  GithubRefHead,
  RetryPolicy,
} from "./client.js";

export { compileGlob, compileWriteScopes } from "./write-scopes.js";
export type { GithubWriteScopes, WriteScopeKind } from "./write-scopes.js";

export type { GithubComment, GithubIssue, ListIssuesFilter, Result } from "./types.js";

export type { GithubCache, GithubCacheEntry } from "./cache.js";
export { LruGithubCache } from "./cache.js";

export {
  GithubClientError,
  GithubConflictError,
  GithubForbiddenError,
  GithubInternalError,
  GithubMutationAbortedError,
  GithubNotFoundError,
  GithubParseError,
  GithubRateLimitError,
  GithubTransportError,
  GithubUnauthorizedError,
  GithubValidationError,
  GithubWriteScopeError,
} from "./errors.js";
export type {
  GithubClientErrorCode,
  GithubRateLimitSnapshot,
  GithubWriteScopeKind,
} from "./errors.js";

export {
  makeGithubOwner,
  makeGithubRepoName,
  makeIssueNumber,
  makeRepoCoordinate,
} from "./branded.js";
export type { GithubOwner, GithubRepoName, IssueNumber, RepoCoordinate } from "./branded.js";
