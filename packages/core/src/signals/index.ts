/**
 * Signal Aggregator — builds the signal bundle for an agent wake.
 *
 * STUB: Phase 1 scaffold only. The signal aggregator will read GitHub
 * (issues, projects, comments, labels), pipeline state, agent inbox,
 * private notes, and cost budget remaining, then compose a structured
 * signal bundle the agent reasons over during its wake (per spec §7.1
 * wake loop step 2).
 *
 * Not pluggable — core component per spec §4.1.
 *
 * Note (Security #25, carry-forward #4): signal bundle content must
 * eventually be tagged with trust_level ("trusted" for harness-generated
 * content, "untrusted" for GitHub-sourced content) before Phase 7 ship
 * to mitigate prompt injection via agent context.
 */

export interface SignalBundle {
  readonly kind: "signal-bundle";
  readonly agent: string;
  readonly wakeReason: "scheduled" | "event";
  // TODO: full shape per §7.1 step 2
  // TODO(#4): trust_level tagging per signal source
}

export interface SignalAggregator {
  readonly name: string;
  // TODO: build(agent, wakeReason) → SignalBundle
}

export const SIGNALS_STUB_VERSION = "0.0.0-stub" as const;
