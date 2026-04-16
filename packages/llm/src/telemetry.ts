/**
 * Optional Langfuse observability via OpenTelemetry.
 *
 * ADR-0020 Phase 4: call `initLlmTelemetry()` once at daemon startup.
 * If LANGFUSE_SECRET_KEY and LANGFUSE_PUBLIC_KEY are set, OTEL spans
 * from Vercel AI SDK's `experimental_telemetry` are forwarded to Langfuse.
 * If the keys are absent, this is a no-op — no error, no traces.
 */

import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";

let sdk: NodeSDK | undefined;

/**
 * Initialize OpenTelemetry with the Langfuse span processor.
 *
 * Call once at process startup. Safe to call multiple times (second call
 * is a no-op). Returns `true` if telemetry was initialized, `false` if
 * skipped (missing env vars or already initialized).
 *
 * Required env vars:
 * - `LANGFUSE_SECRET_KEY`
 * - `LANGFUSE_PUBLIC_KEY`
 *
 * Optional:
 * - `LANGFUSE_BASEURL` (defaults to https://cloud.langfuse.com)
 */
export const initLlmTelemetry = (): boolean => {
  if (sdk) return false; // already initialized

  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;

  if (!secretKey || !publicKey) return false;

  sdk = new NodeSDK({
    spanProcessors: [new LangfuseSpanProcessor()],
  });
  sdk.start();
  return true;
};

/**
 * Flush pending telemetry spans and shut down.
 * Call at process exit for clean shutdown.
 */
export const shutdownLlmTelemetry = async (): Promise<void> => {
  if (!sdk) return;
  await sdk.shutdown();
  sdk = undefined;
};
