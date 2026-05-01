/**
 * Gemini CLI adapter — wraps `gemini --output-format json`.
 *
 * Gemini emits a single JSON object on stdout:
 *   {
 *     "session_id": "...",
 *     "response": "...",
 *     "stats": {
 *       "models": {
 *         "gemini-2.5-flash-lite": { "api": {...},
 *           "tokens": { "prompt": N, "candidates": N, "total": N,
 *             "cached": N, "thoughts": N, "tool": N } },
 *         "gemini-2.5-flash": { ... }
 *       },
 *       "tools": { "totalCalls": N, ... },
 *       "files": { ... }
 *     }
 *   }
 *
 * Gemini may route through multiple models for a single prompt
 * (e.g. flash-lite for routing + flash for the response), so we sum
 * tokens across all models. The "primary" model surfaced as modelUsed
 * is the one with the most output tokens.
 *
 * stderr is noisy ([STARTUP] timing lines, "Loaded cached credentials.")
 * but the base-client only reads stderr on non-zero exit, so this is fine.
 */

import { spawnSync } from "node:child_process";

import type { LLMRequest, LLMResponse, Result } from "../../../types.js";

import type { AuthError, AuthStatus, ParseError, SubprocessLLMAdapter } from "../types.js";

interface GeminiModelStats {
  readonly tokens?: {
    readonly prompt?: number;
    readonly candidates?: number;
    readonly total?: number;
    readonly cached?: number;
    readonly thoughts?: number;
    readonly tool?: number;
  };
}

interface GeminiOutput {
  readonly session_id?: string;
  readonly response?: string;
  readonly stats?: {
    readonly models?: Record<string, GeminiModelStats>;
    readonly tools?: { readonly totalCalls?: number };
  };
  readonly error?: { readonly type?: string; readonly message?: string };
}

export class GeminiCliAdapter implements SubprocessLLMAdapter {
  public readonly command = "gemini";
  public readonly providerId = "gemini-cli";

  public buildFlags(req: LLMRequest): readonly string[] {
    // ADR-0034 D1: prompt content goes via stdin, never argv.
    // Gemini reads from stdin when no positional prompt is provided.
    // --yolo: auto-approve all tools (daemon controls the tool surface).
    const flags: string[] = ["--output-format", "json", "--yolo"];
    if (req.model) flags.push("--model", req.model);
    return flags;
  }

  public parseOutput(raw: string): Result<LLMResponse, ParseError> {
    if (raw.trim().length === 0) {
      return {
        ok: false,
        error: {
          kind: "parse-error",
          message: "gemini produced empty output",
          raw,
        },
      };
    }

    // Gemini may emit informational lines before/after the JSON block on
    // stdout in some configs. Find the first '{' and last '}' that wrap a
    // valid JSON object.
    const jsonStart = raw.indexOf("{");
    const jsonEnd = raw.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
      return {
        ok: false,
        error: {
          kind: "parse-error",
          message: "gemini output contained no JSON object",
          raw: raw.slice(0, 500),
        },
      };
    }

    const jsonText = raw.slice(jsonStart, jsonEnd + 1);
    let parsed: GeminiOutput;
    try {
      const candidate: unknown = JSON.parse(jsonText);
      if (typeof candidate !== "object" || candidate === null) {
        throw new Error("not an object");
      }
      parsed = candidate as GeminiOutput;
    } catch (err) {
      return {
        ok: false,
        error: {
          kind: "parse-error",
          message: `gemini JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
          raw: raw.slice(0, 500),
        },
      };
    }

    if (parsed.error) {
      return {
        ok: false,
        error: {
          kind: "parse-error",
          message: `gemini reported error: ${parsed.error.message ?? parsed.error.type ?? "unknown"}`,
          raw: jsonText.slice(0, 500),
        },
      };
    }

    const response = parsed.response;
    if (typeof response !== "string") {
      return {
        ok: false,
        error: {
          kind: "parse-error",
          message: "gemini output missing 'response' field",
          raw: jsonText.slice(0, 500),
        },
      };
    }

    const models = parsed.stats?.models;
    if (!models || typeof models !== "object") {
      return {
        ok: false,
        error: {
          kind: "parse-error",
          message: "gemini output missing stats.models",
          raw: jsonText.slice(0, 500),
        },
      };
    }

    // Sum tokens across all models that participated in the request.
    // Gemini's `prompt` ≈ input_tokens, `candidates` ≈ output_tokens,
    // `cached` ≈ cache_read_tokens, `thoughts` is reasoning (not billed
    // separately, included in candidates per current Gemini billing model).
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let primaryModel: string | undefined;
    let primaryOutputTokens = -1;

    for (const [modelName, stats] of Object.entries(models)) {
      const tokens = stats.tokens;
      if (!tokens) continue;
      if (typeof tokens.prompt === "number") inputTokens += tokens.prompt;
      if (typeof tokens.candidates === "number") {
        outputTokens += tokens.candidates;
        if (tokens.candidates > primaryOutputTokens) {
          primaryOutputTokens = tokens.candidates;
          primaryModel = modelName;
        }
      }
      if (typeof tokens.cached === "number") cacheReadTokens += tokens.cached;
    }

    // ADR-0034 D3: never silently zero token counts. If we got nothing,
    // surface a parse error rather than fabricating a $0/0-token record.
    if (inputTokens === 0 && outputTokens === 0) {
      return {
        ok: false,
        error: {
          kind: "parse-error",
          message: "gemini stats.models contained no usable token counts",
          raw: jsonText.slice(0, 500),
        },
      };
    }

    // Tool-call detail: gemini reports only totals (totalCalls, byName) in
    // the JSON output, not per-call name/args. We surface a placeholder
    // entry per call so the daemon's tool-use accounting reflects activity.
    const totalCalls = parsed.stats?.tools?.totalCalls;
    const toolCalls: { name: string; args: Record<string, unknown>; result: unknown }[] = [];
    if (typeof totalCalls === "number" && totalCalls > 0) {
      const byName = (
        parsed.stats?.tools as { readonly byName?: Record<string, unknown> } | undefined
      )?.byName;
      if (byName && typeof byName === "object") {
        for (const name of Object.keys(byName)) {
          toolCalls.push({ name, args: {}, result: null });
        }
      }
    }

    return {
      ok: true,
      value: {
        content: response,
        stopReason: "stop",
        inputTokens,
        outputTokens,
        ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
        modelUsed: primaryModel ?? "gemini",
        providerUsed: "gemini-cli",
        toolCalls,
        steps: 1,
      },
    };
  }

  public authCheck(): Promise<Result<AuthStatus, AuthError>> {
    // Boot-time presence check — actual auth state surfaces at wake time
    // via the SubprocessAdapter's stderr scan (looksLikeAuthFailure).
    try {
      const result = spawnSync("gemini", ["--version"], {
        encoding: "utf8",
        timeout: 5000,
      });
      if (result.error || result.status !== 0) {
        return Promise.resolve({
          ok: true,
          value: {
            kind: "unavailable",
            message:
              result.error?.message ??
              `gemini --version exited ${String(result.status)}: ${result.stderr.trim()}`,
          },
        });
      }
      return Promise.resolve({
        ok: true,
        value: { kind: "authenticated" },
      });
    } catch (err) {
      return Promise.resolve({
        ok: true,
        value: {
          kind: "unavailable",
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }
}
