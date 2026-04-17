/**
 * Spirit client — loads an LLM session, runs a turn against the
 * operator's input, and surfaces the response plus a cost annotation.
 *
 * The Spirit inherits the murmuration's default LLM from
 * `harness.yaml` (`llm.provider` + optional `llm.model`). A future
 * Phase 2 `spirit.md` file may override this per-murmuration.
 *
 * Phase 1: non-streaming. Session state is in-process only; REPL
 * detach drops it.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { makeSecretKey, makeSecretValue, type SecretValue } from "@murmurations-ai/core";
import {
  createLLMClient,
  providerEnvKeyName,
  type LLMClient,
  type LLMClientConfig,
  type LLMMessage,
} from "@murmurations-ai/llm";
import { DotenvSecretsProvider } from "@murmurations-ai/secrets-dotenv";

import { loadHarnessConfig, type HarnessLLMConfig, type LLMProvider } from "../harness-config.js";
import { buildSpiritSystemPrompt } from "./system-prompt.js";
import { buildSpiritTools } from "./tools.js";

interface SocketResponse {
  readonly id: string;
  readonly result?: unknown;
  readonly error?: string;
}

type Send = (method: string, params?: Record<string, unknown>) => Promise<SocketResponse>;

export interface SpiritSession {
  turn(message: string): Promise<SpiritTurnResult>;
  readonly provider: LLMProvider;
  readonly model: string;
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

/** Balanced-tier models per provider when the harness config does not pin a
 *  specific model. Matches `@murmurations-ai/llm` tiers table. */
const DEFAULT_MODEL: Record<LLMProvider, string> = {
  anthropic: "claude-sonnet-4-5-20250929",
  gemini: "gemini-2.5-pro",
  openai: "gpt-4o",
  ollama: "llama3.2",
};

/** Rough per-provider pricing ($ per million tokens, input / output). Used
 *  only for the REPL cost annotation — not authoritative. */
const PRICING: Record<LLMProvider, { readonly input: number; readonly output: number }> = {
  anthropic: { input: 3.0, output: 15.0 },
  gemini: { input: 1.25, output: 5.0 },
  openai: { input: 2.5, output: 10.0 },
  ollama: { input: 0, output: 0 },
};

/** Resolve the API key for a provider. Reads `<rootDir>/.env` first,
 *  falls back to `process.env`. Returns `null` for Ollama (no key). */
const resolveProviderToken = async (
  provider: LLMProvider,
  rootDir: string,
): Promise<SecretValue | null | undefined> => {
  const keyName = providerEnvKeyName(provider);
  if (!keyName) return null; // Ollama and anything else keyless

  const secretKey = makeSecretKey(keyName);
  const envPath = join(rootDir, ".env");

  if (existsSync(envPath)) {
    const providerSecrets = new DotenvSecretsProvider({ envPath });
    try {
      await providerSecrets.load({ required: [], optional: [secretKey] });
      if (providerSecrets.has(secretKey)) return providerSecrets.get(secretKey);
    } catch {
      /* malformed .env or permission issue — fall through */
    }
  }

  const fromEnv = process.env[keyName];
  if (fromEnv) return makeSecretValue(fromEnv);
  return undefined;
};

/** Build the LLMClientConfig for a resolved provider + token. */
const buildLLMConfig = (
  llm: HarnessLLMConfig,
  token: SecretValue | null,
  model: string,
): LLMClientConfig => {
  if (llm.provider === "ollama") return { provider: "ollama", token: null, model };
  if (!token) {
    const keyName = providerEnvKeyName(llm.provider) ?? "an LLM API key";
    throw new SpiritUnavailableError(
      `Spirit needs ${keyName} in .env or the environment for provider "${llm.provider}".`,
    );
  }
  return { provider: llm.provider, token, model };
};

/**
 * Initialise a Spirit session for the current REPL attach.
 *
 * Reads `harness.yaml` for the default provider and model. Resolves the
 * provider's API key from `<rootDir>/.env` (preferred) or the process
 * environment. Throws {@link SpiritUnavailableError} on any shortfall.
 */
export const initSpiritSession = async (opts: SpiritInitOptions): Promise<SpiritSession> => {
  const { rootDir, send } = opts;

  const harness = await loadHarnessConfig(rootDir);
  const model = harness.llm.model ?? DEFAULT_MODEL[harness.llm.provider];

  const token = await resolveProviderToken(harness.llm.provider, rootDir);
  if (token === undefined) {
    const keyName = providerEnvKeyName(harness.llm.provider) ?? "an LLM API key";
    throw new SpiritUnavailableError(
      `Spirit needs ${keyName} for provider "${harness.llm.provider}" — set it in .env or the environment.`,
    );
  }

  const client: LLMClient = createLLMClient(buildLLMConfig(harness.llm, token, model));

  const systemPrompt = await buildSpiritSystemPrompt();
  const tools = buildSpiritTools({ rootDir, send });

  const history: LLMMessage[] = [];
  const pricing = PRICING[harness.llm.provider];

  const turn = async (message: string): Promise<SpiritTurnResult> => {
    history.push({ role: "user", content: message });

    const result = await client.complete({
      model,
      messages: history,
      systemPromptOverride: systemPrompt,
      maxOutputTokens: 4096,
      temperature: 0.2,
      tools,
      maxSteps: 8,
    });

    if (!result.ok) {
      history.pop();
      throw new Error(`Spirit LLM error: ${result.error.code} — ${result.error.message}`);
    }

    history.push({ role: "assistant", content: result.value.content });

    const inputTokens = result.value.inputTokens;
    const outputTokens = result.value.outputTokens;
    const estimatedCostUsd =
      (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;

    return {
      content: result.value.content,
      inputTokens,
      outputTokens,
      toolCallCount: result.value.toolCalls?.length ?? 0,
      estimatedCostUsd,
    };
  };

  return { turn, provider: harness.llm.provider, model };
};
