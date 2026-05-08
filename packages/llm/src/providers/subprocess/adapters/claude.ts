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

import { scrubValuePatterns } from "@murmurations-ai/core";

import type { LLMRequest, LLMResponse, Result } from "../../../types.js";

import type {
  AuthError,
  AuthStatus,
  ParseError,
  SubscriptionCliPermissionMode,
  SubprocessLLMAdapter,
} from "../types.js";

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

const truncateForError = (raw: string): string => {
  const truncated = raw.length > 2000 ? `${raw.slice(0, 2000)}…[truncated]` : raw;
  return scrubValuePatterns(truncated);
};

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface ClaudeCliAdapterConfig {
  /**
   * Path to an MCP config JSON file (`{ "mcpServers": {...} }`). When set,
   * passed to claude as `--mcp-config <path>` so the CLI loads the listed
   * MCP servers in addition to its own. Used by Spirit's subscription-cli
   * route to expose harness-internal tools to claude via MCP — see
   * packages/cli/src/spirit/mcp-server.ts.
   */
  readonly mcpConfigPath?: string;
  /**
   * Names of MCP servers declared in the agent's role.md `tools.mcp` block.
   * When set, each name is emitted as `--allowedTools mcp__<name>__*` so the
   * claude subprocess can invoke those tools without interactive permission
   * prompts (harness#357). Only covers declared servers — built-in tool
   * permissions are unaffected.
   */
  readonly allowedMcpServerNames?: readonly string[];
  /** ADR-0036: only `trusted` emits Claude's native auto-approve flag. */
  readonly permissionMode?: SubscriptionCliPermissionMode;
  /**
   * Absolute path to the `claude` binary. When set, used verbatim in
   * spawn() instead of relying on PATH resolution. Critical for launchd /
   * cron environments where PATH is minimal and doesn't include
   * user-specific install locations (e.g. ~/.local/bin). Resolved at
   * daemon boot via `resolveCliBinaryPath()` in boot.ts (harness#XXX).
   */
  readonly cliPath?: string;
}

export class ClaudeCliAdapter implements SubprocessLLMAdapter {
  public readonly command: string;
  public readonly providerId = "claude-cli";

  readonly #mcpConfigPath: string | undefined;
  readonly #allowedMcpServerNames: readonly string[];
  readonly #permissionMode: SubscriptionCliPermissionMode;

  public constructor(config: ClaudeCliAdapterConfig = {}) {
    this.command = config.cliPath ?? "claude";
    this.#mcpConfigPath = config.mcpConfigPath;
    this.#allowedMcpServerNames = config.allowedMcpServerNames ?? [];
    this.#permissionMode = config.permissionMode ?? "restricted";
  }

  /**
   * Build CLI argv for `claude -p --output-format json …`.
   * ADR-0034 D1: never includes prompt content; prompt is delivered via stdin.
   *
   * v0.7.0 (harness#293): when `req.sessionId` is set, emits
   * `--resume <id>` so the CLI keeps prompt cache warm across turns.
   */
  public buildFlags(req: LLMRequest): readonly string[] {
    const flags: string[] = ["-p", "--output-format", "json"];
    if (this.#permissionMode === "trusted") {
      flags.push("--dangerously-skip-permissions");
    }
    if (req.model) {
      flags.push("--model", req.model);
    }
    if (this.#mcpConfigPath) {
      flags.push("--mcp-config", this.#mcpConfigPath);
    }
    if (this.#allowedMcpServerNames.length > 0) {
      const mcpTools = this.#allowedMcpServerNames.map((n) => `mcp__${n}__*`).join(",");
      flags.push("--allowedTools", mcpTools);
    }
    if (req.sessionId) {
      flags.push("--resume", req.sessionId);
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
          code: "EMPTY_OUTPUT",
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
          code: events.length === 0 ? "MALFORMED_JSON" : "NO_RESULT_EVENT",
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
          code: "TOKEN_COUNT_MISSING",
          message: "Claude CLI result missing usage.input_tokens/output_tokens (D3 violation)",
          raw: truncateForError(raw),
        },
      };
    }

    // Accumulate tool_use blocks from ALL assistant events — not just the last.
    // In multi-turn agentic sessions claude-cli emits one assistant event per
    // turn; tool calls in early turns would be invisible if we only scanned
    // lastAssistant (harness#295).
    let lastAssistant: ClaudeJsonEvent | undefined;
    const toolCalls: { name: string; args: Record<string, unknown>; result: unknown }[] = [];
    let assistantEventCount = 0;
    for (const e of events) {
      if (e.type === "assistant") {
        lastAssistant = e;
        assistantEventCount++;
        if (e.message?.content) {
          for (const block of e.message.content) {
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
      }
    }

    // v0.7.0 (harness#293): capture session_id for resume. Claude CLI
    // emits it on the system/init event AND echoes it on the result
    // event; either is fine. Prefer the result event since it's the
    // one we already pinned for usage extraction.
    const sessionId =
      typeof resultEvent.session_id === "string"
        ? resultEvent.session_id
        : (events.find((e) => e.type === "system" && typeof e.session_id === "string")
            ?.session_id ?? undefined);

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
      steps: Math.max(1, assistantEventCount),
      ...(sessionId !== undefined ? { sessionId } : {}),
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
