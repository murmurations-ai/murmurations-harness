/**
 * Prompt boundary — Proposal 07 Phase 0 (types only, no wiring).
 *
 * `PromptBundle` is the typed, hashable, cache-aware representation of
 * everything the agent sees at wake time. Phase 2 migrates prompt
 * assembly from `DefaultRunner` into a `PromptAssembler` service that
 * produces this bundle; Phase 0 defines what that bundle looks like.
 *
 * Trust classification (ADR-003X, Phase 2):
 *   trusted     — identity, role, contract, governance, skills (harness-authored)
 *   semi-trusted — memory (agent-curated), health (harness-derived)
 *   untrusted   — signals (GitHub issue bodies), wake-task (task prompt text)
 *
 * The `cacheAnchorIndex` encodes the stable/volatile split used for
 * prompt-cache optimization (analogous to OpenClaw's SYSTEM_PROMPT_CACHE_BOUNDARY).
 * Segments at index < `cacheAnchorIndex` are stable across wakes for the same
 * agent configuration; segments at `cacheAnchorIndex` and beyond are volatile.
 */

/** One named, typed, trust-classified segment of the agent's system prompt. */
export interface PromptSegment {
  /** Stable identifier for this segment (e.g. `"identity"`, `"signals"`). */
  readonly id: string;
  /** Semantic kind — used to determine trust level and cache stability. */
  readonly kind:
    | "identity"
    | "role"
    | "wake-task"
    | "signals"
    | "memory"
    | "skills"
    | "tools"
    | "contract"
    | "governance"
    | "health";
  /** Trust level for prompt-injection defense.
   *  - `trusted`: content is harness-authored or operator-controlled.
   *  - `semi-trusted`: agent-curated or harness-derived, not externally writable.
   *  - `untrusted`: externally writable (GitHub issue bodies, task text). */
  readonly trust: "trusted" | "semi-trusted" | "untrusted";
  /** Maximum tokens this segment may consume. `undefined` = no per-segment limit. */
  readonly tokenBudget?: number;
  /** Rendered text content of this segment. */
  readonly content: string;
  /** Human-readable reference to where this content came from
   *  (e.g. `"agents/my-agent/soul.md"`, `"github:xeeban/ep#842"`). */
  readonly sourceRef?: string;
}

/** The assembled prompt bundle handed to the LLM client. Hashable,
 *  cache-aware, and fully typed so the runner does not need to
 *  reconstruct prompt semantics from raw strings. */
export interface PromptBundle {
  /** Ordered segments composing the system prompt. */
  readonly system: readonly PromptSegment[];
  /** Conversation turn messages (user/assistant history). */
  readonly messages: readonly { readonly role: string; readonly content: string }[];
  /** SHA-256 of the serialized bundle (all segment content). Recorded
   *  in the run ledger and Langfuse trace for prompt-level deduplication. */
  readonly hash: string;
  /** Estimated total token count across all segments (rough; for budget checks). */
  readonly tokenEstimate: number;
  /** Index into `system` of the last stable segment. Segments before this
   *  index are cache-stable across wakes; segments at or after are volatile.
   *  Set to `system.length` when all segments are stable (e.g., test prompts). */
  readonly cacheAnchorIndex: number;
}
