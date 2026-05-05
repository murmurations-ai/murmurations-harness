/**
 * SubprocessAdapter — shared base for the subscription-CLI provider family.
 *
 * Implements LLMAdapter by spawning a CLI subprocess, delivering the prompt
 * via stdin, capturing stdout, and routing parsing to a per-CLI adapter.
 *
 * ADR-0034 design constraints enforced here:
 *   D1  buildFlags() never receives prompt content; prompt → stdin only
 *   D4  Wall-clock timeout via SIGTERM → SIGKILL grace (default 90s)
 *   D9  CLI failure → typed LLMClientError; no silent fallback
 *   D10 Zombie-process prevention (child.unref() after kill)
 *
 * Shell interpolation is impossible by construction: spawn(cmd, [...flags])
 * uses array argv, never `shell: true`. The operator's prompt content cannot
 * appear in argv (D1), so process listings (`ps aux`, audit logs) are clean.
 */

import { spawn } from "node:child_process";

import type { LLMClientError } from "../../errors.js";
import {
  LLMInternalError,
  LLMParseError,
  LLMRateLimitError,
  LLMTransportError,
  LLMUnauthorizedError,
  LLMValidationError,
} from "../../errors.js";
import type {
  LLMClientCapabilities,
  LLMRequest,
  LLMResponse,
  ProviderId,
  Result,
} from "../../types.js";
import type { LLMAdapter, ResolvedCallOptions } from "../../adapters/adapter.js";

import type { SubprocessError, SubprocessLLMAdapter } from "./types.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface SubprocessAdapterConfig {
  readonly cliAdapter: SubprocessLLMAdapter;
  /** Wall-clock timeout in ms. SIGTERM fires after this. Default: 600_000
   * (10 min) — sized for multi-step agent wakes, not single-turn prompts.
   * Operators with strict wake budgets should pin a smaller value via
   * `llm.timeoutMs` in role.md. */
  readonly timeoutMs?: number;
  /** Grace period in ms between SIGTERM and SIGKILL. Default: 5_000. */
  readonly killGraceMs?: number;
  /** Capabilities reported via {@link LLMAdapter.capabilities}. */
  readonly capabilities?: LLMClientCapabilities;
}

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_KILL_GRACE_MS = 5_000;

const DEFAULT_CAPABILITIES: LLMClientCapabilities = {
  supportsStreaming: false,
  // ADR-0034 BU-1: tool-use through CLI JSON output is unconfirmed.
  // Conservative default: false until the spike resolves it for each adapter.
  supportsToolUse: false,
  supportsJsonMode: true,
  maxContextTokens: 200_000,
};

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

export class SubprocessAdapter implements LLMAdapter {
  public readonly providerId: ProviderId;
  public readonly modelUsed: string;
  public readonly capabilities: LLMClientCapabilities;

  readonly #cli: SubprocessLLMAdapter;
  readonly #timeoutMs: number;
  readonly #killGraceMs: number;

  public constructor(model: string, config: SubprocessAdapterConfig) {
    this.providerId = config.cliAdapter.providerId;
    this.modelUsed = model;
    this.capabilities = config.capabilities ?? {
      ...DEFAULT_CAPABILITIES,
      provider: config.cliAdapter.providerId,
    };
    this.#cli = config.cliAdapter;
    this.#timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#killGraceMs = config.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  }

  public async complete(
    request: LLMRequest,
    options: ResolvedCallOptions,
  ): Promise<Result<LLMResponse, LLMClientError>> {
    // ADR-0038 CF-A (harness#282): subscription-CLI runs its own tool loop
    // via the vendor binary; per-request `tools` and `maxSteps` are not
    // honored. Fail loudly here instead of silently dropping — silent
    // drops are the regression class B5 detection (PR #240) was filed
    // to catch. Tools must be configured at client construction via
    // `mcpConfigPath` on `SubscriptionCliClientConfig` (see ADR-0038).
    if ((request.tools?.length ?? 0) > 0 || (request.maxSteps ?? 1) > 1) {
      return {
        ok: false,
        error: new LLMValidationError(
          this.providerId,
          `Subscription-CLI does not honor per-request tools or maxSteps. ` +
            `Tools must be configured at client construction via mcpConfigPath ` +
            `(see ADR-0038). Got ${String(request.tools?.length ?? 0)} tools, ` +
            `maxSteps=${String(request.maxSteps ?? 1)}.`,
          { requestUrl: `subprocess://${this.providerId}/${this.modelUsed}` },
        ),
      };
    }
    const internal = await this.#runSubprocess(request, options.signal);
    if (internal.ok) {
      // Surface token counts to the cost hook for parity with VercelAdapter.
      // costMicros is computed downstream (subscription path is $0 marginal,
      // but the hook still wants tokens for telemetry). Cache tokens MUST
      // be forwarded — without them, cache-heavy wakes (long context with
      // 90%+ cache hits) under-report shadow cost by an order of magnitude.
      if (options.costHook) {
        options.costHook.onLlmCall({
          provider: this.providerId,
          model: this.modelUsed,
          inputTokens: internal.value.inputTokens,
          outputTokens: internal.value.outputTokens,
          ...(internal.value.cacheReadTokens !== undefined
            ? { cacheReadTokens: internal.value.cacheReadTokens }
            : {}),
          ...(internal.value.cacheWriteTokens !== undefined
            ? { cacheWriteTokens: internal.value.cacheWriteTokens }
            : {}),
        });
      }
      return internal;
    }
    return { ok: false, error: this.#mapError(internal.error) };
  }

  // ---------------------------------------------------------------------------
  // Internal runner — returns SubprocessError; complete() maps to LLMClientError
  // ---------------------------------------------------------------------------

  async #runSubprocess(
    request: LLMRequest,
    abort: AbortSignal | undefined,
  ): Promise<Result<LLMResponse, SubprocessError>> {
    // The runner does not set request.model — it relies on the client's
    // bound model (single source of truth, see runner/index.ts comment about
    // harness#252). Subprocess adapters need the model name to set --model
    // on the CLI, so default it from this.modelUsed if not explicitly set.
    const requestWithModel: LLMRequest = request.model
      ? request
      : { ...request, model: this.modelUsed };
    const flags = [...this.#cli.buildFlags(requestWithModel)];
    const prompt = renderPrompt(request);

    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      const settle = (result: Result<LLMResponse, SubprocessError>): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      // Diagnostic: log every flag the subprocess receives so future
      // hangs can be diagnosed from the log alone (live-test 2026-05-04).
      process.stderr.write(
        `${JSON.stringify({ ts: new Date().toISOString(), level: "info", event: "subprocess.spawn", command: this.#cli.command, flags: [...flags], promptBytes: prompt.length })}\n`,
      );
      let child: ReturnType<typeof spawn>;
      try {
        // Array argv only. Never shell:true. Prompt is NOT in flags (D1).
        //
        // detached:true puts the child in its own process group on
        // POSIX (PGID == PID). Combined with `process.kill(-pid, SIG)`
        // in killTree() below, this lets us signal the CLI AND any
        // helper processes it spawns. Without this, SIGKILL only kills
        // the immediate child — if that child is a node wrapper (claude
        // is `node /…/claude`) or has spawned helpers, those linger.
        // Live evidence (2026-05-03 verification wake): claude-cli
        // lingered ~5min past SIGKILL because helper subprocesses
        // ignored the parent's death (D10).
        child = spawn(this.#cli.command, flags, {
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
          detached: true,
        });
      } catch (err) {
        settle({
          ok: false,
          error: {
            kind: "spawn-error",
            message: err instanceof Error ? err.message : String(err),
          },
        });
        return;
      }

      // Deliver prompt via stdin only — never interpolated into argv (D1).
      // stdin write errors are swallowed: the child may have already exited
      // (e.g., auth failure before reading) and that surfaces via close().
      // Streams are non-null because we passed `stdio: ["pipe","pipe","pipe"]`.
      const childStdin = child.stdin;
      const childStdout = child.stdout;
      const childStderr = child.stderr;
      if (!childStdin || !childStdout || !childStderr) {
        settle({
          ok: false,
          error: {
            kind: "spawn-error",
            message: "child stdio streams unavailable (this should never happen with pipe stdio)",
          },
        });
        return;
      }
      childStdin.on("error", () => undefined);
      childStdin.write(prompt, "utf8");
      childStdin.end();

      childStdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      childStderr.on("data", (chunk: Buffer) => {
        const s = chunk.toString("utf8");
        stderr += s;
        // Live-test 2026-05-04: stream subprocess stderr to daemon log
        // immediately so MCP startup errors / auth prompts / hang causes
        // surface in the wake log even when the subprocess never exits.
        process.stderr.write(
          `${JSON.stringify({ ts: new Date().toISOString(), level: "info", event: "subprocess.stderr.chunk", bytes: s.length, text: s.slice(0, 800) })}\n`,
        );
      });

      // killTree(): signal the entire process group, not just the
      // immediate child. Required because `detached:true` on spawn
      // gave the child its own PGID; without group-targeted kill,
      // descendants survive (the D10 lingering-claude case).
      // `process.kill(-pgid, sig)` is the POSIX idiom; on platforms
      // where PGID isn't reliable we fall back to `child.kill()`.
      const killTree = (signal: "SIGTERM" | "SIGKILL"): void => {
        const pid = child.pid;
        if (pid === undefined) {
          // Child never started cleanly; nothing to signal.
          return;
        }
        try {
          process.kill(-pid, signal);
        } catch {
          // -pid path failed (already-exited group, or POSIX limitation).
          // Fall through to direct child kill so we still send the signal.
          try {
            child.kill(signal);
          } catch {
            /* already exited */
          }
        }
      };

      // Wall-clock timeout (D4): SIGTERM after timeoutMs, SIGKILL after grace.
      const termTimer = setTimeout(() => {
        timedOut = true;
        killTree("SIGTERM");
        setTimeout(() => {
          killTree("SIGKILL");
          // D10: prevent zombies — let event loop exit even if child lingers.
          child.unref();
        }, this.#killGraceMs);
      }, this.#timeoutMs);

      // External cancellation via AbortSignal mirrors the timeout path.
      const onAbort = (): void => {
        timedOut = true;
        clearTimeout(termTimer);
        killTree("SIGTERM");
        setTimeout(() => {
          killTree("SIGKILL");
          child.unref();
        }, this.#killGraceMs);
      };
      if (abort) {
        if (abort.aborted) onAbort();
        else abort.addEventListener("abort", onAbort, { once: true });
      }

      child.on("close", (code) => {
        clearTimeout(termTimer);
        if (abort) abort.removeEventListener("abort", onAbort);
        process.stderr.write(
          `${JSON.stringify({ ts: new Date().toISOString(), level: "info", event: "subprocess.close", exitCode: code, timedOut, stdoutBytes: stdout.length, stderrBytes: stderr.length, stderrSnippet: stderr.slice(0, 500) })}\n`,
        );

        if (timedOut) {
          settle({ ok: false, error: { kind: "timeout-error", timeoutMs: this.#timeoutMs } });
          return;
        }

        if (code !== 0) {
          // Heuristic detection on stderr (D9: typed errors). Each adapter
          // can refine these via its own authCheck() probe; this catches
          // the wake-time cases where the CLI is unauthenticated or the
          // operator's subscription has hit a rate limit.
          //
          // Order matters: rate-limit messages sometimes contain the
          // word "limit" which would also match auth heuristics. Check
          // rate-limit first so a throttled session doesn't get flagged
          // as an auth failure.
          const rl = looksLikeRateLimit(stderr);
          if (rl !== null) {
            settle({
              ok: false,
              error: {
                kind: "rate-limit-error",
                message: stderr.trim() || `CLI exited ${String(code)} (rate limit suspected)`,
                retryAfterSeconds: rl.retryAfterSeconds,
                ...(typeof code === "number" ? { exitCode: code } : {}),
              },
            });
            return;
          }
          if (looksLikeAuthFailure(stderr)) {
            settle({
              ok: false,
              error: {
                kind: "auth-error",
                message: stderr.trim() || `CLI exited ${String(code)} (auth failure suspected)`,
                ...(typeof code === "number" ? { exitCode: code } : {}),
              },
            });
            return;
          }

          settle({
            ok: false,
            error: {
              kind: "spawn-error",
              message: stderr.trim() || `CLI exited with code ${String(code)}`,
              ...(typeof code === "number" ? { exitCode: code } : {}),
            },
          });
          return;
        }

        const parsed = this.#cli.parseOutput(stdout);
        settle(parsed);
      });

      child.on("error", (err) => {
        clearTimeout(termTimer);
        if (abort) abort.removeEventListener("abort", onAbort);
        settle({ ok: false, error: { kind: "spawn-error", message: err.message } });
      });
    });
  }

  // ---------------------------------------------------------------------------
  // SubprocessError → LLMClientError mapping. Keeps the public adapter
  // contract stable across providers (Vercel + subprocess both surface
  // LLMClientError to the LLMClient).
  // ---------------------------------------------------------------------------

  #mapError(err: SubprocessError): LLMClientError {
    const opts = {
      requestUrl: `subprocess://${this.providerId}/${this.modelUsed}`,
      cause: err,
    };
    switch (err.kind) {
      case "timeout-error":
        return new LLMTransportError(
          this.providerId,
          `subprocess timed out after ${String(err.timeoutMs)}ms`,
          { ...opts, attempts: 1 },
        );
      case "auth-error":
        return new LLMUnauthorizedError(this.providerId, err.message, opts);
      case "rate-limit-error":
        return new LLMRateLimitError(this.providerId, err.message, {
          ...opts,
          status: 429,
          retryAfterSeconds: err.retryAfterSeconds,
          // Subscription rate limits are session/quota-based; the standard
          // tpm/tpd/rpm/rpd taxonomy doesn't quite fit. Use "unknown" to
          // signal "vendor didn't tell us which scope".
          limitScope: "unknown",
        });
      case "parse-error":
        return new LLMParseError(this.providerId, err.message, opts);
      case "spawn-error":
        return new LLMInternalError(this.providerId, err.message, opts);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Render LLMRequest messages + system prompt into the stdin payload. */
const renderPrompt = (request: LLMRequest): string => {
  const parts: string[] = [];
  if (request.systemPromptOverride) {
    parts.push(`<system>\n${request.systemPromptOverride}\n</system>`);
  }
  for (const msg of request.messages) {
    if (msg.role === "system") {
      parts.push(`<system>\n${msg.content}\n</system>`);
    } else {
      parts.push(`${msg.role}: ${msg.content}`);
    }
  }
  return parts.join("\n\n");
};

/** Heuristic stderr scan for auth-style failure messages. */
const AUTH_FAILURE_NEEDLES = [
  "not logged in",
  "not authenticated",
  "authentication required",
  "please login",
  "please log in",
  "unauthorized",
  "no api key",
];

const looksLikeAuthFailure = (stderr: string): boolean => {
  const lower = stderr.toLowerCase();
  return AUTH_FAILURE_NEEDLES.some((needle) => lower.includes(needle));
};

/**
 * Heuristic stderr scan for subscription rate-limit / quota messages.
 * Returns null when no signal matches, otherwise an object with the
 * vendor's retry hint (in seconds) if surfaced.
 *
 * Examples we want to catch (gathered from the three CLIs' actual
 * throttling messages and from vendor docs):
 *   - "rate limit reached" / "rate-limit reached"
 *   - "you've reached your usage limit"
 *   - "quota exceeded"
 *   - "too many requests"
 *   - "5-hour limit reached" / "weekly limit reached"
 *   - "approaching your limit" (warning, not failure — we don't catch this)
 *   - HTTP-style "retry-after: 3600" or "retry after 1h"
 */
const RATE_LIMIT_NEEDLES = [
  "rate limit",
  "rate-limit",
  "usage limit",
  "quota exceeded",
  "too many requests",
  "5-hour limit",
  "weekly limit",
  "monthly limit",
  "session limit",
  "throttle",
];

/**
 * @internal Exported for unit testing. Production callers should rely
 * on the SubprocessAdapter's stderr scan, not call this directly.
 */
export const looksLikeRateLimit = (stderr: string): { retryAfterSeconds: number | null } | null => {
  const lower = stderr.toLowerCase();
  if (!RATE_LIMIT_NEEDLES.some((needle) => lower.includes(needle))) {
    return null;
  }
  return { retryAfterSeconds: parseRetryAfter(lower) };
};

/**
 * Best-effort parse of a vendor's retry hint from stderr. Looks for:
 *   - "retry-after: <N>"  (seconds, HTTP-style)
 *   - "retry in <N>s|m|h" (relative duration)
 *   - "try again in <N>s|m|h"
 *   - "resets in <N>s|m|h"
 * Returns seconds, or null if no hint is present.
 */
const parseRetryAfter = (lower: string): number | null => {
  const httpMatch = /retry-after:\s*(\d+)/i.exec(lower);
  if (httpMatch?.[1]) return Number(httpMatch[1]);

  const phraseMatch = /(?:retry in|try again in|resets in|retry after)\s+(\d+)\s*(s|m|h)/i.exec(
    lower,
  );
  if (phraseMatch?.[1] && phraseMatch[2]) {
    const n = Number(phraseMatch[1]);
    const unit = phraseMatch[2];
    if (unit === "s") return n;
    if (unit === "m") return n * 60;
    if (unit === "h") return n * 3600;
  }
  return null;
};
