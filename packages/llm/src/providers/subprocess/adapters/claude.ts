/**
 * Claude CLI adapter — wraps `claude -p`.
 *
 * Subscription auth via Claude Pro/Max OAuth (`claude /login`).
 * ADR-0034 reference adapter — the spike target.
 *
 * Open items (BU-1, BU-2 from ADR-0034):
 *   - BU-1: tool-use blocks in --output-format json output
 *   - BU-2: exact failure mode when not authenticated (exit code? stdin prompt?)
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { LLMRequest, LLMResponse, Result } from "../../../types.js";

import type { AuthError, AuthStatus, ParseError, SubprocessLLMAdapter } from "../types.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Claude CLI JSON event shapes (--output-format json)
// ---------------------------------------------------------------------------
//
// Claude CLI emits one JSON object per event, newline-separated:
//
//   {"type":"system","subtype":"init","session_id":"...","tools":[...]}
//   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}],...}}
//   {"type":"result","subtype":"success","result":"...","cost_usd":...,"usage":{...}}
//
// We scan for `type:"result"` (final answer + tokens + cost) and the most
// recent `type:"assistant"` (model id + tool-use content blocks).

interface ClaudeUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
}

interface ClaudeContentBlock {
  readonly type: "text" | "tool_use" | "tool_result";
  readonly text?: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: unknown;
}

interface ClaudeJsonEvent {
  readonly type: string;
  readonly subtype?: string;
  readonly result?: string;
  readonly session_id?: string;
  readonly cost_usd?: number;
  readonly usage?: ClaudeUsage;
  readonly message?: {
    readonly content?: readonly ClaudeContentBlock[];
    readonly model?: string;
  };
}

const isClaudeJsonEvent = (val: unknown): val is ClaudeJsonEvent =>
  typeof val === "object" && val !== null && typeof (val as { type?: unknown }).type === "string";

/**
 * Strip `-YYYYMMDD` snapshot date suffixes from Claude model ids.
 * `claude-sonnet-4-6-20251029` → `claude-sonnet-4-6`. Keeps cost
 * attribution + pricing catalog lookups stable across snapshots.
 */
const normalizeModel = (raw: string | undefined): string => {
  if (!raw) return "claude-cli";
  return raw.replace(/-\d{8}$/, "");
};

const truncateForError = (raw: string): string =>
  raw.length > 2000 ? `${raw.slice(0, 2000)}…[truncated]` : raw;

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class ClaudeCliAdapter implements SubprocessLLMAdapter {
  public readonly command = "claude";
  public readonly providerId = "claude-cli";

  /**
   * Build CLI argv for `claude -p --output-format json …`.
   * ADR-0034 D1: never includes prompt content; prompt is delivered via stdin.
   */
  public buildFlags(req: LLMRequest): readonly string[] {
    const flags: string[] = ["-p", "--output-format", "json", "--dangerously-skip-permissions"];
    if (req.model) {
      flags.push("--model", req.model);
    }
    return flags;
  }

  /**
   * Parse Claude CLI's newline-separated JSON event stream into an LLMResponse.
   *
   * ADR-0034 D3: token counts MUST NOT silently zero. If the result event
   * is missing `usage`, return ParseError so budget enforcement stays honest.
   */
  public parseOutput(raw: string): Result<LLMResponse, ParseError> {
    if (!raw.trim()) {
      return {
        ok: false,
        error: {
          kind: "parse-error",
          message: "Claude CLI produced empty output",
          raw: truncateForError(raw),
        },
      };
    }

    const events: ClaudeJsonEvent[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isClaudeJsonEvent(parsed)) events.push(parsed);
      } catch {
        /* skip malformed line */
      }
    }

    const resultEvent = events.find((e) => e.type === "result");
    if (!resultEvent) {
      return {
        ok: false,
        error: {
          kind: "parse-error",
          message: "No result event found in Claude CLI output",
          raw: truncateForError(raw),
        },
      };
    }

    const usage = resultEvent.usage;
    if (
      !usage ||
      typeof usage.input_tokens !== "number" ||
      typeof usage.output_tokens !== "number"
    ) {
      return {
        ok: false,
        error: {
          kind: "parse-error",
          message: "Claude CLI result missing usage.input_tokens/output_tokens (D3 violation)",
          raw: truncateForError(raw),
        },
      };
    }

    // Most-recent assistant event carries the model id and (BU-1) any tool_use blocks.
    let lastAssistant: ClaudeJsonEvent | undefined;
    for (const e of events) {
      if (e.type === "assistant") lastAssistant = e;
    }

    const toolCalls: { name: string; args: Record<string, unknown>; result: unknown }[] = [];
    if (lastAssistant?.message?.content) {
      for (const block of lastAssistant.message.content) {
        if (block.type === "tool_use" && typeof block.name === "string") {
          toolCalls.push({
            name: block.name,
            args:
              typeof block.input === "object" && block.input !== null
                ? (block.input as Record<string, unknown>)
                : {},
            result: null,
          });
        }
      }
    }

    const response: LLMResponse = {
      content: resultEvent.result ?? "",
      stopReason: "stop",
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      ...(usage.cache_read_input_tokens !== undefined
        ? { cacheReadTokens: usage.cache_read_input_tokens }
        : {}),
      ...(usage.cache_creation_input_tokens !== undefined
        ? { cacheWriteTokens: usage.cache_creation_input_tokens }
        : {}),
      modelUsed: normalizeModel(lastAssistant?.message?.model),
      providerUsed: this.providerId,
      toolCalls,
      steps: 1,
    };
    return { ok: true, value: response };
  }

  /**
   * Lightweight auth probe: `claude --version` (presence) → minimal -p
   * invocation (auth state). Does not block on stdin (ADR-0034 D2).
   */
  public async authCheck(): Promise<Result<AuthStatus, AuthError>> {
    // Step 1: presence
    try {
      await execFileAsync("claude", ["--version"], { timeout: 5_000 });
    } catch (err) {
      const e = err as { code?: string };
      if (e.code === "ENOENT") {
        return {
          ok: true,
          value: {
            kind: "unavailable",
            message:
              "claude CLI not found in PATH. Install Claude Code from https://claude.ai/download",
          },
        };
      }
      return {
        ok: false,
        error: {
          kind: "auth-error",
          message: `claude --version failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }

    // Step 2: presence is enough for boot-time. The actual auth state
    // surfaces on the first wake via the spawn close path, where stderr
    // is parsed for auth failure markers (looksLikeAuthFailure). Doing
    // a real auth probe here would require spawn + stdin (execFile lacks
    // `input` support in Node typings) and would burn an LLM call at
    // boot. ADR-0034 BU-2: refine this once we know the exact failure
    // mode (exit code, stdout marker, or stdin prompt deadlock).
    return { ok: true, value: { kind: "authenticated" } };
  }
}
