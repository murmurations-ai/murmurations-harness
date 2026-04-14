#!/usr/bin/env node
/**
 * Phase 2 step 2A11 — live Gemini smoke test.
 *
 * Loads GEMINI_API_KEY from ./examples/hello-world-agent/.env via
 * DotenvSecretsProvider (ADR-0010), constructs a Gemini LLMClient
 * (ADR-0014), fires one "say hi" completion, prints the response +
 * the cost-hook payload + the catalog-resolved USDMicros (ADR-0015).
 *
 * Run from the monorepo root after `pnpm build`:
 *
 *   node scripts/live-smoke-gemini.mjs
 *
 * Exit codes:
 *   0 — success, cost record populated
 *   1 — LLM call failed
 *   2 — secret load failed (check .env mode is 0600 and key present)
 *   3 — catalog resolution failed
 *
 * This script never writes the raw API key anywhere. The SecretValue
 * discipline from ADR-0010 guarantees the token only flows through
 * the `Authorization`/`x-goog-api-key` header inside the adapter's
 * `#buildHeaders` — one grep-checkable `reveal()` site in the whole
 * chain.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { makeSecretKey } from "@murmurations-ai/core";
import { DotenvSecretsProvider } from "@murmurations-ai/secrets-dotenv";
import { createLLMClient } from "@murmurations-ai/llm";
import { resolveLLMCost } from "@murmurations-ai/llm/pricing";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const envPath = resolve(repoRoot, "examples/hello-world-agent/.env");

const GEMINI_API_KEY = makeSecretKey("GEMINI_API_KEY");

const log = (event, data = {}) => {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), event, ...data })}\n`);
};

// --- Load secrets -------------------------------------------------

log("smoke.boot", { envPath });
const provider = new DotenvSecretsProvider({ envPath });
const loadResult = await provider.load({
  required: [GEMINI_API_KEY],
  optional: [],
});
if (!loadResult.ok) {
  log("smoke.secrets.failed", {
    code: loadResult.error.code,
    message: loadResult.error.message,
  });
  process.exit(2);
}
log("smoke.secrets.ok", { loadedCount: loadResult.loadedCount });

// --- Construct client --------------------------------------------

const costCalls = [];
const client = createLLMClient({
  provider: "gemini",
  token: provider.get(GEMINI_API_KEY),
  tier: "fast", // resolves to gemini-2.5-flash — no thinking-token budget burn
  defaultCostHook: {
    onLlmCall: (call) => {
      costCalls.push(call);
    },
  },
});
log("smoke.client.constructed", {
  provider: "gemini",
  capabilities: client.capabilities(),
});

// --- Fire one completion -----------------------------------------

const prompt =
  "Reply with exactly one short sentence confirming you are running. " +
  "Say 'Harness Phase 2A11 live smoke OK.'";

log("smoke.complete.start", { promptLength: prompt.length });
const t0 = Date.now();
const result = await client.complete({
  model: "gemini-2.5-flash",
  messages: [{ role: "user", content: prompt }],
  maxOutputTokens: 2000,
  temperature: 0.2,
});
const wallClockMs = Date.now() - t0;

if (!result.ok) {
  log("smoke.complete.failed", {
    code: result.error.code,
    status: result.error.status,
    message: result.error.message,
    provider: result.error.provider,
  });
  process.exit(1);
}

const response = result.value;
log("smoke.complete.ok", {
  wallClockMs,
  stopReason: response.stopReason,
  inputTokens: response.inputTokens,
  outputTokens: response.outputTokens,
  modelUsed: response.modelUsed,
  providerUsed: response.providerUsed,
  contentPreview: response.content.slice(0, 120),
});

// --- Cost hook payload --------------------------------------------

if (costCalls.length !== 1) {
  log("smoke.costhook.unexpected", { calls: costCalls.length });
}
const costCall = costCalls[0];
log("smoke.costhook", costCall);

// --- Pricing catalog resolution ----------------------------------

const catalogResult = resolveLLMCost({
  provider: costCall.provider,
  model: costCall.model,
  inputTokens: costCall.inputTokens,
  outputTokens: costCall.outputTokens,
  ...(costCall.cacheReadTokens !== undefined ? { cacheReadTokens: costCall.cacheReadTokens } : {}),
});

if (!catalogResult.ok) {
  log("smoke.catalog.failed", {
    code: catalogResult.error.code,
    message: catalogResult.error.message,
    model: costCall.model,
  });
  process.exit(3);
}

const costMicros = catalogResult.value.value;
const costUsd = (costMicros / 1_000_000).toFixed(6);

log("smoke.catalog.resolved", {
  costMicros,
  costUsd,
  inputTokens: costCall.inputTokens,
  outputTokens: costCall.outputTokens,
  model: costCall.model,
});

log("smoke.done", {
  ok: true,
  summary: {
    wallClockMs,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    costMicros,
    costUsd,
    modelUsed: response.modelUsed,
  },
});

console.error("\n--- Phase 2A11 live smoke SUCCEEDED ---");
console.error(
  `Response: ${response.content.trim().slice(0, 240)}${response.content.length > 240 ? "…" : ""}`,
);
console.error(
  `Tokens: ${response.inputTokens} in + ${response.outputTokens} out = ${response.inputTokens + response.outputTokens} total`,
);
console.error(`Catalog cost: $${costUsd} (${costMicros} micros)`);
console.error(
  `\nNext step (2B6 gate): open Google AI Studio → check the cost for the same call. If it's within 5% of $${costUsd}, Gemini rates in packages/llm/src/pricing/catalog.ts are verified and the PLACEHOLDER marker can be flipped to the real AI Studio URL.`,
);
