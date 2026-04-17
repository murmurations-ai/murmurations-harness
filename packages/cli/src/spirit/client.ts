/**
 * Spirit client — loads an LLM session, runs a turn against the
 * operator's input, and surfaces the response plus a cost annotation.
 *
 * Phase 1: non-streaming (fine for REPL latency with Sonnet). Session
 * state is in-process only; REPL detach drops it.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { makeSecretKey, makeSecretValue, type SecretValue } from "@murmurations-ai/core";
import { createLLMClient, type LLMClient, type LLMMessage } from "@murmurations-ai/llm";
import { DotenvSecretsProvider } from "@murmurations-ai/secrets-dotenv";

import { buildSpiritSystemPrompt } from "./system-prompt.js";
import { buildSpiritTools } from "./tools.js";

const ANTHROPIC_API_KEY = makeSecretKey("ANTHROPIC_API_KEY");

interface SocketResponse {
  readonly id: string;
  readonly result?: unknown;
  readonly error?: string;
}

type Send = (method: string, params?: Record<string, unknown>) => Promise<SocketResponse>;

export interface SpiritSession {
  turn(message: string): Promise<SpiritTurnResult>;
}

export interface SpiritTurnResult {
  readonly content: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly toolCallCount: number;
  readonly estimatedCostUsd: number;
}

export interface SpiritInitOptions {
  readonly rootDir: string;
  readonly send: Send;
}

export class SpiritUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SpiritUnavailableError";
  }
}

// Sonnet 4.6 approximate pricing per million tokens (USD). Spirit
// conversations are small; this is sufficient for a UI annotation.
const INPUT_PRICE_PER_MTOK = 3.0;
const OUTPUT_PRICE_PER_MTOK = 15.0;

/**
 * Initialise a Spirit session for the current REPL attach.
 *
 * Reads `ANTHROPIC_API_KEY` from `<rootDir>/.env` if present; otherwise
 * falls back to the process environment. Throws
 * {@link SpiritUnavailableError} if no key is available.
 */
export const initSpiritSession = async (opts: SpiritInitOptions): Promise<SpiritSession> => {
  const { rootDir, send } = opts;

  // Resolve the API key — .env first, env var second.
  const envPath = join(rootDir, ".env");
  let token: SecretValue | undefined;
  if (existsSync(envPath)) {
    const provider = new DotenvSecretsProvider({ envPath });
    try {
      await provider.load({ required: [], optional: [ANTHROPIC_API_KEY] });
      if (provider.has(ANTHROPIC_API_KEY)) token = provider.get(ANTHROPIC_API_KEY);
    } catch {
      /* malformed .env or permission issue — fall through to env var */
    }
  }
  if (!token) {
    const envValue = process.env.ANTHROPIC_API_KEY;
    if (envValue) token = makeSecretValue(envValue);
  }
  if (!token) {
    throw new SpiritUnavailableError(
      "Spirit needs ANTHROPIC_API_KEY — set it in .env or the environment.",
    );
  }

  const client: LLMClient = createLLMClient({
    provider: "anthropic",
    token,
    model: "claude-sonnet-4-5",
  });

  const systemPrompt = await buildSpiritSystemPrompt();
  const tools = buildSpiritTools({ rootDir, send });

  const history: LLMMessage[] = [];

  const turn = async (message: string): Promise<SpiritTurnResult> => {
    history.push({ role: "user", content: message });

    const result = await client.complete({
      model: "claude-sonnet-4-5",
      messages: history,
      systemPromptOverride: systemPrompt,
      maxOutputTokens: 4096,
      temperature: 0.2,
      tools,
      maxSteps: 8,
    });

    if (!result.ok) {
      // Roll back the user message so the next turn doesn't stack on a
      // failed context.
      history.pop();
      throw new Error(`Spirit LLM error: ${result.error.code} — ${result.error.message}`);
    }

    history.push({ role: "assistant", content: result.value.content });

    const inputTokens = result.value.inputTokens;
    const outputTokens = result.value.outputTokens;
    const estimatedCostUsd =
      (inputTokens * INPUT_PRICE_PER_MTOK + outputTokens * OUTPUT_PRICE_PER_MTOK) / 1_000_000;

    return {
      content: result.value.content,
      inputTokens,
      outputTokens,
      toolCallCount: result.value.toolCalls?.length ?? 0,
      estimatedCostUsd,
    };
  };

  return { turn };
};
