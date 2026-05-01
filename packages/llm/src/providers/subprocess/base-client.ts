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
  LLMTransportError,
  LLMUnauthorizedError,
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
    const internal = await this.#runSubprocess(request, options.signal);
    if (internal.ok) {
      // Surface token counts to the cost hook for parity with VercelAdapter.
      // costMicros is computed downstream (subscription path is $0 marginal,
      // but the hook still wants tokens for telemetry).
      if (options.costHook) {
        options.costHook.onLlmCall({
          provider: this.providerId,
          model: this.modelUsed,
          inputTokens: internal.value.inputTokens,
          outputTokens: internal.value.outputTokens,
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
    const flags = [...this.#cli.buildFlags(request)];
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

      let child: ReturnType<typeof spawn>;
      try {
        // Array argv only. Never shell:true. Prompt is NOT in flags (D1).
        child = spawn(this.#cli.command, flags, {
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
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
        stderr += chunk.toString("utf8");
      });

      // Wall-clock timeout (D4): SIGTERM after timeoutMs, SIGKILL after grace.
      const termTimer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGTERM");
        } catch {
          /* already exited */
        }
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already exited */
          }
          // D10: prevent zombies — let event loop exit even if child lingers.
          child.unref();
        }, this.#killGraceMs);
      }, this.#timeoutMs);

      // External cancellation via AbortSignal mirrors the timeout path.
      const onAbort = (): void => {
        timedOut = true;
        clearTimeout(termTimer);
        try {
          child.kill("SIGTERM");
        } catch {
          /* already exited */
        }
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already exited */
          }
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

        if (timedOut) {
          settle({ ok: false, error: { kind: "timeout-error", timeoutMs: this.#timeoutMs } });
          return;
        }

        if (code !== 0) {
          // Heuristic auth detection on stderr (D9: typed errors). Each adapter
          // can refine this via its own authCheck() probe; this catches the
          // case where a wake fires against an unauthenticated CLI.
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
