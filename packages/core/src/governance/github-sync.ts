/**
 * GovernanceGitHubSync — syncs governance state to GitHub issues.
 *
 * Creates GitHub issues for new governance items, swaps labels on
 * state transitions, and posts decision records as closing comments.
 * The GovernanceStateStore calls this on every create/transition
 * when a sync is configured.
 *
 * This is the GitHub-as-System-of-Record implementation for
 * governance (Phase 1.2 of the execution plan).
 */

import type {
  GovernanceItem,
  GovernanceStateTransition,
  GovernanceDecisionRecord,
} from "./index.js";

/**
 * Minimal GitHub client interface — just what governance sync needs.
 * Avoids importing the full @murmurations-ai/github package into core.
 * The CLI wires the real GithubClient at boot.
 */
export interface GovernanceSyncGitHub {
  createIssue(input: {
    readonly title: string;
    readonly body: string;
    readonly labels: readonly string[];
  }): Promise<{ ok: boolean; issueNumber?: number; htmlUrl?: string; error?: string }>;

  createIssueComment(issueNumber: number, body: string): Promise<{ ok: boolean; error?: string }>;

  addLabels?(
    issueNumber: number,
    labels: readonly string[],
  ): Promise<{ ok: boolean; error?: string }>;

  removeLabels?(
    issueNumber: number,
    labels: readonly string[],
  ): Promise<{ ok: boolean; error?: string }>;

  closeIssue?(issueNumber: number): Promise<{ ok: boolean; error?: string }>;
}

export interface GovernanceGitHubSyncConfig {
  readonly github: GovernanceSyncGitHub;
  /** Group ID for labelling. */
  readonly defaultGroup?: string;
}

/**
 * Sync governance events to GitHub. Fire-and-forget — errors are
 * logged but never block governance operations.
 */
export class GovernanceGitHubSync {
  readonly #github: GovernanceSyncGitHub;
  readonly #defaultGroup: string | undefined;
  /** Map governance item ID → GitHub issue number for comments. */
  readonly #issueMap = new Map<string, number>();

  public constructor(config: GovernanceGitHubSyncConfig) {
    this.#github = config.github;
    this.#defaultGroup = config.defaultGroup;
  }

  /** Read-only view of the governance item ID → GitHub issue number mapping. */
  public get issueMap(): ReadonlyMap<string, number> {
    return this.#issueMap;
  }

  /** Create a GitHub issue for a new governance item. Returns the issue URL. */
  public async onCreate(item: GovernanceItem): Promise<string | undefined> {
    try {
      const payload = typeof item.payload === "object" && item.payload !== null ? item.payload : {};
      const topic =
        (payload as { topic?: string }).topic ?? (payload as { action?: string }).action ?? "";

      const labels = [
        `governance:${item.kind}`,
        `state:${item.currentState}`,
        `agent:${item.createdBy.value}`,
      ];
      if (this.#defaultGroup) labels.push(`group:${this.#defaultGroup}`);

      const body = [
        `**Filed by:** ${item.createdBy.value}`,
        `**Kind:** ${item.kind}`,
        `**State:** ${item.currentState}`,
        item.reviewAt ? `**Review date:** ${item.reviewAt.toISOString().slice(0, 10)}` : "",
        "",
        topic ? `## Driver\n\n${topic}` : "",
        "",
        `---`,
        `_Tracked by the Murmuration Harness governance state machine. Item ID: ${item.id}_`,
      ]
        .filter(Boolean)
        .join("\n");

      const result = await this.#github.createIssue({
        title: `[${item.kind.toUpperCase()}] ${topic.slice(0, 80) || item.kind}`,
        body,
        labels,
      });

      if (result.ok && result.issueNumber) {
        this.#issueMap.set(item.id, result.issueNumber);
        return result.htmlUrl;
      }
    } catch {
      // Fire-and-forget — governance operations never block on GitHub
    }
    return undefined;
  }

  /** Post a comment, swap state labels, and close if terminal. */
  public async onTransition(
    item: GovernanceItem,
    transition: GovernanceStateTransition,
    isTerminal?: boolean,
  ): Promise<void> {
    try {
      const issueNumber = this.#issueMap.get(item.id);
      if (!issueNumber) return;

      const comment = [
        `**State transition:** ${transition.from} → ${transition.to}`,
        `**Triggered by:** ${transition.triggeredBy}`,
        transition.reason ? `**Reason:** ${transition.reason}` : "",
        `**At:** ${transition.at.toISOString()}`,
      ]
        .filter(Boolean)
        .join("\n");

      await this.#github.createIssueComment(issueNumber, comment);

      // Swap state labels: remove old, add new
      if (this.#github.removeLabels) {
        await this.#github.removeLabels(issueNumber, [`state:${transition.from}`]);
      }
      if (this.#github.addLabels) {
        await this.#github.addLabels(issueNumber, [`state:${transition.to}`]);
      }

      // Close the issue when the item reaches a terminal state
      if (isTerminal && this.#github.closeIssue) {
        await this.#github.closeIssue(issueNumber);
      }
    } catch {
      // Fire-and-forget — governance operations never block on GitHub
    }
  }

  /** Post a decision record as a closing comment. */
  public async onDecision(record: GovernanceDecisionRecord): Promise<void> {
    try {
      const issueNumber = this.#issueMap.get(record.itemId);
      if (!issueNumber) return;

      const comment = [
        `## Decision Record`,
        "",
        `**Final state:** ${record.finalState}`,
        `**Decided:** ${record.decidedAt.toISOString().slice(0, 10)}`,
        record.reviewAt ? `**Review date:** ${record.reviewAt.toISOString().slice(0, 10)}` : "",
        `**Summary:** ${record.summary}`,
        "",
        `### History`,
        ...record.history.map(
          (h) =>
            `- ${h.from} → ${h.to} (${h.triggeredBy}, ${h.at.toISOString().slice(0, 16)})${h.reason ? `: ${h.reason}` : ""}`,
        ),
      ]
        .filter(Boolean)
        .join("\n");

      await this.#github.createIssueComment(issueNumber, comment);
    } catch {
      // Fire-and-forget
    }
  }
}
