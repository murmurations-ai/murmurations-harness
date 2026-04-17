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
    const issueNumber = Number(ref.id);
    const result = await this.#client.createIssueComment(this.#repo, issueNumber, { body });
    if (!result.ok) return { ok: false, error: this.#mapError(result.error) };
    return {
      ok: true,
      value: { id: result.value!.htmlUrl, url: result.value!.htmlUrl },
    };
  }

  async updateItemState(ref: ItemRef, state: ItemState): Promise<CollabResult<void>> {
    const issueNumber = Number(ref.id);
    const result = await this.#client.updateIssueState(this.#repo, issueNumber, state);
    if (!result.ok) return { ok: false, error: this.#mapError(result.error) };
    return { ok: true, value: undefined };
  }

  async addLabels(ref: ItemRef, labels: readonly string[]): Promise<CollabResult<void>> {
    const issueNumber = Number(ref.id);
    const result = await this.#client.addLabels(this.#repo, issueNumber, [...labels]);
    if (!result.ok) return { ok: false, error: this.#mapError(result.error) };
    return { ok: true, value: undefined };
  }

  async removeLabel(ref: ItemRef, label: string): Promise<CollabResult<void>> {
    const issueNumber = Number(ref.id);
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

  #mapError(err?: { code: string; message: string }): CollaborationError {
    if (!err) return new CollaborationError("github", "UNKNOWN", "Unknown error");
    const code = err.code;
    if (code === "UNAUTHORIZED" || code === "FORBIDDEN" || code === "WRITE_SCOPE") {
      return new CollaborationError("github", "PERMISSION_DENIED", err.message);
    }
    if (code === "NOT_FOUND") {
      return new CollaborationError("github", "NOT_FOUND", err.message);
    }
    if (code === "VALIDATION") {
      return new CollaborationError("github", "INVALID_INPUT", err.message);
    }
    if (code === "RATE_LIMIT") {
      return new CollaborationError("github", "RATE_LIMITED", err.message);
    }
    if (code === "TRANSPORT") {
      return new CollaborationError("github", "TRANSPORT", err.message);
    }
    return new CollaborationError("github", "UNKNOWN", err.message);
  }
}
