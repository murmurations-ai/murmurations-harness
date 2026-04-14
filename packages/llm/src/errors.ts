/**
 * Error taxonomy for the LLM client. Mirrors `GithubClientError` but
 * adds three LLM-specific discriminants:
 *
 *   - `content-policy` — provider refused the prompt
 *   - `context-length` — prompt too long for the model
 *   - `provider-outage` — 5xx repeated; distinct from transport for
 *     the Phase 2 dual-run week's "outage minutes" accounting
 *
 * All errors carry `provider`, `requestUrl`, `cause`. None ever embed
 * the raw token — the `scrubCause` helper is the safety net.
 */

import type { SecretValue } from "@murmurations-ai/core";

import type { ProviderId } from "./types.js";

export type LLMClientErrorCode =
  | "unauthorized"
  | "forbidden"
  | "rate-limited"
  | "validation"
  | "content-policy"
  | "context-length"
  | "transport"
  | "provider-outage"
  | "parse"
  | "internal";

export type RateLimitScope = "rpm" | "rpd" | "tpm" | "tpd" | "unknown";

export abstract class LLMClientError extends Error {
  public abstract readonly code: LLMClientErrorCode;
  public readonly provider: ProviderId;
  public readonly requestUrl: string;
  public readonly status: number | undefined;
  public override readonly cause: unknown;
  protected constructor(
    provider: ProviderId,
    message: string,
    options: {
      readonly requestUrl: string;
      readonly status?: number;
      readonly cause?: unknown;
    },
  ) {
    super(message);
    this.name = new.target.name;
    this.provider = provider;
    this.requestUrl = options.requestUrl;
    this.status = options.status;
    this.cause = options.cause;
  }
}

export class LLMUnauthorizedError extends LLMClientError {
  public readonly code = "unauthorized" as const;
  public constructor(
    provider: ProviderId,
    message: string,
    options: { readonly requestUrl: string; readonly cause?: unknown },
  ) {
    super(provider, message, { ...options, status: 401 });
  }
}

export class LLMForbiddenError extends LLMClientError {
  public readonly code = "forbidden" as const;
  public constructor(
    provider: ProviderId,
    message: string,
    options: { readonly requestUrl: string; readonly cause?: unknown },
  ) {
    super(provider, message, { ...options, status: 403 });
  }
}

export class LLMRateLimitError extends LLMClientError {
  public readonly code = "rate-limited" as const;
  public readonly retryAfterSeconds: number | null;
  public readonly limitScope: RateLimitScope;
  public constructor(
    provider: ProviderId,
    message: string,
    options: {
      readonly requestUrl: string;
      readonly status: number;
      readonly cause?: unknown;
      readonly retryAfterSeconds: number | null;
      readonly limitScope: RateLimitScope;
    },
  ) {
    super(provider, message, options);
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.limitScope = options.limitScope;
  }
}

export class LLMValidationError extends LLMClientError {
  public readonly code = "validation" as const;
  public constructor(
    provider: ProviderId,
    message: string,
    options: { readonly requestUrl: string; readonly cause?: unknown; readonly status?: number },
  ) {
    super(provider, message, options);
  }
}

export class LLMContentPolicyError extends LLMClientError {
  public readonly code = "content-policy" as const;
  public constructor(
    provider: ProviderId,
    message: string,
    options: { readonly requestUrl: string; readonly cause?: unknown },
  ) {
    super(provider, message, options);
  }
}

export class LLMContextLengthError extends LLMClientError {
  public readonly code = "context-length" as const;
  public constructor(
    provider: ProviderId,
    message: string,
    options: { readonly requestUrl: string; readonly cause?: unknown },
  ) {
    super(provider, message, options);
  }
}

export class LLMTransportError extends LLMClientError {
  public readonly code = "transport" as const;
  public readonly attempts: number;
  public constructor(
    provider: ProviderId,
    message: string,
    options: {
      readonly requestUrl: string;
      readonly cause?: unknown;
      readonly attempts: number;
    },
  ) {
    super(provider, message, options);
    this.attempts = options.attempts;
  }
}

export class LLMProviderOutageError extends LLMClientError {
  public readonly code = "provider-outage" as const;
  public readonly attempts: number;
  public constructor(
    provider: ProviderId,
    message: string,
    options: {
      readonly requestUrl: string;
      readonly status: number;
      readonly cause?: unknown;
      readonly attempts: number;
    },
  ) {
    super(provider, message, options);
    this.attempts = options.attempts;
  }
}

export class LLMParseError extends LLMClientError {
  public readonly code = "parse" as const;
  public constructor(
    provider: ProviderId,
    message: string,
    options: { readonly requestUrl: string; readonly cause?: unknown },
  ) {
    super(provider, message, options);
  }
}

export class LLMInternalError extends LLMClientError {
  public readonly code = "internal" as const;
  public constructor(
    provider: ProviderId,
    message: string,
    options: { readonly requestUrl: string; readonly cause?: unknown },
  ) {
    super(provider, message, options);
  }
}

/**
 * Best-effort scrub of the raw token from a cause's message. Primary
 * defense is that the token never enters any error path we construct;
 * this is belt-and-suspenders for fetch implementations that somehow
 * end up with the header in their error message.
 *
 * Same invariant as the github client's `scrubCause`.
 */
export const scrubCause = (cause: unknown, token: SecretValue | null): unknown => {
  if (token === null) return cause;
  if (typeof cause !== "object" || cause === null) return cause;
  const raw = token.reveal();
  if (raw.length < 8) return cause;
  const message = (cause as { message?: unknown }).message;
  if (typeof message === "string" && message.includes(raw)) {
    return {
      ...cause,
      message: message.split(raw).join("[REDACTED:token]"),
      name: (cause as { name?: unknown }).name,
    };
  }
  return cause;
};
