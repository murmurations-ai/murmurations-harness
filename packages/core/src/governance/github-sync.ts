/**
 * GovernanceSync — syncs governance state to a CollaborationProvider.
 *
 * Creates items for new governance entries, swaps labels on state
 * transitions, and posts decision records as closing comments.
 * The GovernanceStateStore calls this on every create/transition
 * when a sync is configured.
 *
 * ADR-0021: uses CollaborationProvider (GitHub, Local, future GitLab,
 * etc.). Providers implement their own write-scope enforcement.
 */

import type {
  GovernanceItem,
  GovernanceStateTransition,
  GovernanceDecisionRecord,
} from "./index.js";
import type { CollaborationProvider, ItemRef } from "../collaboration/types.js";

export interface GovernanceSyncConfig {
  readonly provider: CollaborationProvider;
  /** Group ID for labelling. */
  readonly defaultGroup?: string;
}

/**
 * Sync governance events to a collaboration provider. Fire-and-forget —
 * errors are logged but never block governance operations.
 */
export class GovernanceGitHubSync {
  readonly #provider: CollaborationProvider;
  readonly #defaultGroup: string | undefined;
  /** Map governance item ID → item ref for comments. */
  readonly #itemMap = new Map<string, ItemRef>();
  /** Map governance item ID → numeric issue number (for GitHub-backed providers). */
  readonly #issueMap = new Map<string, number>();

  public constructor(config: GovernanceSyncConfig) {
    this.#provider = config.provider;
    this.#defaultGroup = config.defaultGroup;
  }

  /** Read-only view of the governance item ID → GitHub issue number mapping. */
  public get issueMap(): ReadonlyMap<string, number> {
    return this.#issueMap;
  }

  /** Read-only view of item refs (for provider-based sync). */
  public get itemMap(): ReadonlyMap<string, ItemRef> {
    return this.#itemMap;
  }

  /** Create a coordination item for a new governance item. Returns the item URL. */
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

      const title = `[${item.kind.toUpperCase()}] ${topic.slice(0, 80) || item.kind}`;

      const result = await this.#provider.createItem({ title, body, labels });
      if (result.ok) {
        this.#itemMap.set(item.id, result.value);
        this.#issueMap.set(item.id, Number(result.value.id));
        return result.value.url;
      }
    } catch {
      // Fire-and-forget — governance operations never block
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
      const ref = this.#itemMap.get(item.id);
      if (!ref) return;

      const comment = [
        `**State transition:** ${transition.from} → ${transition.to}`,
        `**Triggered by:** ${transition.triggeredBy}`,
        transition.reason ? `**Reason:** ${transition.reason}` : "",
        `**At:** ${transition.at.toISOString()}`,
      ]
        .filter(Boolean)
        .join("\n");

      await this.#provider.postComment(ref, comment);
      await this.#provider.removeLabel(ref, `state:${transition.from}`);
      await this.#provider.addLabels(ref, [`state:${transition.to}`]);
      if (isTerminal) {
        await this.#provider.updateItemState(ref, "closed");
      }
    } catch {
      // Fire-and-forget — governance operations never block
    }
  }

  /** Post a decision record as a closing comment. */
  public async onDecision(record: GovernanceDecisionRecord): Promise<void> {
    try {
      const ref = this.#itemMap.get(record.itemId);
      if (!ref) return;

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

      await this.#provider.postComment(ref, comment);
    } catch {
      // Fire-and-forget
    }
  }
}
