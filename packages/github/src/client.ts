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

import type { SecretValue } from "@murmuration/core";

import type { IssueNumber, RepoCoordinate } from "./branded.js";
import { LruGithubCache, type GithubCache, type GithubCacheEntry } from "./cache.js";
import {
  GithubForbiddenError,
  GithubInternalError,
  GithubNotFoundError,
  GithubParseError,
  GithubRateLimitError,
  GithubTransportError,
  GithubUnauthorizedError,
  GithubValidationError,
  type GithubClientError,
  type GithubRateLimitSnapshot,
} from "./errors.js";
import { parseCommentArray, parseIssue, parseIssueArray } from "./parse.js";
import type { GithubComment, GithubIssue, ListIssuesFilter, Result } from "./types.js";

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
    readonly transport: "rest";
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
