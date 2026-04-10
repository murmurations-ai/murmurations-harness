/**
 * Error taxonomy for the GitHub client. Follows the same pattern as
 * `ExecutorError` and `SecretsProviderError` — abstract base with a
 * stable `code` discriminant, subclasses preserved via
 * `new.target.name`, errors-as-values for expected failure modes
 * (ADR-0005).
 *
 * CRITICAL: no error constructor ever receives the raw auth token.
 * The client scrubs `cause.message` before wrapping transport errors.
 */

export type GithubClientErrorCode =
  | "not-found"
  | "unauthorized"
  | "forbidden"
  | "rate-limited"
  | "validation"
  | "transport"
  | "parse"
  | "aborted"
  | "internal"
  | "write-scope-denied"
  | "conflict"
  | "mutation-aborted";

export type GithubWriteScopeKind = "issue-comment" | "branch-commit" | "issue" | "label";

export interface GithubRateLimitSnapshot {
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: Date;
  readonly observedAt: Date;
  readonly resource: "core" | "search" | "graphql" | "unknown";
}

export abstract class GithubClientError extends Error {
  public abstract readonly code: GithubClientErrorCode;
  public readonly status: number | undefined;
  public readonly requestUrl: string | undefined;
  public override readonly cause: unknown;
  protected constructor(
    message: string,
    options: {
      readonly status?: number;
      readonly requestUrl?: string;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.status = options.status;
    this.requestUrl = options.requestUrl;
    this.cause = options.cause;
  }
}

export class GithubNotFoundError extends GithubClientError {
  public readonly code = "not-found" as const;
  public constructor(
    message: string,
    options: { readonly requestUrl?: string; readonly cause?: unknown } = {},
  ) {
    super(message, { ...options, status: 404 });
  }
}

export class GithubUnauthorizedError extends GithubClientError {
  public readonly code = "unauthorized" as const;
  public constructor(
    message: string,
    options: { readonly requestUrl?: string; readonly cause?: unknown } = {},
  ) {
    super(message, { ...options, status: 401 });
  }
}

export class GithubForbiddenError extends GithubClientError {
  public readonly code = "forbidden" as const;
  public constructor(
    message: string,
    options: { readonly requestUrl?: string; readonly cause?: unknown } = {},
  ) {
    super(message, { ...options, status: 403 });
  }
}

export class GithubRateLimitError extends GithubClientError {
  public readonly code = "rate-limited" as const;
  public readonly snapshot: GithubRateLimitSnapshot | null;
  public readonly retryAfterSeconds: number | null;
  public constructor(
    message: string,
    options: {
      readonly status: number;
      readonly requestUrl?: string;
      readonly cause?: unknown;
      readonly snapshot: GithubRateLimitSnapshot | null;
      readonly retryAfterSeconds: number | null;
    },
  ) {
    super(message, options);
    this.snapshot = options.snapshot;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export class GithubValidationError extends GithubClientError {
  public readonly code = "validation" as const;
  public readonly issues: readonly { readonly path: string; readonly message: string }[];
  public constructor(
    message: string,
    options: {
      readonly requestUrl?: string;
      readonly cause?: unknown;
      readonly issues: readonly { readonly path: string; readonly message: string }[];
    },
  ) {
    super(message, { ...options, status: 422 });
    this.issues = options.issues;
  }
}

export class GithubTransportError extends GithubClientError {
  public readonly code = "transport" as const;
  public readonly attempts: number;
  public constructor(
    message: string,
    options: {
      readonly requestUrl?: string;
      readonly cause?: unknown;
      readonly attempts: number;
    },
  ) {
    super(message, options);
    this.attempts = options.attempts;
  }
}

export class GithubParseError extends GithubClientError {
  public readonly code = "parse" as const;
  public constructor(
    message: string,
    options: { readonly requestUrl?: string; readonly cause?: unknown } = {},
  ) {
    super(message, options);
  }
}

export class GithubInternalError extends GithubClientError {
  public readonly code = "internal" as const;
  public constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message, options);
  }
}

/**
 * Mutation refused because no matching write scope is configured.
 * Fired before any network I/O. Cost hook still fires once per
 * ADR-0017 §8 for audit bookkeeping.
 */
export class GithubWriteScopeError extends GithubClientError {
  public readonly code = "write-scope-denied" as const;
  public readonly attemptedRepo: string;
  public readonly attemptedPath: string | null;
  public readonly scopeKind: GithubWriteScopeKind;
  public constructor(
    message: string,
    options: {
      readonly attemptedRepo: string;
      readonly attemptedPath?: string | null;
      readonly scopeKind: GithubWriteScopeKind;
      readonly requestUrl?: string;
    },
  ) {
    super(message, options.requestUrl !== undefined ? { requestUrl: options.requestUrl } : {});
    this.attemptedRepo = options.attemptedRepo;
    this.attemptedPath = options.attemptedPath ?? null;
    this.scopeKind = options.scopeKind;
  }
}

/**
 * `createCommitOnBranch` failed because `expectedHeadOid` no longer
 * matches the server's HEAD. Not retried — the caller must re-fetch
 * HEAD and rebuild the file changes.
 */
export class GithubConflictError extends GithubClientError {
  public readonly code = "conflict" as const;
  public readonly expectedHeadOid: string;
  public constructor(
    message: string,
    options: {
      readonly requestUrl?: string;
      readonly cause?: unknown;
      readonly expectedHeadOid: string;
    },
  ) {
    super(message, { ...options, status: 409 });
    this.expectedHeadOid = options.expectedHeadOid;
  }
}

/**
 * Mutation aborted via `AbortSignal`. Unlike reads (which re-throw
 * AbortError), mutations return this as a Result so the caller can
 * distinguish "aborted before bytes left the socket" from "aborted
 * after the server may have received the request". Per ADR-0017 §5.
 */
export class GithubMutationAbortedError extends GithubClientError {
  public readonly code = "mutation-aborted" as const;
  public readonly phase: "before-send" | "in-flight";
  public constructor(
    message: string,
    options: {
      readonly phase: "before-send" | "in-flight";
      readonly requestUrl?: string;
      readonly cause?: unknown;
    },
  ) {
    super(message, options);
    this.phase = options.phase;
  }
}
