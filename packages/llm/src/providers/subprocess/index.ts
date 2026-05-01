/**
 * Subscription-CLI provider family — public exports.
 *
 * ADR-0034: subscription-CLI provider family.
 *
 * Operators select the CLI via two-field config:
 *   llm:
 *     provider: subscription-cli
 *     cli: claude | gemini | codex
 *     model: claude-sonnet-4-6   # optional
 *     timeoutMs: 90000            # optional
 *
 * Routing through the operator's local CLI uses subscription auth
 * (Claude Pro/Max, Google subscription, ChatGPT subscription) instead
 * of per-token API billing. $0 marginal cost at the operator.
 */

export type {
  AuthError,
  AuthStatus,
  ParseError,
  SpawnError,
  SubprocessError,
  SubprocessLLMAdapter,
  TimeoutError,
} from "./types.js";

export { SubprocessAdapter } from "./base-client.js";
export type { SubprocessAdapterConfig } from "./base-client.js";

export { ClaudeCliAdapter } from "./adapters/claude.js";
export { GeminiCliAdapter } from "./adapters/gemini.js";
export { CodexCliAdapter } from "./adapters/codex.js";

import type { CallOptions, LLMClient } from "../../client.js";
import type { LLMCostHook } from "../../cost-hook.js";
import type { LLMClientError } from "../../errors.js";
import type { LLMClientCapabilities, LLMRequest, LLMResponse, Result } from "../../types.js";

import { SubprocessAdapter } from "./base-client.js";
import { ClaudeCliAdapter } from "./adapters/claude.js";
import { CodexCliAdapter } from "./adapters/codex.js";
import { GeminiCliAdapter } from "./adapters/gemini.js";
import type { SubprocessLLMAdapter } from "./types.js";

// ---------------------------------------------------------------------------
// Factory — bypasses the ProviderRegistry path because subscription-CLI
// providers don't return a Vercel LanguageModel from create(). They wrap a
// subprocess directly. The resulting LLMClient is interchangeable with a
// registry-built one from the daemon's perspective.
// ---------------------------------------------------------------------------

export type SubscriptionCli = "claude" | "gemini" | "codex";

export interface SubscriptionCliClientConfig {
  readonly cli: SubscriptionCli;
  /** Model to record in `LLMResponse.modelUsed`. CLI defaults if blank. */
  readonly model: string;
  /** Optional cost hook (token usage telemetry). $0 marginal cost path. */
  readonly defaultCostHook?: LLMCostHook;
  /** Wall-clock subprocess timeout. Default: 90_000 ms. */
  readonly timeoutMs?: number;
  /** Override the per-CLI adapter (for tests or custom CLIs). */
  readonly cliAdapter?: SubprocessLLMAdapter;
  /** Override capabilities (for tests). */
  readonly capabilities?: LLMClientCapabilities;
}

const buildAdapter = (cli: SubscriptionCli): SubprocessLLMAdapter => {
  switch (cli) {
    case "claude":
      return new ClaudeCliAdapter();
    case "gemini":
      return new GeminiCliAdapter();
    case "codex":
      return new CodexCliAdapter();
  }
};

/**
 * Build an {@link LLMClient} backed by a subscription-CLI subprocess.
 *
 * Use this in place of `createLLMClient` when `provider: subscription-cli`
 * is configured in role.md / harness.yaml. The returned client implements
 * the same interface; the daemon doesn't need to know which factory built it.
 */
export const createSubscriptionCliClient = (config: SubscriptionCliClientConfig): LLMClient => {
  const cliAdapter = config.cliAdapter ?? buildAdapter(config.cli);
  const adapter = new SubprocessAdapter(config.model, {
    cliAdapter,
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.capabilities !== undefined ? { capabilities: config.capabilities } : {}),
  });
  const defaultHook = config.defaultCostHook;

  return {
    async complete(
      request: LLMRequest,
      options?: CallOptions,
    ): Promise<Result<LLMResponse, LLMClientError>> {
      const costHook = options?.costHook ?? defaultHook;
      return adapter.complete(request, {
        ...(costHook ? { costHook } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.idempotencyKey !== undefined
          ? { idempotencyKey: options.idempotencyKey }
          : {}),
        ...(options?.telemetryContext ? { telemetryContext: options.telemetryContext } : {}),
      });
    },
    capabilities(): LLMClientCapabilities {
      return adapter.capabilities;
    },
  };
};
