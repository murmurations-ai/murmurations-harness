/**
 * @murmurations-ai/core
 *
 * Core runtime for the Murmuration Harness.
 *
 * Phase 1A: execution (AgentExecutor interface + SubprocessExecutor),
 * scheduler (TimerScheduler), daemon (wiring), signals (aggregator
 * stub), and governance (plugin stub).
 *
 * Spec: https://github.com/murmurations-ai/murmurations-harness/blob/main/docs/MURMURATION-HARNESS-SPEC.md
 */

/** Harness version. Bumped on each release. */
export const HARNESS_VERSION = "0.3.5" as const;

export * from "./execution/index.js";
export * from "./execution/subprocess.js";
export * from "./execution/in-process.js";
export * from "./execution/dispatch.js";
export * from "./execution/persistent-context.js";
export * from "./scheduler/index.js";
export * from "./signals/index.js";
export * from "./governance/index.js";
export * from "./governance/github-sync.js";
export * from "./identity/index.js";
export * from "./secrets/index.js";
export * from "./cost/index.js";
export * from "./daemon/index.js";
export * from "./daemon/socket.js";
export * from "./daemon/http.js";
export * from "./daemon/events.js";
export * from "./daemon/logger.js";
export * from "./daemon/protocol.js";
// directives/index.ts removed — directives are GitHub issues now.
// The DirectiveStore was a file-based mechanism that has been replaced
// by creating GitHub issues with the "source-directive" label.
export * from "./groups/index.js";
export * from "./agents/index.js";
export * from "./strategy/index.js";
export * from "./runner/index.js";
export * from "./skills/index.js";
export * from "./collaboration/index.js";
export * from "./extensions/index.js";
export * from "./daemon/command-executor.js";
