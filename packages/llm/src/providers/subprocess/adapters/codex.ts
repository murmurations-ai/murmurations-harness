/**
 * OpenAI Codex CLI adapter — wraps `codex exec --json`.
 *
 * Codex emits JSONL events on stdout:
 *   {"type":"thread.started","thread_id":"..."}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"id":"...","type":"agent_message","text":"..."}}
 *   {"type":"item.completed","item":{"id":"...","type":"function_call",...}}
 *   {"type":"turn.completed","usage":{"input_tokens":N,"cached_input_tokens":N,
 *      "output_tokens":N,"reasoning_output_tokens":N}}
 *
 * Token counts come from the most recent `turn.completed` event.
 * Final content is the concatenation of `agent_message` items, in order.
 * Tool calls are extracted from `function_call` items (BU-1 resolved here).
 */

import { spawnSync } from "node:child_process";

import type { LLMRequest, LLMResponse, Result } from "../../../types.js";

import type {
  AuthError,
  AuthStatus,
  ParseError,
  SubscriptionCliPermissionMode,
  SubprocessLLMAdapter,
} from "../types.js";

interface CodexUsage {
  readonly input_tokens?: number;
  readonly cached_input_tokens?: number;
  readonly output_tokens?: number;
  readonly reasoning_output_tokens?: number;
}

interface CodexFunctionCall {
  readonly id?: string;
  readonly type: "function_call";
  readonly name?: string;
  readonly arguments?: string | Record<string, unknown>;
}

interface CodexAgentMessage {
  readonly id?: string;
  readonly type: "agent_message";
  readonly text?: string;
}

type CodexItem = CodexAgentMessage | CodexFunctionCall | { readonly type: string };

interface CodexEvent {
  readonly type: string;
  readonly thread_id?: string;
  readonly item?: CodexItem;
  readonly usage?: CodexUsage;
}

export class CodexCliAdapter implements SubprocessLLMAdapter {
  public readonly command = "codex";
  public readonly providerId = "codex-cli";

  readonly #permissionMode: SubscriptionCliPermissionMode;

  public constructor(config: { readonly permissionMode?: SubscriptionCliPermissionMode } = {}) {
    this.#permissionMode = config.permissionMode ?? "restricted";
  }

  public buildFlags(req: LLMRequest): readonly string[] {
    // ADR-0034 D1: prompt content goes via stdin, never argv.
    // --skip-git-repo-check: let agents run regardless of cwd.
    // --ephemeral: don't persist session files (operator may run many wakes).
    // ADR-0036: only explicit `trusted` mode emits Codex's sandbox bypass.
    //
    // v0.7.0 (harness#293): when req.sessionId is set, switch to the
    // resume subcommand form (`codex exec resume <id> -`). This drops
    // --ephemeral because resume requires the session file. Future
    // refinement: capture the trade-off in a config knob so operators
    // can tune persistence vs. ephemerality per agent.
    const flags: string[] =
      req.sessionId !== undefined
        ? ["exec", "resume", req.sessionId, "--json", "--skip-git-repo-check"]
        : ["exec", "--json", "--skip-git-repo-check", "--ephemeral"];
    if (this.#permissionMode === "trusted") {
      flags.push("--dangerously-bypass-approvals-and-sandbox");
    }
    if (req.model) flags.push("--model", req.model);
    // Trailing `-` tells codex exec to read prompt from stdin.
    flags.push("-");
    return flags;
  }

  public parseOutput(raw: string): Result<LLMResponse, ParseError> {
    if (raw.trim().length === 0) {
      return {
        ok: false,
        error: {
          kind: "parse-error",
          message: "codex exec produced empty output",
          raw,
        },
      };
    }

    const events: CodexEvent[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isCodexEvent(parsed)) events.push(parsed);
      } catch {
        // Tolerate non-JSON lines (e.g. warnings printed to stdout).
      }
    }

    if (events.length === 0) {
      return {
        ok: false,
        error: {
          kind: "parse-error",
          message: "no parseable events in codex output",
          raw: raw.slice(0, 500),
        },
      };
    }

    // Find the most recent turn.completed for token counts.
    let usage: CodexUsage | undefined;
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event?.type === "turn.completed" && event.usage) {
        usage = event.usage;
        break;
      }
    }
    if (!usage) {
      return {
        ok: false,
        error: {
          kind: "parse-error",
          message: "codex output missing turn.completed event with usage",
          raw: raw.slice(0, 500),
        },
      };
    }

    // ADR-0034 D3: never silently zero token counts.
    const inputTokens = usage.input_tokens;
    const outputTokens = usage.output_tokens;
    if (typeof inputTokens !== "number" || typeof outputTokens !== "number") {
      return {
        ok: false,
        error: {
          kind: "parse-error",
          message: "codex usage missing input_tokens or output_tokens",
          raw: JSON.stringify(usage),
        },
      };
    }

    // Concatenate agent_message text in order; that's the user-visible reply.
    const messageParts: string[] = [];
    const toolCalls: { name: string; args: Record<string, unknown>; result: unknown }[] = [];
    for (const event of events) {
      if (event.type !== "item.completed" || !event.item) continue;
      const item = event.item;
      if (item.type === "agent_message" && "text" in item && typeof item.text === "string") {
        messageParts.push(item.text);
      } else if (item.type === "function_call" && "name" in item && typeof item.name === "string") {
        const rawArgs = "arguments" in item ? item.arguments : undefined;
        let args: Record<string, unknown> = {};
        if (typeof rawArgs === "string") {
          try {
            const parsed: unknown = JSON.parse(rawArgs);
            if (typeof parsed === "object" && parsed !== null) {
              args = parsed as Record<string, unknown>;
            }
          } catch {
            args = { raw: rawArgs };
          }
        } else if (rawArgs !== undefined) {
          args = rawArgs;
        }
        toolCalls.push({ name: item.name, args, result: null });
      }
    }

    const content = messageParts.join("\n\n").trim();
    if (content.length === 0 && toolCalls.length === 0) {
      return {
        ok: false,
        error: {
          kind: "parse-error",
          message: "codex output had no agent_message or function_call items",
          raw: raw.slice(0, 500),
        },
      };
    }

    // v0.7.0 (harness#293): capture thread_id from thread.started event
    // so callers can persist it for future resume. Returned on
    // LLMResponse.sessionId.
    const threadStarted = events.find((e) => e.type === "thread.started");
    const sessionId =
      typeof threadStarted?.thread_id === "string" ? threadStarted.thread_id : undefined;

    // Codex doesn't echo the model in its event stream. The daemon sets it
    // via buildFlags; we surface "codex" as a placeholder so the cost record
    // doesn't crash. Operators can override via role.md `llm.model`.
    return {
      ok: true,
      value: {
        content,
        stopReason: "stop",
        inputTokens,
        outputTokens,
        ...(typeof usage.cached_input_tokens === "number"
          ? { cacheReadTokens: usage.cached_input_tokens }
          : {}),
        modelUsed: "codex",
        providerUsed: "codex-cli",
        toolCalls,
        steps: 1,
        ...(sessionId !== undefined ? { sessionId } : {}),
      },
    };
  }

  public authCheck(): Promise<Result<AuthStatus, AuthError>> {
    // Boot-time presence check — actual auth state surfaces at wake time
    // via the SubprocessAdapter's stderr scan (looksLikeAuthFailure).
    try {
      const result = spawnSync("codex", ["--version"], {
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
              `codex --version exited ${String(result.status)}: ${result.stderr.trim()}`,
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

const isCodexEvent = (v: unknown): v is CodexEvent => {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return typeof obj.type === "string";
};
