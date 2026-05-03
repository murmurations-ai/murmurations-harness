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
  createSubscriptionCliClient,
  formatLLMError,
  ProviderRegistry,
  type LLMClient,
  type LLMClientConfig,
  type LLMMessage,
} from "@murmurations-ai/llm";
import { DotenvSecretsProvider } from "@murmurations-ai/secrets-dotenv";

import { buildBuiltinProviderRegistry } from "../builtin-providers/index.js";
import {
  loadHarnessConfig,
  type HarnessLLMConfig,
  type LLMProvider,
  type SubscriptionCliPermissionMode,
  type SubscriptionCli,
} from "../harness-config.js";
import { writeSpiritMcpConfig } from "./mcp-config.js";
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
  /**
   * True when the tool loop exhausted maxSteps before the model
   * produced a final text message. When this is set the operator
   * sees an empty response; the REPL should surface a hint.
   */
  readonly truncated: boolean;
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
 *  specific model. Matches `@murmurations-ai/llm` tiers table. The
 *  `subscription-cli` entry is a placeholder — the cli-specific default in
 *  {@link DEFAULT_CLI_MODEL} is used instead when provider is subscription-cli. */
const DEFAULT_MODEL: Record<LLMProvider, string> = {
  anthropic: "claude-sonnet-4-5-20250929",
  gemini: "gemini-2.5-pro",
  openai: "gpt-4o",
  ollama: "llama3.2",
  "subscription-cli": "claude-sonnet-4-6",
};

/** Default model per subscription CLI when harness.yaml does not pin one. */
const DEFAULT_CLI_MODEL: Record<SubscriptionCli, string> = {
  claude: "claude-sonnet-4-6",
  codex: "gpt-4o",
  gemini: "gemini-2.5-pro",
};

const DEFAULT_SUBSCRIPTION_CLI_PERMISSION_MODE: SubscriptionCliPermissionMode = "restricted";

/** Rough per-provider pricing ($ per million tokens, input / output). Used
 *  only for the REPL cost annotation — not authoritative. Subscription-cli
 *  is $0 marginal cost (paid via the operator's subscription). */
const PRICING: Record<LLMProvider, { readonly input: number; readonly output: number }> = {
  anthropic: { input: 3.0, output: 15.0 },
  gemini: { input: 1.25, output: 5.0 },
  openai: { input: 2.5, output: 10.0 },
  ollama: { input: 0, output: 0 },
  "subscription-cli": { input: 0, output: 0 },
};

/** Resolve the API key for a provider. Reads `<rootDir>/.env` first,
 *  falls back to `process.env`. Returns `null` when the provider is
 *  declared keyless on the registry (e.g. local Ollama). */
const resolveProviderToken = async (
  registry: ProviderRegistry,
  provider: LLMProvider,
  rootDir: string,
): Promise<SecretValue | null | undefined> => {
  const keyName = registry.envKeyName(provider);
  if (keyName === null) return null; // keyless provider
  if (keyName === undefined) return undefined; // provider not registered — caller reports

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
  registry: ProviderRegistry,
  llm: HarnessLLMConfig,
  token: SecretValue | null,
  model: string,
): LLMClientConfig => {
  const providerDef = registry.get(llm.provider);
  if (providerDef?.envKeyName === null) {
    return { registry, provider: llm.provider, token: null, model };
  }
  if (!token) {
    const keyName = providerDef?.envKeyName ?? "an LLM API key";
    throw new SpiritUnavailableError(
      `Spirit needs ${keyName} in .env or the environment for provider "${llm.provider}".`,
    );
  }
  return { registry, provider: llm.provider, token, model };
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

  let client: LLMClient;
  let model: string;
  let useApiTools: boolean;

  if (harness.llm.provider === "subscription-cli") {
    const cli: SubscriptionCli = harness.llm.cli ?? "claude";
    model = harness.llm.model ?? DEFAULT_CLI_MODEL[cli];

    // Claude is the only CLI with `--mcp-config` support today (ADR-0038).
    // Codex/gemini fall through without an MCP bridge — they can converse
    // but cannot invoke harness-internal tools yet.
    const mcpConfigPath = cli === "claude" ? writeSpiritMcpConfig(rootDir) : undefined;

    client = createSubscriptionCliClient({
      cli,
      model,
      permissionMode: harness.llm.permissionMode ?? DEFAULT_SUBSCRIPTION_CLI_PERMISSION_MODE,
      ...(mcpConfigPath !== undefined ? { mcpConfigPath } : {}),
    });
    // The CLI runs its own tool loop (via MCP for claude). We MUST NOT pass
    // Vercel-style tool definitions to the subprocess adapter — they would
    // be silently dropped, and worse, double-counted against `maxSteps`.
    useApiTools = false;
  } else {
    const registry = buildBuiltinProviderRegistry();
    const providerDef = registry.get(harness.llm.provider);
    if (!providerDef) {
      throw new SpiritUnavailableError(
        `Spirit needs provider "${harness.llm.provider}" — not registered (check harness.yaml llm.provider).`,
      );
    }
    model =
      harness.llm.model ??
      registry.resolveModelForTier(harness.llm.provider, "balanced") ??
      DEFAULT_MODEL[harness.llm.provider];

    const token = await resolveProviderToken(registry, harness.llm.provider, rootDir);
    if (token === undefined) {
      const keyName = providerDef.envKeyName ?? "an LLM API key";
      throw new SpiritUnavailableError(
        `Spirit needs ${keyName} for provider "${harness.llm.provider}" — set it in .env or the environment.`,
      );
    }

    client = createLLMClient(buildLLMConfig(registry, harness.llm, token, model));
    useApiTools = true;
  }

  const systemPrompt = await buildSpiritSystemPrompt();
  const tools = useApiTools ? buildSpiritTools({ rootDir, send }) : undefined;

  const history: LLMMessage[] = [];
  const pricing = PRICING[harness.llm.provider];

  const turn = async (message: string): Promise<SpiritTurnResult> => {
    history.push({ role: "user", content: message });

    const maxSteps = harness.spirit.maxSteps;
    const result = await client.complete({
      model,
      messages: history,
      systemPromptOverride: systemPrompt,
      maxOutputTokens: 4096,
      temperature: 0.2,
      ...(tools ? { tools, maxSteps } : {}),
    });

    if (!result.ok) {
      history.pop();
      throw new Error(`\n${formatLLMError(result.error, { agentId: "spirit", model })}`);
    }

    history.push({ role: "assistant", content: result.value.content });

    const inputTokens = result.value.inputTokens;
    const outputTokens = result.value.outputTokens;
    const estimatedCostUsd =
      (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
    const toolCallCount = result.value.toolCalls?.length ?? 0;
    // Truncation detection only meaningful on the API path: Vercel SDK
    // reports finishReason="tool-calls" (→ "tool_use") when stepCountIs
    // fires mid-loop. Subscription-cli runs its own loop; we can't see it.
    const truncated =
      tools !== undefined &&
      toolCallCount >= maxSteps &&
      result.value.stopReason === "tool_use" &&
      result.value.content.trim().length === 0;

    return {
      content: result.value.content,
      inputTokens,
      outputTokens,
      toolCallCount,
      estimatedCostUsd,
      truncated,
    };
  };

  return { turn, provider: harness.llm.provider, model };
};
