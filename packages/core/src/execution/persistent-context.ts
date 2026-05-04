/**
 * PersistentContextExecutor — maintains a conversation history across
 * agent wakes, enabling accumulated understanding over time.
 *
 * ADR-0019: Persistent context agents.
 *
 * Key behaviors:
 * - First wake (cold start): full identity + signals → LLM → persist
 * - Subsequent wakes (warm): load history + signal deltas → LLM → persist
 * - Context compaction: summarize older turns at configurable threshold
 * - Falls back to cold start on corrupted/missing conversation file
 *
 * This executor wraps the InProcessExecutor's runner pattern but manages
 * the message array across wakes instead of starting fresh each time.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

// ---------------------------------------------------------------------------
// Conversation storage types
// ---------------------------------------------------------------------------

export interface ConversationMessage {
  readonly role: "system" | "user" | "assistant" | "compaction";
  readonly content: string;
  readonly ts: string;
  readonly wakeId?: string | undefined;
  readonly tokenCount?: number | undefined;
}

export interface PersistentContextConfig {
  /** Maximum context tokens before triggering compaction. */
  readonly maxContextTokens: number;
  /** Token threshold at which to start compacting. */
  readonly summarizeAt: number;
}

const DEFAULT_CONFIG: PersistentContextConfig = {
  maxContextTokens: 200_000,
  summarizeAt: 150_000,
};

// ---------------------------------------------------------------------------
// Conversation store
// ---------------------------------------------------------------------------

export class ConversationStore {
  readonly #path: string;
  readonly #sessionPath: string;
  #messages: ConversationMessage[] = [];
  #totalTokens = 0;
  #sessionId: string | undefined;

  public constructor(agentDir: string) {
    this.#path = join(agentDir, "conversation.jsonl");
    this.#sessionPath = join(agentDir, "session.json");
  }

  public get messages(): readonly ConversationMessage[] {
    return this.#messages;
  }

  public get totalTokens(): number {
    return this.#totalTokens;
  }

  public get isEmpty(): boolean {
    return this.#messages.length === 0;
  }

  /**
   * v0.7.0 (harness#293 J2): the subscription-CLI session id captured
   * on the most recent wake. Daemons pass this to the next wake's
   * LLMRequest so the CLI keeps its prompt cache warm across wakes.
   * Undefined when no wake has run yet or the previous wake's
   * provider didn't surface one (direct API providers don't).
   */
  public get sessionId(): string | undefined {
    return this.#sessionId;
  }

  /**
   * Update the captured session id and persist immediately.
   * Called by the executor after a wake completes; idempotent
   * for repeated identical values.
   */
  public async setSessionId(sessionId: string | undefined): Promise<void> {
    if (sessionId === this.#sessionId) return;
    this.#sessionId = sessionId;
    await this.#persistSession();
  }

  /** Load conversation history from disk. Returns false if no file exists. */
  public async load(): Promise<boolean> {
    try {
      const content = await readFile(this.#path, "utf8");
      this.#messages = [];
      this.#totalTokens = 0;
      for (const line of content.trim().split("\n")) {
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as ConversationMessage;
          this.#messages.push(msg);
          this.#totalTokens += msg.tokenCount ?? 0;
        } catch {
          /* skip malformed lines */
        }
      }
    } catch {
      // No conversation file — first wake. sessionId restoration
      // below still proceeds in case session.json predates the
      // conversation (uncommon but possible if file copying ran
      // partially).
    }
    // Best-effort restore of the captured session id. Absent file
    // is normal (first wake or pre-v0.7.0 conversations).
    try {
      const raw = await readFile(this.#sessionPath, "utf8");
      const parsed = JSON.parse(raw) as { sessionId?: unknown };
      if (typeof parsed.sessionId === "string" && parsed.sessionId.length > 0) {
        this.#sessionId = parsed.sessionId;
      }
    } catch {
      // sibling file missing or malformed → leave sessionId undefined
    }
    return this.#messages.length > 0;
  }

  /** Append a message and persist to disk. */
  public async append(msg: ConversationMessage): Promise<void> {
    this.#messages.push(msg);
    this.#totalTokens += msg.tokenCount ?? 0;
    await this.#persist();
  }

  /**
   * Compact older messages by replacing them with a summary.
   * Keeps the system prompt and the last N turns intact.
   */
  public async compact(summary: string, keepLastN = 4): Promise<void> {
    if (this.#messages.length <= keepLastN + 1) return; // nothing to compact

    const systemMsg = this.#messages.find((m) => m.role === "system");
    const kept = this.#messages.slice(-keepLastN);
    const compactionMsg: ConversationMessage = {
      role: "compaction",
      content: summary,
      ts: new Date().toISOString(),
      tokenCount: Math.ceil(summary.length / 4), // rough estimate
    };

    this.#messages = [...(systemMsg ? [systemMsg] : []), compactionMsg, ...kept];
    this.#totalTokens = this.#messages.reduce((s, m) => s + (m.tokenCount ?? 0), 0);
    await this.#persist();
  }

  /** Build the message array for an LLM call (exclude compaction metadata). */
  public toLLMMessages(): { role: "system" | "user" | "assistant"; content: string }[] {
    return this.#messages
      .filter((m) => m.role !== "compaction")
      .map((m) => ({
        role: m.role === "compaction" ? ("user" as const) : m.role,
        content: m.content,
      }));
  }

  async #persist(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const lines = this.#messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
    await writeFile(this.#path, lines, "utf8");
  }

  async #persistSession(): Promise<void> {
    await mkdir(dirname(this.#sessionPath), { recursive: true });
    const payload = JSON.stringify({ sessionId: this.#sessionId ?? null });
    await writeFile(this.#sessionPath, payload, "utf8");
  }
}

// ---------------------------------------------------------------------------
// Parse config from role.md frontmatter
// ---------------------------------------------------------------------------

export const parsePersistentConfig = (
  frontmatter: Record<string, unknown>,
): PersistentContextConfig | null => {
  const executor = frontmatter.executor as Record<string, unknown> | undefined;
  if (!executor) return null;
  if (executor.mode !== "persistent") return null;

  return {
    maxContextTokens:
      typeof executor.max_context_tokens === "number"
        ? executor.max_context_tokens
        : DEFAULT_CONFIG.maxContextTokens,
    summarizeAt:
      typeof executor.summarize_at === "number"
        ? executor.summarize_at
        : DEFAULT_CONFIG.summarizeAt,
  };
};
