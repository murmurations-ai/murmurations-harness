/**
 * @murmuration/core
 *
 * Core runtime for the Murmuration Harness.
 *
 * Phase 1A: execution (AgentExecutor interface + SubprocessExecutor),
 * scheduler (TimerScheduler), daemon (wiring), signals (aggregator
 * stub), and governance (plugin stub).
 *
 * Spec: https://github.com/xeeban/emergent-praxis/blob/main/docs/MURMURATION-HARNESS-SPEC.md
 */

export * from "./execution/index.js";
export * from "./execution/subprocess.js";
export * from "./scheduler/index.js";
export * from "./signals/index.js";
export * from "./governance/index.js";
export * from "./identity/index.js";
export * from "./daemon/index.js";
