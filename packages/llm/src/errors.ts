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

// ---------------------------------------------------------------------------
// Human-readable formatting with remediation hints
// ---------------------------------------------------------------------------

/**
 * Format an {@link LLMClientError} as a multi-line operator-facing
 * block. Shows provider, code, HTTP status, model when provided, and
 * the raw provider message. Appends a short "what to check" list
 * tailored to the error code + provider so a tester hit with a 403
 * knows to look at API-key permissions rather than their agent code.
 *
 * Never embeds the API key or token. Safe to print to stdout.
 *
 * Intentionally generous with whitespace — operators read this in a
 * terminal, not a log aggregator.
 */
export const formatLLMError = (
  err: LLMClientError,
  context: { readonly agentId?: string; readonly model?: string } = {},
): string => {
  const lines: string[] = [];
  const who = context.agentId !== undefined ? ` for ${context.agentId}` : "";
  lines.push(`LLM call failed${who}`);
  lines.push(`  provider: ${err.provider}`);
  if (context.model !== undefined) lines.push(`  model:    ${context.model}`);
  lines.push(
    `  code:     ${err.code}${err.status !== undefined ? ` (HTTP ${String(err.status)})` : ""}`,
  );
  lines.push(`  message:  ${err.message}`);
  const hints = remediationHints(err);
  if (hints.length > 0) {
    lines.push("");
    lines.push("Next steps:");
    for (const hint of hints) lines.push(`  - ${hint}`);
  }
  return lines.join("\n");
};

const remediationHints = (err: LLMClientError): readonly string[] => {
  switch (err.code) {
    case "unauthorized":
      return [
        `Your ${envVarForProvider(err.provider)} is missing or wrong. Check \`.env\` and confirm the key starts with the expected prefix.`,
        "Rotate the key at the provider console if it may be compromised.",
        "After editing .env, restart the daemon so the new value is loaded.",
      ];
    case "forbidden":
      return providerForbiddenHints(err.provider);
    case "rate-limited":
      return [
        "You've hit the provider's rate limit. Wait a minute or two and retry.",
        "If this happens often: lower wake cadence (agent role.md `wake_schedule`), reduce parallelism, or upgrade your provider plan.",
        "Consider a different model tier — set `model_tier: economy` in role.md for cheaper, higher-limit models.",
      ];
    case "content-policy":
      return [
        "The provider refused the prompt for safety/policy reasons.",
        "Check the agent's soul.md and any recent signals for content that could have tripped the filter.",
      ];
    case "context-length":
      return [
        "The prompt exceeded the model's context window.",
        "Reduce the number of signals included (agent role.md `signals` caps), shorten agent soul.md, or switch to a larger-context model.",
      ];
    case "transport":
    case "provider-outage":
      return [
        "Network or upstream provider issue.",
        "Check connectivity and https://status.anthropic.com / https://status.openai.com / https://status.cloud.google.com depending on provider.",
        "Retry in a few minutes.",
      ];
    case "validation":
    case "parse":
    case "internal":
      return ["Unexpected client error. Include the `message:` line above when filing a bug."];
  }
};

const envVarForProvider = (provider: string): string => {
  switch (provider) {
    case "gemini":
      return "GEMINI_API_KEY";
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "openai":
      return "OPENAI_API_KEY";
    default:
      return `${provider.toUpperCase()}_API_KEY`;
  }
};

const providerForbiddenHints = (provider: string): readonly string[] => {
  const common = [
    "403 usually means the API key is valid but not permitted for this model or region.",
  ];
  switch (provider) {
    case "gemini":
      return [
        ...common,
        "Gemini free tier only supports some models. Try `model_tier: economy` in role.md to pick a free-tier-friendly model, or enable billing at https://aistudio.google.com/app/apikey.",
        "If you're outside a supported region, use a VPN endpoint in a supported region or switch providers (anthropic / openai).",
      ];
    case "anthropic":
      return [
        ...common,
        "Anthropic keys need model access granted per-model. Check https://console.anthropic.com/settings/workspaces.",
      ];
    case "openai":
      return [
        ...common,
        "OpenAI keys need billing + model access. Check https://platform.openai.com/settings/organization/limits.",
      ];
    default:
      return common;
  }
};

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
