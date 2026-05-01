/**
 * Subscription-CLI provider family — type contracts.
 *
 * ADR-0034: subscription-CLI provider family.
 *
 * Three CLI tools (Claude Code `claude -p`, Gemini `gemini -p`,
 * OpenAI Codex `codex exec`) all subprocess-spawn the operator's
 * locally-installed AI CLI. Each adapter handles CLI-specific
 * concerns (flag mapping, output parsing, auth detection); the
 * shared base client owns subprocess lifecycle.
 */

import type { LLMRequest, LLMResponse, Result } from "../../types.js";

// ---------------------------------------------------------------------------
// Internal error taxonomy — adapter-level. The public LLMAdapter contract
// surfaces these as LLMClientError (mapped at the adapter boundary in
// subprocess-adapter.ts).
// ---------------------------------------------------------------------------

/** Process failed to spawn (ENOENT, EACCES, etc.) or exited non-zero unexpectedly. */
export interface SpawnError {
  readonly kind: "spawn-error";
  readonly message: string;
  readonly exitCode?: number;
}

/** CLI output could not be parsed into an LLMResponse. */
export interface ParseError {
  readonly kind: "parse-error";
  readonly message: string;
  /** Raw stdout (truncated to 2000 chars) for debugging. */
  readonly raw: string;
}

/** CLI is installed but the operator is not authenticated. */
export interface AuthError {
  readonly kind: "auth-error";
  readonly message: string;
  readonly exitCode?: number;
}

/** Process exceeded wall-clock timeout. SIGTERM was sent; SIGKILL after grace. */
export interface TimeoutError {
  readonly kind: "timeout-error";
  readonly timeoutMs: number;
}

/**
 * Subscription rate limit reached on the operator's account (Pro/Max,
 * ChatGPT, Google subscription). Distinct from auth-error: the CLI is
 * authenticated, but the vendor is throttling the session.
 *
 * Vendors don't expose remaining quota or refresh time in any
 * consistent format, so retryAfterSeconds is best-effort: parsed from
 * stderr when present, null otherwise. The daemon agent state machine
 * treats this as a transient failure with operator-configurable retry.
 */
export interface RateLimitError {
  readonly kind: "rate-limit-error";
  readonly message: string;
  readonly exitCode?: number;
  /** Vendor's hint, in seconds, if surfaced in stderr. Otherwise null. */
  readonly retryAfterSeconds: number | null;
}

export type SubprocessError = SpawnError | ParseError | AuthError | TimeoutError | RateLimitError;

// ---------------------------------------------------------------------------
// Auth status — three-state model (ADR-0034 D2).
// ---------------------------------------------------------------------------

export type AuthStatus =
  | {
      /** CLI is installed and authenticated. */
      readonly kind: "authenticated";
      /** Optional identity hint (session id, account email, etc.) — for logs only. */
      readonly identity?: string;
    }
  | {
      /** CLI is installed but not logged in. Hard wake-time failure. */
      readonly kind: "unauthenticated";
      readonly message: string;
    }
  | {
      /** CLI is not installed / not in PATH. Soft skip with actionable message. */
      readonly kind: "unavailable";
      readonly message: string;
    };

// ---------------------------------------------------------------------------
// Per-CLI adapter contract.
// ---------------------------------------------------------------------------

/**
 * Per-CLI adapter. Implements the three CLI-specific concerns:
 *   1. Flag building (no prompt content in flags — ever; ADR-0034 D1).
 *   2. Output parsing (JSON → LLMResponse; ADR-0034 D3 forbids silent zero tokens).
 *   3. Auth checking (lightweight probe; ADR-0034 D2).
 *
 * The shared base (SubprocessAdapter) owns process lifecycle, timeout,
 * signal handling, and error mapping to LLMClientError.
 */
export interface SubprocessLLMAdapter {
  /** The CLI command to invoke (e.g. "claude", "gemini", "codex"). */
  readonly command: string;
  /** Provider id for cost attribution and logs (e.g. "claude-cli"). */
  readonly providerId: string;

  /**
   * Build CLI argv from the LLM request.
   *
   * MUST NOT include prompt content — the prompt is delivered via
   * stdin only (security: prevents argv leakage to `ps aux`, audit
   * logs, and shell history). Array form only — never shell strings.
   */
  buildFlags(req: LLMRequest): readonly string[];

  /**
   * Parse raw CLI stdout into an LLMResponse.
   *
   * Returns ParseError if output is malformed or token counts are
   * missing. Token counts MUST NEVER silently default to 0 — that
   * would disable budget enforcement (ADR-0034 D3).
   */
  parseOutput(raw: string): Result<LLMResponse, ParseError>;

  /**
   * Check whether the CLI is installed and authenticated.
   *
   * MUST NOT block on stdin (deadlock risk if a CLI prompts).
   * MUST complete in under 10s — operator boot time is observable.
   */
  authCheck(): Promise<Result<AuthStatus, AuthError>>;
}
