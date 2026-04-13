/**
 * Strategy Plugin — pluggable measurement framework for murmurations.
 *
 * Separate from the GovernancePlugin. Each murmuration chooses its
 * measurement approach independently of its governance model:
 *   - OKR (Objectives & Key Results)
 *   - KPI (Key Performance Indicators)
 *   - North Star (single guiding metric)
 *   - None (no formal measurement)
 *
 * The strategy plugin:
 *   - Defines objectives and how to measure them
 *   - Consumes agent metrics (artifact rate, idle rate, cost)
 *   - Produces alignment assessments for retrospectives
 *   - Suggests priority adjustments based on progress
 */

import type { AgentMetricsSnapshot } from "../groups/index.js";

// ---------------------------------------------------------------------------
// Strategy Plugin interface
// ---------------------------------------------------------------------------

/** A single objective the murmuration is tracking. */
export interface StrategyObjective {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** Target metric value (e.g. "80% artifact rate"). */
  readonly target?: string;
  /** Current measured value (populated by the plugin). */
  readonly current?: string;
  /** Progress: 0.0 to 1.0, or null if not measurable yet. */
  readonly progress: number | null;
}

/** Assessment of how well the murmuration is aligned with its objectives. */
export interface AlignmentAssessment {
  readonly objectives: readonly StrategyObjective[];
  /** Overall alignment score: 0.0 (off track) to 1.0 (fully aligned). */
  readonly overallScore: number | null;
  /** Human-readable summary for retrospective context. */
  readonly summary: string;
  /** Suggested priority adjustments based on the assessment. */
  readonly suggestions: readonly string[];
}

/** The pluggable strategy interface. */
export interface StrategyPlugin {
  readonly name: string;
  readonly version: string;

  /** Return the current objectives. Called by retrospective meetings. */
  objectives(): readonly StrategyObjective[];

  /**
   * Assess alignment given agent metrics. Called before retrospective
   * meetings to inject concrete data into the discussion.
   */
  assess(metrics: readonly AgentMetricsSnapshot[]): AlignmentAssessment;
}

// ---------------------------------------------------------------------------
// Default: no strategy (no formal measurement)
// ---------------------------------------------------------------------------

export class NoOpStrategyPlugin implements StrategyPlugin {
  public readonly name = "none";
  public readonly version = "1.0.0";

  public objectives(): readonly StrategyObjective[] {
    return [];
  }

  public assess(_metrics: readonly AgentMetricsSnapshot[]): AlignmentAssessment {
    return {
      objectives: [],
      overallScore: null,
      summary: "No strategy plugin configured. Define objectives to enable alignment tracking.",
      suggestions: [],
    };
  }
}
