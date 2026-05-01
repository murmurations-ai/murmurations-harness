/**
 * GithubClient — the runtime surface. Native `fetch` underneath, with
 * ETag caching, rate-limit accounting, and basic retry on transport
 * failures. No Octokit: see ADR-0012 for the rationale.
 *
 * SecretValue auth: `token.reveal()` is called in exactly ONE place in
 * this file (`#buildHeaders`). If you add a second call, delete it —
 * the whole point of the SecretValue wrapper is that the raw token
 * does not flow through the client's bookkeeping or error paths.
 */

import type { SecretValue } from "@murmurations-ai/core";

import { makeIssueNumber, type IssueNumber, type RepoCoordinate } from "./branded.js";
import { LruGithubCache, type GithubCache, type GithubCacheEntry } from "./cache.js";
import {
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
  type GithubClientError,
  type GithubRateLimitSnapshot,
  type GithubWriteScopeKind,
} from "./errors.js";
import {
  parseCommentArray,
  parseCommit,
  parseFileContent,
  parseIssue,
  parseIssueArray,
  parsePullRequest,
  parsePullRequestArray,
  parsePullRequestFiles,
} from "./parse.js";
import type {
  GithubComment,
  GithubCommit,
  GithubFileContent,
  GithubIssue,
  GithubPullRequest,
  GithubPullRequestFile,
  ListIssuesFilter,
  ListPullRequestsFilter,
  Result,
} from "./types.js";
import {
  compileWriteScopes,
  matchesRepoPath,
  type CompiledWriteScopes,
  type GithubWriteScopes,
} from "./write-scopes.js";

// ---------------------------------------------------------------------------
// Cost hook
// ---------------------------------------------------------------------------

/**
 * Per-call cost hook bound to the active `WakeCostBuilder`. The shape
 * is a strict subset of `WakeCostBuilder.addGithubCall`'s parameter,
 * so the adapter is a two-line closure.
 */
export interface GithubCostHook {
  onGithubCall(call: {
    readonly transport: "rest" | "graphql";
    readonly cacheHit?: boolean;
    readonly rateLimitRemaining?: number;
  }): void;
}

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly retryableStatuses: readonly number[];
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 5_000,
  retryableStatuses: [502, 503, 504],
};

/**
 * Mutations are non-idempotent. Per ADR-0017 §6 this constant is
 * hard-coded and NOT honoring `config.retryPolicy` — a user-supplied
 * override cannot re-enable mutation retry. Do not parameterize.
 */
const MUTATION_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 1,
  baseDelayMs: 0,
  maxDelayMs: 0,
  retryableStatuses: [],
};

// ---------------------------------------------------------------------------
// Client config + interface
// ---------------------------------------------------------------------------

export interface GithubClientConfig {
  readonly token: SecretValue;
  readonly baseUrl?: string;
  readonly cache?: GithubCache;
  readonly retryPolicy?: RetryPolicy;
  readonly defaultCostHook?: GithubCostHook;
  readonly userAgent?: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  /**
   * Per ADR-0017 §4: default-deny. If omitted, every mutation method
   * returns `GithubWriteScopeError`. Must be explicitly supplied to
   * enable writes.
   */
  readonly writeScopes?: GithubWriteScopes;
}

// ---------------------------------------------------------------------------
// Mutation input / output types (ADR-0017 §3)
// ---------------------------------------------------------------------------

export interface GithubCreateCommentInput {
  readonly body: string;
}

export interface GithubCreatedComment {
  readonly id: number;
  readonly issueNumber: IssueNumber;
  readonly repo: RepoCoordinate;
  readonly body: string;
  readonly createdAt: Date;
  readonly htmlUrl: string;
}

export interface GithubCreateIssueInput {
  readonly title: string;
  readonly body?: string;
  readonly labels?: readonly string[];
  readonly assignees?: readonly string[];
}

export interface GithubCreatedIssue {
  readonly number: IssueNumber;
  readonly repo: RepoCoordinate;
  readonly title: string;
  readonly htmlUrl: string;
  readonly createdAt: Date;
}

export interface GithubFileAddition {
  readonly path: string;
  readonly contents: string; // UTF-8; client base64-encodes
}

export interface GithubFileDeletion {
  readonly path: string;
}

export interface GithubFileChanges {
  readonly additions?: readonly GithubFileAddition[];
  readonly deletions?: readonly GithubFileDeletion[];
}

export interface GithubCommitMessage {
  readonly headline: string;
  readonly body?: string;
}

export interface GithubCreatedCommit {
  readonly oid: string;
  readonly url: string;
  readonly repo: RepoCoordinate;
  readonly branch: string;
}

/**
 * Branch HEAD reference — just enough for ADR-0017's
 * `expectedHeadOid` argument to `createCommitOnBranch`. Read-only.
 * Closes CF-github-J from ADR-0017 §11.
 */
export interface GithubRefHead {
  readonly repo: RepoCoordinate;
  readonly branch: string;
  readonly oid: string;
}

export interface GithubClient {
  getIssue(
    repo: RepoCoordinate,
    number: IssueNumber,
    options?: CallOptions,
  ): Promise<Result<GithubIssue, GithubClientError>>;

  listIssues(
    repo: RepoCoordinate,
    filter?: ListIssuesFilter & { readonly costHook?: GithubCostHook },
  ): Promise<Result<readonly GithubIssue[], GithubClientError>>;

  listIssueComments(
    repo: RepoCoordinate,
    number: IssueNumber,
    options?: CallOptions,
  ): Promise<Result<readonly GithubComment[], GithubClientError>>;

  listIssueLabels(
    repo: RepoCoordinate,
    number: IssueNumber,
    options?: CallOptions,
  ): Promise<Result<readonly string[], GithubClientError>>;

  /**
   * Read-only lookup of a branch's HEAD commit. Used to fetch the
   * `expectedHeadOid` that `createCommitOnBranch` requires — closes
   * CF-github-J from ADR-0017 §11.
   */
  getRef(
    repo: RepoCoordinate,
    branch: string,
    options?: CallOptions,
  ): Promise<Result<GithubRefHead, GithubClientError>>;

  // -- Pull-request reads (harness#262 follow-up) -------------------------

  /** Fetch a single pull request by number. */
  getPullRequest(
    repo: RepoCoordinate,
    number: IssueNumber,
    options?: CallOptions,
  ): Promise<Result<GithubPullRequest, GithubClientError>>;

  /** List pull requests in a repo, optionally filtered. */
  listPullRequests(
    repo: RepoCoordinate,
    filter?: ListPullRequestsFilter & { readonly costHook?: GithubCostHook },
  ): Promise<Result<readonly GithubPullRequest[], GithubClientError>>;

  /**
   * Fetch the files changed in a pull request, with unified-diff
   * patches for each (when GitHub returns one — files >3000 line
   * changes have null patches).
   */
  getPullRequestFiles(
    repo: RepoCoordinate,
    number: IssueNumber,
    options?: CallOptions,
  ): Promise<Result<readonly GithubPullRequestFile[], GithubClientError>>;

  // -- Commit / file reads -----------------------------------------------

  /** Fetch a commit by SHA (or ref) including files changed + patches. */
  getCommit(
    repo: RepoCoordinate,
    ref: string,
    options?: CallOptions,
  ): Promise<Result<GithubCommit, GithubClientError>>;

  /** Fetch a file's contents at a specific ref (commit, branch, or tag). */
  getFileAtRef(
    repo: RepoCoordinate,
    path: string,
    ref: string,
    options?: CallOptions,
  ): Promise<Result<GithubFileContent, GithubClientError>>;

  // -- Mutations (ADR-0017) ------------------------------------------------

  createIssueComment(
    repo: RepoCoordinate,
    issueNumber: IssueNumber,
    input: GithubCreateCommentInput,
    options?: CallOptions,
  ): Promise<Result<GithubCreatedComment, GithubClientError>>;

  createIssue(
    repo: RepoCoordinate,
    input: GithubCreateIssueInput,
    options?: CallOptions,
  ): Promise<Result<GithubCreatedIssue, GithubClientError>>;

  createCommitOnBranch(
    repo: RepoCoordinate,
    branch: string,
    message: GithubCommitMessage,
    fileChanges: GithubFileChanges,
    expectedHeadOid: string,
    options?: CallOptions,
  ): Promise<Result<GithubCreatedCommit, GithubClientError>>;

  /** Add labels to an issue. */
  addLabels(
    repo: RepoCoordinate,
    issueNumber: IssueNumber,
    labels: readonly string[],
    options?: CallOptions,
  ): Promise<Result<readonly string[], GithubClientError>>;

  /** Remove a label from an issue. */
  removeLabel(
    repo: RepoCoordinate,
    issueNumber: IssueNumber,
    label: string,
    options?: CallOptions,
  ): Promise<Result<void, GithubClientError>>;

  /** Update an issue's state (open/closed). */
  updateIssueState(
    repo: RepoCoordinate,
    issueNumber: IssueNumber,
    state: "open" | "closed",
    options?: CallOptions,
  ): Promise<Result<void, GithubClientError>>;

  lastRateLimit(): GithubRateLimitSnapshot | null;
}

export interface CallOptions {
  readonly bypassCache?: boolean;
  readonly costHook?: GithubCostHook;
  readonly signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createGithubClient = (config: GithubClientConfig): GithubClient =>
  new GithubClientImpl(config);

// ---------------------------------------------------------------------------
// Implementation (private)
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://api.github.com";
const DEFAULT_USER_AGENT = "murmuration-harness/0.1";

interface RawResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
  readonly etag: string | null;
  readonly rateLimit: GithubRateLimitSnapshot | null;
}

class GithubClientImpl implements GithubClient {
  readonly #token: SecretValue;
  readonly #baseUrl: string;
  readonly #cache: GithubCache;
  readonly #retryPolicy: RetryPolicy;
  readonly #defaultCostHook: GithubCostHook | undefined;
  readonly #userAgent: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #writeScopes: CompiledWriteScopes | null;
  #lastRateLimit: GithubRateLimitSnapshot | null = null;

  public constructor(config: GithubClientConfig) {
    this.#token = config.token;
    this.#baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.#cache = config.cache ?? new LruGithubCache();
    this.#retryPolicy = config.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.#defaultCostHook = config.defaultCostHook;
    this.#userAgent = config.userAgent ?? DEFAULT_USER_AGENT;
    this.#fetch = config.fetch ?? globalThis.fetch;
    this.#now = config.now ?? ((): Date => new Date());
    this.#writeScopes = config.writeScopes ? compileWriteScopes(config.writeScopes) : null;
  }

  public lastRateLimit(): GithubRateLimitSnapshot | null {
    return this.#lastRateLimit;
  }

  public async getIssue(
    repo: RepoCoordinate,
    number: IssueNumber,
    options: CallOptions = {},
  ): Promise<Result<GithubIssue, GithubClientError>> {
    const url = `${this.#baseUrl}/repos/${repo.owner.value}/${repo.name.value}/issues/${String(number.value)}`;
    const raw = await this.#request(url, options);
    if (!raw.ok) return raw;
    const parsed = parseIssue(raw.value.body, repo);
    return parsed;
  }

  public async listIssues(
    repo: RepoCoordinate,
    filter: ListIssuesFilter & { readonly costHook?: GithubCostHook } = {},
  ): Promise<Result<readonly GithubIssue[], GithubClientError>> {
    const params = new URLSearchParams();
    if (filter.state) params.set("state", filter.state);
    if (filter.labels && filter.labels.length > 0) {
      params.set("labels", filter.labels.join(","));
    }
    if (filter.since) params.set("since", filter.since.toISOString());
    if (filter.perPage) params.set("per_page", String(filter.perPage));
    const qs = params.toString();
    const url =
      `${this.#baseUrl}/repos/${repo.owner.value}/${repo.name.value}/issues` + (qs ? `?${qs}` : "");
    const opts: CallOptions = {};
    if (filter.bypassCache === true) {
      (opts as { bypassCache: boolean }).bypassCache = true;
    }
    if (filter.costHook !== undefined) {
      (opts as { costHook: GithubCostHook }).costHook = filter.costHook;
    }
    const raw = await this.#request(url, opts);
    if (!raw.ok) return raw;
    return parseIssueArray(raw.value.body, repo);
  }

  public async listIssueComments(
    repo: RepoCoordinate,
    number: IssueNumber,
    options: CallOptions = {},
  ): Promise<Result<readonly GithubComment[], GithubClientError>> {
    const url = `${this.#baseUrl}/repos/${repo.owner.value}/${repo.name.value}/issues/${String(number.value)}/comments`;
    const raw = await this.#request(url, options);
    if (!raw.ok) return raw;
    return parseCommentArray(raw.value.body, number);
  }

  public async listIssueLabels(
    repo: RepoCoordinate,
    number: IssueNumber,
    options: CallOptions = {},
  ): Promise<Result<readonly string[], GithubClientError>> {
    const url = `${this.#baseUrl}/repos/${repo.owner.value}/${repo.name.value}/issues/${String(number.value)}/labels`;
    const raw = await this.#request(url, options);
    if (!raw.ok) return raw;
    if (!Array.isArray(raw.value.body)) {
      return {
        ok: false,
        error: new GithubParseError("expected array of labels"),
      };
    }
    const out: string[] = [];
    for (const item of raw.value.body) {
      if (typeof item === "object" && item !== null && "name" in item) {
        const name = (item as { name?: unknown }).name;
        if (typeof name === "string") out.push(name);
      } else if (typeof item === "string") {
        out.push(item);
      }
    }
    return { ok: true, value: out };
  }

  public async getRef(
    repo: RepoCoordinate,
    branch: string,
    options: CallOptions = {},
  ): Promise<Result<GithubRefHead, GithubClientError>> {
    // GET /repos/{owner}/{repo}/git/refs/heads/{branch}
    // REST response shape:
    //   { ref, node_id, url, object: { sha, type, url } }
    // We want object.sha.
    const url = `${this.#baseUrl}/repos/${repo.owner.value}/${repo.name.value}/git/refs/heads/${encodeURIComponent(branch)}`;
    const raw = await this.#request(url, options);
    if (!raw.ok) return raw;
    const body = raw.value.body;
    if (typeof body !== "object" || body === null) {
      return { ok: false, error: new GithubParseError("getRef: body not an object") };
    }
    const object = (body as { object?: unknown }).object;
    if (typeof object !== "object" || object === null) {
      return { ok: false, error: new GithubParseError("getRef: missing object field") };
    }
    const sha = (object as { sha?: unknown }).sha;
    if (typeof sha !== "string" || sha.length === 0) {
      return { ok: false, error: new GithubParseError("getRef: missing object.sha") };
    }
    return {
      ok: true,
      value: { repo, branch, oid: sha },
    };
  }

  // ---------------------------------------------------------------------
  // Pull-request reads
  // ---------------------------------------------------------------------

  public async getPullRequest(
    repo: RepoCoordinate,
    number: IssueNumber,
    options: CallOptions = {},
  ): Promise<Result<GithubPullRequest, GithubClientError>> {
    const url = `${this.#baseUrl}/repos/${repo.owner.value}/${repo.name.value}/pulls/${String(number.value)}`;
    const raw = await this.#request(url, options);
    if (!raw.ok) return raw;
    return parsePullRequest(raw.value.body, repo);
  }

  public async listPullRequests(
    repo: RepoCoordinate,
    filter: ListPullRequestsFilter & { readonly costHook?: GithubCostHook } = {},
  ): Promise<Result<readonly GithubPullRequest[], GithubClientError>> {
    const params = new URLSearchParams();
    if (filter.state) params.set("state", filter.state);
    if (filter.base !== undefined) params.set("base", filter.base);
    if (filter.head !== undefined) params.set("head", filter.head);
    if (filter.perPage) params.set("per_page", String(filter.perPage));
    const qs = params.toString();
    const url =
      `${this.#baseUrl}/repos/${repo.owner.value}/${repo.name.value}/pulls` + (qs ? `?${qs}` : "");
    const opts: CallOptions = {};
    if (filter.bypassCache === true) {
      (opts as { bypassCache: boolean }).bypassCache = true;
    }
    if (filter.costHook !== undefined) {
      (opts as { costHook: GithubCostHook }).costHook = filter.costHook;
    }
    const raw = await this.#request(url, opts);
    if (!raw.ok) return raw;
    const parsed = parsePullRequestArray(raw.value.body, repo);
    if (!parsed.ok) return parsed;
    // GitHub's listPullRequests doesn't filter by labels server-side
    // (the labels API on PRs is shared with issues); apply a client-side
    // filter when the caller asked for one. Same approach as listIssues.
    if (filter.labels && filter.labels.length > 0) {
      const wanted = filter.labels;
      const filtered = parsed.value.filter((pr) =>
        wanted.every((label) => pr.labels.includes(label)),
      );
      return { ok: true, value: filtered };
    }
    return parsed;
  }

  public async getPullRequestFiles(
    repo: RepoCoordinate,
    number: IssueNumber,
    options: CallOptions = {},
  ): Promise<Result<readonly GithubPullRequestFile[], GithubClientError>> {
    // The default per-page is 30; bump to 100 so a single call covers
    // most PRs without forcing the agent to paginate. Larger PRs still
    // require multi-call pagination — out of scope for v1.
    const url = `${this.#baseUrl}/repos/${repo.owner.value}/${repo.name.value}/pulls/${String(number.value)}/files?per_page=100`;
    const raw = await this.#request(url, options);
    if (!raw.ok) return raw;
    return parsePullRequestFiles(raw.value.body);
  }

  // ---------------------------------------------------------------------
  // Commit / file reads
  // ---------------------------------------------------------------------

  public async getCommit(
    repo: RepoCoordinate,
    ref: string,
    options: CallOptions = {},
  ): Promise<Result<GithubCommit, GithubClientError>> {
    const url = `${this.#baseUrl}/repos/${repo.owner.value}/${repo.name.value}/commits/${encodeURIComponent(ref)}`;
    const raw = await this.#request(url, options);
    if (!raw.ok) return raw;
    return parseCommit(raw.value.body, repo);
  }

  public async getFileAtRef(
    repo: RepoCoordinate,
    path: string,
    ref: string,
    options: CallOptions = {},
  ): Promise<Result<GithubFileContent, GithubClientError>> {
    // GET /repos/{owner}/{repo}/contents/{path}?ref={ref}
    // The path is URL-encoded segment-by-segment so directory separators
    // remain unescaped; the ref goes in the query string.
    const encodedPath = path
      .split("/")
      .map((seg) => encodeURIComponent(seg))
      .join("/");
    const url = `${this.#baseUrl}/repos/${repo.owner.value}/${repo.name.value}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`;
    const raw = await this.#request(url, options);
    if (!raw.ok) return raw;
    return parseFileContent(raw.value.body, repo, ref);
  }

  // ---------------------------------------------------------------------
  // Mutations (ADR-0017)
  // ---------------------------------------------------------------------

  public async createIssueComment(
    repo: RepoCoordinate,
    issueNumber: IssueNumber,
    input: GithubCreateCommentInput,
    options: CallOptions = {},
  ): Promise<Result<GithubCreatedComment, GithubClientError>> {
    const repoKey = repoKeyOf(repo);
    const denial = this.#checkWriteScope("issue-comment", repoKey, null, options);
    if (denial) return denial;

    const url = `${this.#baseUrl}/repos/${repo.owner.value}/${repo.name.value}/issues/${String(issueNumber.value)}/comments`;
    const raw = await this.#requestMutation(url, "POST", { body: input.body }, options);
    if (!raw.ok) return raw;
    const parsed = parseCreatedComment(raw.value.body, repo, issueNumber);
    return parsed;
  }

  public async createIssue(
    repo: RepoCoordinate,
    input: GithubCreateIssueInput,
    options: CallOptions = {},
  ): Promise<Result<GithubCreatedIssue, GithubClientError>> {
    const repoKey = repoKeyOf(repo);
    const denial = this.#checkWriteScope("issue", repoKey, null, options);
    if (denial) return denial;

    const url = `${this.#baseUrl}/repos/${repo.owner.value}/${repo.name.value}/issues`;
    const body: Record<string, unknown> = { title: input.title };
    if (input.body !== undefined) body.body = input.body;
    if (input.labels !== undefined) body.labels = input.labels;
    if (input.assignees !== undefined) body.assignees = input.assignees;
    const raw = await this.#requestMutation(url, "POST", body, options);
    if (!raw.ok) return raw;
    return parseCreatedIssue(raw.value.body, repo);
  }

  public async addLabels(
    repo: RepoCoordinate,
    issueNumber: IssueNumber,
    labels: readonly string[],
    options: CallOptions = {},
  ): Promise<Result<readonly string[], GithubClientError>> {
    const repoKey = repoKeyOf(repo);
    const denial = this.#checkWriteScope("label", repoKey, null, options);
    if (denial) return denial;

    const url = `${this.#baseUrl}/repos/${repo.owner.value}/${repo.name.value}/issues/${String(issueNumber.value)}/labels`;
    const raw = await this.#requestMutation(url, "POST", { labels: [...labels] }, options);
    if (!raw.ok) return raw;
    const body = raw.value.body;
    if (!Array.isArray(body)) return { ok: true, value: [] };
    return {
      ok: true,
      value: (body as { name?: string }[]).map((l) => l.name ?? "").filter(Boolean),
    };
  }

  public async removeLabel(
    repo: RepoCoordinate,
    issueNumber: IssueNumber,
    label: string,
    options: CallOptions = {},
  ): Promise<Result<void, GithubClientError>> {
    const repoKey = repoKeyOf(repo);
    const denial = this.#checkWriteScope("label", repoKey, null, options);
    if (denial) return denial;

    const url = `${this.#baseUrl}/repos/${repo.owner.value}/${repo.name.value}/issues/${String(issueNumber.value)}/labels/${encodeURIComponent(label)}`;
    const raw = await this.#requestMutation(url, "DELETE", undefined, options);
    if (!raw.ok) return raw;
    return { ok: true, value: undefined };
  }

  public async updateIssueState(
    repo: RepoCoordinate,
    issueNumber: IssueNumber,
    state: "open" | "closed",
    options: CallOptions = {},
  ): Promise<Result<void, GithubClientError>> {
    const repoKey = repoKeyOf(repo);
    const denial = this.#checkWriteScope("issue", repoKey, null, options);
    if (denial) return denial;

    const url = `${this.#baseUrl}/repos/${repo.owner.value}/${repo.name.value}/issues/${String(issueNumber.value)}`;
    const raw = await this.#requestMutation(url, "PATCH", { state }, options);
    if (!raw.ok) return raw;
    return { ok: true, value: undefined };
  }

  public async createCommitOnBranch(
    repo: RepoCoordinate,
    branch: string,
    message: GithubCommitMessage,
    fileChanges: GithubFileChanges,
    expectedHeadOid: string,
    options: CallOptions = {},
  ): Promise<Result<GithubCreatedCommit, GithubClientError>> {
    const repoKey = repoKeyOf(repo);

    // Every path (additions AND deletions) must match a configured
    // glob for this repo. Partial commits are worse than refused
    // commits — first offender fails the whole call. ADR-0017 §9.
    const allPaths: string[] = [
      ...(fileChanges.additions?.map((a) => a.path) ?? []),
      ...(fileChanges.deletions?.map((d) => d.path) ?? []),
    ];
    if (allPaths.length === 0) {
      // Commit with no changes — still must be scope-gated against
      // the repo at minimum; no path to check.
      const denial = this.#checkWriteScope("branch-commit", repoKey, null, options);
      if (denial) return denial;
    } else {
      for (const path of allPaths) {
        const denial = this.#checkWriteScope("branch-commit", repoKey, path, options);
        if (denial) return denial;
      }
    }

    const additions = (fileChanges.additions ?? []).map((a) => ({
      path: a.path,
      contents: base64EncodeUtf8(a.contents),
    }));
    const deletions = (fileChanges.deletions ?? []).map((d) => ({ path: d.path }));

    const variables = {
      input: {
        branch: {
          repositoryNameWithOwner: repoKey,
          branchName: branch,
        },
        expectedHeadOid,
        fileChanges: { additions, deletions },
        message:
          message.body !== undefined
            ? { headline: message.headline, body: message.body }
            : { headline: message.headline },
      },
    };

    const url = `${this.#baseUrl}/graphql`;
    const raw = await this.#requestGraphql(url, CREATE_COMMIT_ON_BRANCH_QUERY, variables, {
      expectedHeadOid,
      options,
    });
    if (!raw.ok) return raw;

    const commit = extractCreatedCommit(raw.value.body);
    if (!commit.ok) return commit;
    return {
      ok: true,
      value: {
        oid: commit.value.oid,
        url: commit.value.url,
        repo,
        branch,
      },
    };
  }

  // ---------------------------------------------------------------------
  // Write-scope check (§9 — single site, pre-I/O)
  // ---------------------------------------------------------------------

  #checkWriteScope(
    kind: GithubWriteScopeKind,
    repoKey: string,
    path: string | null,
    options: CallOptions,
  ): { ok: false; error: GithubWriteScopeError } | null {
    const scopes = this.#writeScopes;
    const fire = (err: GithubWriteScopeError): { ok: false; error: GithubWriteScopeError } => {
      // Per §8: scope denials fire the cost hook exactly once for
      // audit trail bookkeeping. No rate-limit info — denial never
      // touched the network.
      const hook = options.costHook ?? this.#defaultCostHook;
      hook?.onGithubCall({
        transport: kind === "branch-commit" ? "graphql" : "rest",
        cacheHit: false,
      });
      return { ok: false, error: err };
    };

    if (scopes === null) {
      return fire(
        new GithubWriteScopeError("no write scopes configured", {
          attemptedRepo: repoKey,
          attemptedPath: path,
          scopeKind: kind,
        }),
      );
    }

    if (kind === "issue-comment") {
      if (!scopes.issueComments.has(repoKey)) {
        return fire(
          new GithubWriteScopeError(`issue-comment denied for ${repoKey}`, {
            attemptedRepo: repoKey,
            scopeKind: kind,
          }),
        );
      }
      return null;
    }
    if (kind === "issue") {
      if (!scopes.issues.has(repoKey)) {
        return fire(
          new GithubWriteScopeError(`issue denied for ${repoKey}`, {
            attemptedRepo: repoKey,
            scopeKind: kind,
          }),
        );
      }
      return null;
    }
    if (kind === "branch-commit") {
      const patterns = scopes.branchCommits.get(repoKey);
      if (!patterns) {
        return fire(
          new GithubWriteScopeError(`branch-commit denied for ${repoKey}`, {
            attemptedRepo: repoKey,
            attemptedPath: path,
            scopeKind: kind,
          }),
        );
      }
      if (path !== null && !matchesRepoPath(patterns, path)) {
        return fire(
          new GithubWriteScopeError(`branch-commit denied for ${repoKey} path "${path}"`, {
            attemptedRepo: repoKey,
            attemptedPath: path,
            scopeKind: kind,
          }),
        );
      }
      return null;
    }
    if (!scopes.labels.has(repoKey)) {
      return fire(
        new GithubWriteScopeError(`label denied for ${repoKey}`, {
          attemptedRepo: repoKey,
          scopeKind: kind,
        }),
      );
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Mutation request pipeline (§6 — never retries)
  // ---------------------------------------------------------------------

  async #requestMutation(
    url: string,
    method: "POST" | "PATCH" | "DELETE",
    body: Record<string, unknown> | undefined,
    options: CallOptions,
  ): Promise<Result<RawResponse, GithubClientError>> {
    const costHook = options.costHook ?? this.#defaultCostHook;

    if (options.signal?.aborted === true) {
      costHook?.onGithubCall({ transport: "rest", cacheHit: false });
      return {
        ok: false,
        error: new GithubMutationAbortedError("mutation aborted before send", {
          phase: "before-send",
          requestUrl: url,
        }),
      };
    }

    let res: Response;
    try {
      res = await this.#fetch(url, {
        method,
        headers: this.#buildMutationHeaders(),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (cause) {
      costHook?.onGithubCall({ transport: "rest", cacheHit: false });
      if (isAbortError(cause)) {
        return {
          ok: false,
          error: new GithubMutationAbortedError("mutation aborted in flight", {
            phase: "in-flight",
            requestUrl: url,
          }),
        };
      }
      return {
        ok: false,
        error: new GithubTransportError("mutation transport failure", {
          requestUrl: url,
          attempts: MUTATION_RETRY_POLICY.maxAttempts,
          cause: scrubCause(cause, this.#token),
        }),
      };
    }

    const snapshot = parseRateLimitHeaders(res.headers, this.#now());
    if (snapshot) this.#lastRateLimit = snapshot;

    costHook?.onGithubCall({
      transport: "rest",
      cacheHit: false,
      ...(snapshot ? { rateLimitRemaining: snapshot.remaining } : {}),
    });

    if (res.status >= 200 && res.status < 300) {
      const parsed = await safeParseJson(res);
      if (!parsed.ok) return parsed;
      return {
        ok: true,
        value: {
          status: res.status,
          headers: res.headers,
          body: parsed.value,
          etag: null,
          rateLimit: snapshot,
        },
      };
    }

    // 5xx on a mutation — single attempt, no retry.
    if (res.status >= 500) {
      return {
        ok: false,
        error: new GithubTransportError(`server error ${String(res.status)}`, {
          requestUrl: url,
          attempts: MUTATION_RETRY_POLICY.maxAttempts,
        }),
      };
    }
    return { ok: false, error: this.#mapHttpError(res, snapshot, url) };
  }

  // ---------------------------------------------------------------------
  // GraphQL transport (§7)
  // ---------------------------------------------------------------------

  async #requestGraphql(
    url: string,
    query: string,
    variables: Record<string, unknown>,
    ctx: { readonly expectedHeadOid: string; readonly options: CallOptions },
  ): Promise<Result<RawResponse, GithubClientError>> {
    const { options } = ctx;
    const costHook = options.costHook ?? this.#defaultCostHook;

    if (options.signal?.aborted === true) {
      costHook?.onGithubCall({ transport: "graphql", cacheHit: false });
      return {
        ok: false,
        error: new GithubMutationAbortedError("mutation aborted before send", {
          phase: "before-send",
          requestUrl: url,
        }),
      };
    }

    let res: Response;
    try {
      res = await this.#fetch(url, {
        method: "POST",
        headers: this.#buildMutationHeaders(),
        body: JSON.stringify({ query, variables }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (cause) {
      costHook?.onGithubCall({ transport: "graphql", cacheHit: false });
      if (isAbortError(cause)) {
        return {
          ok: false,
          error: new GithubMutationAbortedError("mutation aborted in flight", {
            phase: "in-flight",
            requestUrl: url,
          }),
        };
      }
      return {
        ok: false,
        error: new GithubTransportError("graphql transport failure", {
          requestUrl: url,
          attempts: MUTATION_RETRY_POLICY.maxAttempts,
          cause: scrubCause(cause, this.#token),
        }),
      };
    }

    const snapshot = parseRateLimitHeaders(res.headers, this.#now());
    if (snapshot) this.#lastRateLimit = snapshot;
    costHook?.onGithubCall({
      transport: "graphql",
      cacheHit: false,
      ...(snapshot ? { rateLimitRemaining: snapshot.remaining } : {}),
    });

    // GraphQL: 200 OK may still contain errors in the body.
    if (res.status >= 200 && res.status < 300) {
      const parsed = await safeParseJson(res);
      if (!parsed.ok) return parsed;

      const mapped = mapGraphqlErrors(parsed.value, url, ctx.expectedHeadOid);
      if (mapped) return { ok: false, error: mapped };

      return {
        ok: true,
        value: {
          status: res.status,
          headers: res.headers,
          body: parsed.value,
          etag: null,
          rateLimit: snapshot,
        },
      };
    }

    if (res.status >= 500) {
      return {
        ok: false,
        error: new GithubTransportError(`graphql server error ${String(res.status)}`, {
          requestUrl: url,
          attempts: MUTATION_RETRY_POLICY.maxAttempts,
        }),
      };
    }
    return { ok: false, error: this.#mapHttpError(res, snapshot, url) };
  }

  #buildMutationHeaders(): Headers {
    // Route through #buildHeaders(null) so the SecretValue reveal()
    // invariant (one call site in this class) holds. Mutations add
    // Content-Type; If-None-Match is irrelevant for POSTs.
    const headers = this.#buildHeaders(null);
    headers.set("Content-Type", "application/json");
    return headers;
  }

  // ---------------------------------------------------------------------
  // Core request pipeline
  // ---------------------------------------------------------------------

  async #request(
    url: string,
    options: CallOptions,
  ): Promise<Result<RawResponse, GithubClientError>> {
    const costHook = options.costHook ?? this.#defaultCostHook;
    const bypassCache = options.bypassCache === true;
    const cached = bypassCache ? null : this.#cache.get(url);

    let attempt = 0;
    let lastCause: unknown = null;
    while (attempt < this.#retryPolicy.maxAttempts) {
      attempt++;
      try {
        const res = await this.#fetch(url, {
          method: "GET",
          headers: this.#buildHeaders(cached?.etag ?? null),
          ...(options.signal ? { signal: options.signal } : {}),
        });
        const snapshot = parseRateLimitHeaders(res.headers, this.#now());
        if (snapshot) this.#lastRateLimit = snapshot;

        // Cache hit via 304.
        if (res.status === 304 && cached) {
          costHook?.onGithubCall({
            transport: "rest",
            cacheHit: true,
            ...(snapshot ? { rateLimitRemaining: snapshot.remaining } : {}),
          });
          return {
            ok: true,
            value: {
              status: 200,
              headers: res.headers,
              body: cached.body,
              etag: cached.etag,
              rateLimit: snapshot,
            },
          };
        }

        if (res.status >= 200 && res.status < 300) {
          const body = await safeParseJson(res);
          if (!body.ok) return body;
          const etag = res.headers.get("etag");
          if (etag && !bypassCache) {
            const entry: GithubCacheEntry = {
              etag,
              body: body.value,
              fetchedAt: this.#now(),
              url,
            };
            this.#cache.set(url, entry);
          }
          costHook?.onGithubCall({
            transport: "rest",
            cacheHit: false,
            ...(snapshot ? { rateLimitRemaining: snapshot.remaining } : {}),
          });
          return {
            ok: true,
            value: {
              status: res.status,
              headers: res.headers,
              body: body.value,
              etag,
              rateLimit: snapshot,
            },
          };
        }

        // Error paths.
        if (
          this.#retryPolicy.retryableStatuses.includes(res.status) &&
          attempt < this.#retryPolicy.maxAttempts
        ) {
          await this.#sleep(this.#computeDelay(attempt));
          continue;
        }

        costHook?.onGithubCall({
          transport: "rest",
          cacheHit: false,
          ...(snapshot ? { rateLimitRemaining: snapshot.remaining } : {}),
        });
        return { ok: false, error: this.#mapHttpError(res, snapshot, url) };
      } catch (cause) {
        if (isAbortError(cause)) {
          // Abort bubbles as a rejection per the rejection contract.
          throw cause;
        }
        lastCause = cause;
        if (attempt < this.#retryPolicy.maxAttempts) {
          await this.#sleep(this.#computeDelay(attempt));
          continue;
        }
      }
    }

    costHook?.onGithubCall({ transport: "rest", cacheHit: false });
    return {
      ok: false,
      error: new GithubTransportError(`github request failed after ${String(attempt)} attempts`, {
        requestUrl: url,
        attempts: attempt,
        cause: scrubCause(lastCause, this.#token),
      }),
    };
  }

  #buildHeaders(etag: string | null): Headers {
    const headers = new Headers({
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": this.#userAgent,
      // The ONLY place reveal() is called in this package.
      Authorization: `token ${this.#token.reveal()}`,
    });
    if (etag !== null) headers.set("If-None-Match", etag);
    return headers;
  }

  #computeDelay(attempt: number): number {
    const base = this.#retryPolicy.baseDelayMs * 2 ** (attempt - 1);
    return Math.min(this.#retryPolicy.maxDelayMs, base);
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  #mapHttpError(
    res: Response,
    snapshot: GithubRateLimitSnapshot | null,
    url: string,
  ): GithubClientError {
    const status = res.status;
    if (status === 404) return new GithubNotFoundError("not found", { requestUrl: url });
    if (status === 401) return new GithubUnauthorizedError("unauthorized", { requestUrl: url });
    if (status === 403) {
      // Distinguish rate-limit 403 from plain forbidden.
      if (snapshot?.remaining === 0) {
        return new GithubRateLimitError("rate limited", {
          status,
          requestUrl: url,
          snapshot,
          retryAfterSeconds: parseRetryAfter(res.headers),
        });
      }
      return new GithubForbiddenError("forbidden", { requestUrl: url });
    }
    if (status === 429) {
      return new GithubRateLimitError("rate limited (429)", {
        status,
        requestUrl: url,
        snapshot,
        retryAfterSeconds: parseRetryAfter(res.headers),
      });
    }
    if (status === 422) {
      return new GithubValidationError("validation failed", {
        requestUrl: url,
        issues: [],
      });
    }
    if (status >= 500) {
      return new GithubTransportError(`server error ${String(status)}`, {
        requestUrl: url,
        attempts: 1,
      });
    }
    return new GithubInternalError(`unexpected status ${String(status)}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const safeParseJson = async (res: Response): Promise<Result<unknown, GithubParseError>> => {
  try {
    const body: unknown = await res.json();
    return { ok: true, value: body };
  } catch (cause) {
    return {
      ok: false,
      error: new GithubParseError("failed to decode JSON body", { cause }),
    };
  }
};

const parseRateLimitHeaders = (
  headers: Headers,
  observedAt: Date,
): GithubRateLimitSnapshot | null => {
  const limit = headers.get("x-ratelimit-limit");
  const remaining = headers.get("x-ratelimit-remaining");
  const reset = headers.get("x-ratelimit-reset");
  if (limit === null || remaining === null || reset === null) return null;
  const limitNum = Number(limit);
  const remainingNum = Number(remaining);
  const resetNum = Number(reset);
  if (!Number.isFinite(limitNum) || !Number.isFinite(remainingNum) || !Number.isFinite(resetNum)) {
    return null;
  }
  const resourceHeader = headers.get("x-ratelimit-resource");
  const resource: GithubRateLimitSnapshot["resource"] =
    resourceHeader === "core" || resourceHeader === "search" || resourceHeader === "graphql"
      ? resourceHeader
      : "unknown";
  return {
    limit: limitNum,
    remaining: remainingNum,
    resetAt: new Date(resetNum * 1000),
    observedAt,
    resource,
  };
};

const parseRetryAfter = (headers: Headers): number | null => {
  const v = headers.get("retry-after");
  if (v === null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
};

const isAbortError = (err: unknown): boolean => {
  if (typeof err !== "object" || err === null) return false;
  return (err as { name?: unknown }).name === "AbortError";
};

const repoKeyOf = (repo: RepoCoordinate): string => `${repo.owner.value}/${repo.name.value}`;

const base64EncodeUtf8 = (contents: string): string => {
  // Node and modern runtimes both expose Buffer via node: builtin, but
  // harness code targets pure ESM + Node. Use Buffer here — it's the
  // only reliable UTF-8 → base64 path in Node without a polyfill.
  return Buffer.from(contents, "utf8").toString("base64");
};

const CREATE_COMMIT_ON_BRANCH_QUERY = `mutation CreateCommitOnBranch($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) {
    commit {
      oid
      url
    }
  }
}`;

// ---------------------------------------------------------------------------
// GraphQL error mapping (§7) and response parsing
// ---------------------------------------------------------------------------

interface GraphqlErrorEntry {
  readonly type?: string;
  readonly message?: string;
}

/**
 * Return a `GithubClientError` if the body contains GraphQL errors;
 * otherwise return `null` (happy path).
 */
const mapGraphqlErrors = (
  body: unknown,
  requestUrl: string,
  expectedHeadOid: string,
): GithubClientError | null => {
  if (typeof body !== "object" || body === null) return null;
  const errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors) || errors.length === 0) return null;

  const first = errors[0] as GraphqlErrorEntry;
  const type = typeof first.type === "string" ? first.type : "";
  const message = typeof first.message === "string" ? first.message : "graphql error";

  // Stale HEAD detection — GitHub returns a plain error (no `type`)
  // with a distinctive message body. Check first so a stale-HEAD
  // failure doesn't get swallowed as a generic "INVALID".
  if (/not a fast-forward|expected .*head .*didn.?t match|does not match expected/i.test(message)) {
    return new GithubConflictError(message, { requestUrl, expectedHeadOid });
  }

  switch (type) {
    case "FORBIDDEN":
      return new GithubForbiddenError(message, { requestUrl });
    case "NOT_FOUND":
      return new GithubNotFoundError(message, { requestUrl });
    case "UNPROCESSABLE":
    case "INVALID":
      return new GithubValidationError(message, { requestUrl, issues: [] });
    case "RATE_LIMITED":
      return new GithubRateLimitError(message, {
        status: 403,
        requestUrl,
        snapshot: null,
        retryAfterSeconds: null,
      });
    default:
      return new GithubInternalError(`graphql error: ${message}`);
  }
};

interface ExtractedCommit {
  readonly oid: string;
  readonly url: string;
}

const extractCreatedCommit = (body: unknown): Result<ExtractedCommit, GithubParseError> => {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: new GithubParseError("graphql: not an object") };
  }
  const data = (body as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) {
    return { ok: false, error: new GithubParseError("graphql: missing data") };
  }
  const mutation = (data as { createCommitOnBranch?: unknown }).createCommitOnBranch;
  if (typeof mutation !== "object" || mutation === null) {
    return { ok: false, error: new GithubParseError("graphql: missing createCommitOnBranch") };
  }
  const commit = (mutation as { commit?: unknown }).commit;
  if (typeof commit !== "object" || commit === null) {
    return { ok: false, error: new GithubParseError("graphql: missing commit") };
  }
  const oid = (commit as { oid?: unknown }).oid;
  const url = (commit as { url?: unknown }).url;
  if (typeof oid !== "string" || typeof url !== "string") {
    return { ok: false, error: new GithubParseError("graphql: malformed commit fields") };
  }
  return { ok: true, value: { oid, url } };
};

// ---------------------------------------------------------------------------
// REST mutation response parsers
// ---------------------------------------------------------------------------

const parseCreatedComment = (
  body: unknown,
  repo: RepoCoordinate,
  issueNumber: IssueNumber,
): Result<GithubCreatedComment, GithubParseError> => {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: new GithubParseError("createIssueComment: not an object") };
  }
  const b = body as Record<string, unknown>;
  if (
    typeof b.id !== "number" ||
    typeof b.body !== "string" ||
    typeof b.created_at !== "string" ||
    typeof b.html_url !== "string"
  ) {
    return { ok: false, error: new GithubParseError("createIssueComment: missing fields") };
  }
  return {
    ok: true,
    value: {
      id: b.id,
      issueNumber,
      repo,
      body: b.body,
      createdAt: new Date(b.created_at),
      htmlUrl: b.html_url,
    },
  };
};

const parseCreatedIssue = (
  body: unknown,
  repo: RepoCoordinate,
): Result<GithubCreatedIssue, GithubParseError> => {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: new GithubParseError("createIssue: not an object") };
  }
  const b = body as Record<string, unknown>;
  if (
    typeof b.number !== "number" ||
    typeof b.title !== "string" ||
    typeof b.html_url !== "string" ||
    typeof b.created_at !== "string"
  ) {
    return { ok: false, error: new GithubParseError("createIssue: missing fields") };
  }
  let number: IssueNumber;
  try {
    number = makeIssueNumber(b.number);
  } catch {
    return { ok: false, error: new GithubParseError("createIssue: invalid issue number") };
  }
  return {
    ok: true,
    value: {
      number,
      repo,
      title: b.title,
      htmlUrl: b.html_url,
      createdAt: new Date(b.created_at),
    },
  };
};

/**
 * Best-effort scrub of the raw token from a cause's message. Primary
 * defense is that the token never enters any error path we construct;
 * this is belt-and-suspenders for malformed fetch implementations that
 * somehow end up with the header in their error message.
 */
const scrubCause = (cause: unknown, token: SecretValue): unknown => {
  if (typeof cause !== "object" || cause === null) return cause;
  const raw = token.reveal();
  // The only reveal() outside of #buildHeaders is here, and it never
  // leaves this scope — used only for a string-replace comparison.
  const message = (cause as { message?: unknown }).message;
  if (typeof message === "string" && raw.length >= 8 && message.includes(raw)) {
    return {
      ...cause,
      message: message.split(raw).join("[REDACTED:token]"),
      name: (cause as { name?: unknown }).name,
    };
  }
  return cause;
};
