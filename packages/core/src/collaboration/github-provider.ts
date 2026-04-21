/**
 * GitHubCollaborationProvider — wraps @murmurations-ai/github behind
 * the CollaborationProvider interface (ADR-0021 §2).
 *
 * This is a thin adapter, not a reimplementation. The existing GitHub
 * client handles auth, caching, write-scope enforcement, and retries.
 * This provider maps our domain types to/from the GitHub client's types.
 */

import type { Signal } from "../execution/index.js";
import type {
  CollaborationProvider,
  CollaborationItem,
  ItemRef,
  ItemFilter,
  ItemState,
  CommentRef,
  ArtifactRef,
  CollabResult,
} from "./types.js";
import { CollaborationError } from "./types.js";

// ---------------------------------------------------------------------------
// GitHub client structural types (no import from @murmurations-ai/github
// to avoid circular deps — we use structural typing like the runner does)
// ---------------------------------------------------------------------------

/**
 * Wrap a raw numeric issue id into the `IssueNumber` brand shape the
 * @murmurations-ai/github client expects (`{ kind, value }`). The
 * structural interface above declares `issueNumber: unknown`, so
 * TypeScript can't catch the mistake of passing a plain number — the
 * client's URL template then interpolates `undefined` when it reads
 * `.value` off a primitive.
 *
 * Root cause of the "GitHub returned 'not found'" on :directive
 * close/delete in v0.5.0 tester validation — every mutation routed
 * through this provider was PATCHing `/issues/undefined`.
 */
const toIssueNumber = (id: string): { kind: "issue-number"; value: number } => ({
  kind: "issue-number",
  value: Number(id),
});

/** Minimal structural interface for the GitHub client we wrap. */
export interface GitHubClientLike {
  createIssue(
    repo: unknown,
    input: { title: string; body: string; labels?: string[] },
  ): Promise<{
    ok: boolean;
    value?: { number: { value: number }; htmlUrl: string };
    error?: { code: string; message: string };
  }>;

  listIssues(
    repo: unknown,
    filter?: {
      state?: "open" | "closed" | "all";
      labels?: readonly string[];
      since?: Date;
      perPage?: number;
    },
  ): Promise<{
    ok: boolean;
    value?: readonly {
      number: { value: number };
      title: string;
      body: string | null;
      state: "open" | "closed";
      labels: readonly string[];
      htmlUrl: string;
      createdAt: Date;
      updatedAt: Date;
    }[];
    error?: { code: string; message: string };
  }>;

  createIssueComment(
    repo: unknown,
    issueNumber: unknown,
    input: { body: string },
  ): Promise<{
    ok: boolean;
    value?: { htmlUrl: string };
    error?: { code: string; message: string };
  }>;

  updateIssueState(
    repo: unknown,
    issueNumber: unknown,
    state: string,
  ): Promise<{ ok: boolean; error?: { code: string; message: string } }>;

  addLabels(
    repo: unknown,
    issueNumber: unknown,
    labels: string[],
  ): Promise<{ ok: boolean; error?: { code: string; message: string } }>;

  removeLabel(
    repo: unknown,
    issueNumber: unknown,
    label: string,
  ): Promise<{ ok: boolean; error?: { code: string; message: string } }>;

  getRef(
    repo: unknown,
    branch: string,
  ): Promise<{ ok: boolean; value?: { oid: string }; error?: { code: string; message: string } }>;

  createCommitOnBranch(
    repo: unknown,
    branch: string,
    message: { headline: string; body?: string },
    fileChanges: { additions?: { path: string; contents: string }[] },
    expectedHeadOid: string,
  ): Promise<{
    ok: boolean;
    value?: { oid: string; url: string };
    error?: { code: string; message: string };
  }>;
}

/** Options for constructing a GitHubCollaborationProvider. */
export interface GitHubProviderOptions {
  readonly client: GitHubClientLike;
  /** The repo coordinate (from makeRepoCoordinate). */
  readonly repo: unknown;
  /** Branch for artifact commits. Default: "main". */
  readonly branch?: string;
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

export class GitHubCollaborationProvider implements CollaborationProvider {
  readonly id = "github";
  readonly displayName = "GitHub";

  readonly #client: GitHubClientLike;
  readonly #repo: unknown;
  readonly #branch: string;

  constructor(options: GitHubProviderOptions) {
    this.#client = options.client;
    this.#repo = options.repo;
    this.#branch = options.branch ?? "main";
  }

  async createItem(input: {
    readonly title: string;
    readonly body: string;
    readonly labels?: readonly string[];
  }): Promise<CollabResult<ItemRef>> {
    const issueInput: { title: string; body: string; labels?: string[] } = {
      title: input.title,
      body: input.body,
    };
    if (input.labels) issueInput.labels = [...input.labels];
    const result = await this.#client.createIssue(this.#repo, issueInput);
    if (!result.ok) return { ok: false, error: this.#mapError(result.error) };
    return {
      ok: true,
      value: {
        id: String(result.value!.number.value),
        url: result.value!.htmlUrl,
      },
    };
  }

  async listItems(filter?: ItemFilter): Promise<CollabResult<readonly CollaborationItem[]>> {
    const listFilter: {
      state?: "open" | "closed" | "all";
      labels?: readonly string[];
      since?: Date;
      perPage?: number;
    } = {
      state: filter?.state === "all" ? "all" : (filter?.state ?? "open"),
      perPage: filter?.limit ?? 30,
    };
    if (filter?.labels) listFilter.labels = filter.labels;
    if (filter?.since) listFilter.since = filter.since;
    const result = await this.#client.listIssues(this.#repo, listFilter);
    if (!result.ok) return { ok: false, error: this.#mapError(result.error) };
    return {
      ok: true,
      value: result.value!.map((issue) => ({
        ref: { id: String(issue.number.value), url: issue.htmlUrl },
        title: issue.title,
        body: issue.body ?? "",
        state: issue.state,
        labels: issue.labels,
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
      })),
    };
  }

  async postComment(ref: ItemRef, body: string): Promise<CollabResult<CommentRef>> {
    const issueNumber = toIssueNumber(ref.id);
    const result = await this.#client.createIssueComment(this.#repo, issueNumber, { body });
    if (!result.ok) return { ok: false, error: this.#mapError(result.error) };
    return {
      ok: true,
      value: { id: result.value!.htmlUrl, url: result.value!.htmlUrl },
    };
  }

  async updateItemState(ref: ItemRef, state: ItemState): Promise<CollabResult<void>> {
    const issueNumber = toIssueNumber(ref.id);
    const result = await this.#client.updateIssueState(this.#repo, issueNumber, state);
    if (!result.ok) return { ok: false, error: this.#mapError(result.error) };
    return { ok: true, value: undefined };
  }

  async addLabels(ref: ItemRef, labels: readonly string[]): Promise<CollabResult<void>> {
    const issueNumber = toIssueNumber(ref.id);
    const result = await this.#client.addLabels(this.#repo, issueNumber, [...labels]);
    if (!result.ok) return { ok: false, error: this.#mapError(result.error) };
    return { ok: true, value: undefined };
  }

  async removeLabel(ref: ItemRef, label: string): Promise<CollabResult<void>> {
    const issueNumber = toIssueNumber(ref.id);
    const result = await this.#client.removeLabel(this.#repo, issueNumber, label);
    if (!result.ok) return { ok: false, error: this.#mapError(result.error) };
    return { ok: true, value: undefined };
  }

  async commitArtifact(input: {
    readonly path: string;
    readonly content: string;
    readonly message: string;
  }): Promise<CollabResult<ArtifactRef>> {
    // Get HEAD ref
    const headResult = await this.#client.getRef(this.#repo, this.#branch);
    if (!headResult.ok) return { ok: false, error: this.#mapError(headResult.error) };

    const commitResult = await this.#client.createCommitOnBranch(
      this.#repo,
      this.#branch,
      { headline: input.message },
      { additions: [{ path: input.path, contents: input.content }] },
      headResult.value!.oid,
    );
    if (!commitResult.ok) return { ok: false, error: this.#mapError(commitResult.error) };

    return {
      ok: true,
      value: {
        id: commitResult.value!.oid,
        url: commitResult.value!.url,
        path: input.path,
      },
    };
  }

  async collectSignals(filter?: ItemFilter): Promise<readonly Signal[]> {
    const result = await this.listItems(filter);
    if (!result.ok) return [];

    const now = new Date();
    return result.value.map((item) => ({
      kind: "github-issue" as const,
      id: `gh-issue-${item.ref.id}`,
      trust: "semi-trusted" as const,
      fetchedAt: now,
      number: Number(item.ref.id),
      title: item.title,
      labels: [...item.labels],
      url: item.ref.url ?? "",
      excerpt: item.body.slice(0, 500),
    }));
  }

  // -------------------------------------------------------------------------
  // Error mapping
  // -------------------------------------------------------------------------

  /**
   * Map a GitHub client error to a CollaborationError.
   *
   * The GitHub client (`@murmurations-ai/github`) emits hyphen-case codes
   * (`"not-found"`, `"unauthorized"`, `"write-scope-denied"`). Earlier
   * versions of this adapter checked for upper-case + underscore codes
   * (`"UNAUTHORIZED"`, `"NOT_FOUND"`), so every real error fell through
   * to `"UNKNOWN"` and operators saw `create-issue: UNKNOWN` with no
   * useful signal. v0.5.0 Milestone 1 — error legibility.
   *
   * Also tolerates upper-case + underscore codes for forward compat with
   * any callers that hand-roll error objects.
   */
  #mapError(err?: { code: string; message: string }): CollaborationError {
    if (!err) return new CollaborationError("github", "UNKNOWN", "Unknown error");
    const code = err.code;
    // Hyphen-case (GithubClientErrorCode, actual shape emitted by the client)
    if (
      code === "unauthorized" ||
      code === "forbidden" ||
      code === "write-scope-denied" ||
      code === "UNAUTHORIZED" ||
      code === "FORBIDDEN" ||
      code === "WRITE_SCOPE"
    ) {
      return new CollaborationError("github", "PERMISSION_DENIED", err.message);
    }
    if (code === "not-found" || code === "NOT_FOUND") {
      return new CollaborationError("github", "NOT_FOUND", err.message);
    }
    if (code === "validation" || code === "conflict" || code === "VALIDATION") {
      return new CollaborationError("github", "INVALID_INPUT", err.message);
    }
    if (code === "rate-limited" || code === "RATE_LIMIT") {
      return new CollaborationError("github", "RATE_LIMITED", err.message);
    }
    if (
      code === "transport" ||
      code === "parse" ||
      code === "aborted" ||
      code === "mutation-aborted" ||
      code === "TRANSPORT"
    ) {
      return new CollaborationError("github", "TRANSPORT", err.message);
    }
    // internal / unknown upstream — preserve the real message so the
    // operator can act on it even without a named code.
    return new CollaborationError("github", "UNKNOWN", err.message);
  }
}
