/**
 * Agent execution — pluggable boundary.
 *
 * STUB: the final AgentExecutor interface is being designed under
 * Issue #3 (AgentExecutor interface explicit). Do not rely on the
 * shape of these types. TypeScript / Runtime Agent (#24) owns closing
 * the tension before Phase 2 ends.
 *
 * Current sketch (from spec §4.1 and §7 wake loop prose):
 *   - spawn(context) → handle
 *   - waitForCompletion(handle) → result
 *   - kill(handle)
 *   - capabilities()
 *
 * Final signatures will land via Issue #3.
 */

export interface AgentId {
  readonly kind: "agent-id";
  readonly value: string;
}

/**
 * Placeholder AgentExecutor interface.
 *
 * TODO(#3): finalize signatures. Must support subprocess executor by default,
 * stub in-process executor before Phase 2 closes to prove pluggability.
 */
export interface AgentExecutor {
  readonly name: string;
  // TODO(#3): spawn, waitForCompletion, kill, capabilities
}

/**
 * Placeholder — will be replaced with concrete subprocess implementation
 * in Phase 2 one-agent proof.
 */
export const EXECUTOR_STUB_VERSION = "0.0.0-stub" as const;
