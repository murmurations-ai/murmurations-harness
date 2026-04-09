#!/usr/bin/env node
/**
 * hello-world-agent
 *
 * The simplest possible agent the harness can wake. No LLM, no identity
 * doc reading, no signal reasoning. Phase 1A only — proves the wake
 * loop is structurally correct.
 *
 * The executor gives us the spawn context via MURMURATION_SPAWN_CONTEXT
 * env var and expects structured output on stdout using the Phase 1A
 * protocol defined in packages/core/src/execution/subprocess.ts
 * (parseChildOutput):
 *
 *   ::wake-summary:: <line>         — contributes to the wake summary
 *   ::governance::<kind>:: <json>   — emits a governance event
 */

const wakeId = process.env.MURMURATION_WAKE_ID ?? "<unknown-wake>";
const agentId = process.env.MURMURATION_AGENT_ID ?? "<unknown-agent>";

const contextJson = process.env.MURMURATION_SPAWN_CONTEXT;
let contextSummary = "(no spawn context)";
if (contextJson) {
  try {
    const parsed = JSON.parse(contextJson);
    contextSummary = `identity layers=[${parsed?.identity?.layerKinds?.join(",") ?? "?"}], signalCount=${parsed?.signals?.count ?? 0}, wakeReason=${parsed?.wakeReason?.kind ?? "?"}`;
  } catch {
    contextSummary = "(unparseable spawn context)";
  }
}

process.stdout.write(`::wake-summary:: hello from agent ${agentId}, wake ${wakeId}\n`);
process.stdout.write(`::wake-summary:: spawn context observed: ${contextSummary}\n`);
process.stdout.write(
  `::wake-summary:: the harness wake loop is structurally proven for this wake.\n`,
);

// Exit cleanly so the executor reports completed outcome.
process.exit(0);
