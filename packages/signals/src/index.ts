/**
 * @murmurations-ai/signals
 *
 * Default {@link SignalAggregator} implementation for the Murmuration
 * Harness. Composes github + filesystem sources. See
 * `docs/adr/0013-signal-aggregator.md`.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import {
  ACTION_ITEM_LABEL,
  SCOPE_ALL_LABEL,
  assignedLabel,
  buildAgentRoutingLabels,
  isAssignedLabel,
  isGroupProposalLabel,
  isScopeLabel,
  makeAgentId,
  type AgentId,
  type Signal,
  type SignalAggregationFailure,
  type SignalTrustLevel,
} from "@murmurations-ai/core";
import type {
  SignalAggregationContext,
  SignalAggregationResult,
  SignalAggregator,
  SignalAggregatorCapabilities,
  SignalSourceId,
} from "@murmurations-ai/core";
import type {
  GithubClient,
  GithubIssue,
  ListIssuesFilter,
  RepoCoordinate,
} from "@murmurations-ai/github";

import { composeBundle, filterDoneItems, type ClassifierContext } from "./priority.js";

// ---------------------------------------------------------------------------
// Public config + caps
// ---------------------------------------------------------------------------

export interface GithubSignalScope {
  readonly repo: RepoCoordinate;
  readonly filter?: ListIssuesFilter;
  /**
   * Labels with OR-semantics: an issue matches if any one of these
   * labels is present (combined with the AND-set in `filter.labels`).
   * Implemented as multiple `listIssues` queries client-side because
   * GitHub's API only supports AND. Used by the daemon to inject
   * membership-aware routing labels (assigned, scope:agent, scope:group,
   * scope:all) per agent — see `buildAgentRoutingLabels` in
   * `@murmurations-ai/core`.
   *
   * When unset, falls through to a single query with `filter.labels`.
   */
  readonly anyLabel?: readonly string[];
  /** If true, signals start at "trusted". Otherwise "semi-trusted". */
  readonly trusted?: boolean;
  /**
   * When set, any `scope:all`-tagged issue whose `authorLogin` is NOT
   * in this list is downgraded to `untrusted`. Protects against
   * non-agent actors (bots, external collaborators) writing scope:all
   * labels to broadcast to every agent. Back-compat: when absent, no
   * downgrade occurs. Sec M1 defense-in-depth (harness#339).
   */
  readonly scopeAllTrustedAuthors?: readonly string[];
  /**
   * When true AND `scopeAllTrustedAuthors` is set, `scope:all` issues
   * from untrusted authors are dropped entirely rather than downgraded.
   */
  readonly dropScopeAllFromUntrusted?: boolean;
}

export interface AggregatorCaps {
  readonly total: number;
  readonly githubIssue: number;
  readonly privateNote: number;
  readonly inboxMessage: number;
}

export const DEFAULT_AGGREGATOR_CAPS: AggregatorCaps = {
  total: 50,
  githubIssue: 15,
  privateNote: 10,
  inboxMessage: 10,
};

/** Minimal CollaborationProvider interface for signal collection (ADR-0021). */
export interface SignalCollaborationProvider {
  collectSignals(filter?: {
    state?: string;
    labels?: readonly string[];
  }): Promise<readonly Signal[]>;
}

export interface DefaultSignalAggregatorConfig {
  readonly github?: GithubClient;
  readonly githubScopes?: readonly GithubSignalScope[];
  readonly rootDir: string;
  readonly caps?: Partial<AggregatorCaps>;
  readonly now?: () => Date;
  readonly trustedSenderAgentIds?: readonly string[];
  /** CollaborationProvider for local item signals (ADR-0021). */
  readonly collaborationProvider?: SignalCollaborationProvider;
  /**
   * v0.7.0 (ADR-0042): replace flat "15 most-recent" with priority-
   * tiered bundle composition. Default false to preserve pre-v0.7.0
   * behavior for direct callers. The daemon enables it for every
   * agent in v0.7.0 — operators don't need to set this themselves.
   */
  readonly priorityBundle?: boolean;
  /**
   * v0.7.0 (Workstream H): hook the wake-end `done_when` validator
   * output into bundle composition. Returns the set of signal ids
   * that have been verified done at wake-start; the aggregator
   * filters them out before tiering. Returning undefined / empty
   * Set is the safe no-op.
   */
  readonly getDoneSignalIds?: (agentId: AgentId) => Promise<ReadonlySet<string>>;
  /**
   * v0.7.0: hook to surface issues where the agent is currently
   * named in an active consent round. Used by the priority
   * classifier to promote those issues to the `high` tier.
   * Returning undefined / empty Set leaves them in `normal`.
   */
  readonly getActiveConsentRoundIssueNumbers?: (agentId: AgentId) => Promise<ReadonlySet<number>>;
  /**
   * Maximum concurrent GitHub requests during `anyLabel` fan-out
   * (Sec L1 / harness#342). Default: 4. Operators with strict
   * rate-limit budgets can lower this; operators on GitHub Enterprise
   * with generous rate limits can raise it. The outer scope loop
   * remains sequential — this cap is only for the inner label fan-out.
   */
  readonly fanOutParallelism?: number;
}

// ---------------------------------------------------------------------------
// v0.7.0 — priority-tiered bundle composer (ADR-0042)
// ---------------------------------------------------------------------------

export * from "./priority.js";

// ---------------------------------------------------------------------------
// Text hygiene — bounds + control-char scrub
// ---------------------------------------------------------------------------

/**
 * Default policy: pass full signal content through to the agent. Modern
 * LLM context windows (≥1M tokens for current frontier models) make
 * 500-char-style summary truncation more harmful than helpful — it
 * silently corrupts authoritative content (live case 2026-04-30: a
 * 2800-char source-directive lost its per-agent task definitions and
 * agents honestly reported "the signal excerpt is missing details").
 *
 * The caps below are runaway-payload guards, not summarization. They
 * fire only on extreme content (e.g., a malformed source dumping a
 * binary blob into an issue body). When a real summary IS needed —
 * that is, when an agent genuinely cannot use the full content — the
 * right shape is LLM-driven summarization, NOT substring slicing with
 * a `[...]` suffix. Slicing produces incoherent excerpts that drop
 * critical detail; summarization preserves intent.
 *
 * Tracked as a follow-up: replace `sanitizeText` slice fallback with
 * an LLM summarizer once an aggregator-side LLM client is available.
 */
const EXCERPT_MAX_CHARS = 64_000;
const SUMMARY_MAX_CHARS = 8_000;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

const sanitizeText = (text: string, maxChars: number): string => {
  const stripped = text.replace(CONTROL_RE, "").trim();
  if (stripped.length <= maxChars) return stripped;
  return `${stripped.slice(0, maxChars)}\n\n[...]`;
};

// ---------------------------------------------------------------------------
// DefaultSignalAggregator
// ---------------------------------------------------------------------------

export class DefaultSignalAggregator implements SignalAggregator {
  readonly #config: DefaultSignalAggregatorConfig;
  readonly #caps: AggregatorCaps;
  readonly #now: () => Date;
  readonly #trustedSenders: Set<string>;

  public constructor(config: DefaultSignalAggregatorConfig) {
    this.#config = config;
    this.#caps = { ...DEFAULT_AGGREGATOR_CAPS, ...config.caps };
    this.#now = config.now ?? ((): Date => new Date());
    this.#trustedSenders = new Set(config.trustedSenderAgentIds ?? []);
  }

  public capabilities(): SignalAggregatorCapabilities {
    const sources: SignalSourceId[] = [];
    if (this.#config.github && this.#config.githubScopes && this.#config.githubScopes.length > 0) {
      sources.push("github-issue");
    }
    sources.push("private-note", "inbox-message");
    return {
      id: "default",
      displayName: "Default Signal Aggregator",
      version: "0.0.0-phase1b-d",
      activeSources: sources,
      totalCap: this.#caps.total,
    };
  }

  public async aggregate(context: SignalAggregationContext): Promise<SignalAggregationResult> {
    const warnings: string[] = [];
    const partialFailures: SignalAggregationFailure[] = [];
    const signals: Signal[] = [];

    const results = await Promise.allSettled([
      this.#collectGithub(context, warnings, partialFailures),
      this.#collectPrivateNotes(context, warnings),
      this.#collectInboxMessages(context, warnings),
      this.#collectCollaborationItems(),
    ]);

    const names: readonly SignalSourceId[] = [
      "github-issue",
      "private-note",
      "inbox-message",
      "local-item",
    ];
    for (const [idx, r] of results.entries()) {
      if (r.status === "fulfilled") {
        signals.push(...r.value);
      } else {
        const sourceName = names[idx] ?? "unknown";
        warnings.push(
          `signal source ${sourceName} failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
        );
      }
    }

    // v0.7.0 (ADR-0042) — priority-tiered bundle composition.
    //
    // When enabled (default), the aggregator filters done items via
    // the wake-end validator hook (Workstream H), classifies the
    // remainder into 4 tiers via composeBundle, and emits the
    // top-N respecting per-tier + total caps. Falls back to the
    // legacy flat truncation when priorityBundle is explicitly false.
    const priorityEnabled = this.#config.priorityBundle ?? false;
    let finalSignals: readonly Signal[];
    if (priorityEnabled) {
      const doneIds = (await this.#config.getDoneSignalIds?.(context.agentId)) ?? new Set();
      const consentRoundIssues =
        (await this.#config.getActiveConsentRoundIssueNumbers?.(context.agentId)) ?? new Set();
      const candidates = doneIds.size > 0 ? filterDoneItems(signals, doneIds) : signals;
      const filteredCount = signals.length - candidates.length;
      const classifierCtx: ClassifierContext = {
        selfAgentId: context.agentId.value,
        wakeStartedAt: context.now,
        isFacilitator: context.agentId.value === "facilitator-agent",
        activeConsentRoundIssueNumbers: consentRoundIssues,
        issuesFiledBySelf: new Set(),
      };
      const bundle = composeBundle(candidates, classifierCtx, {
        totalCap: this.#caps.total,
      });
      finalSignals = bundle.signals;
      if (filteredCount > 0) {
        warnings.push(
          `priority bundle: ${String(filteredCount)} done items excluded by wake-end validator`,
        );
      }
      if (bundle.droppedCount > 0) {
        warnings.push(
          `priority bundle: ${String(bundle.droppedCount)} candidates dropped to fit cap (critical=${String(bundle.counts.critical)} high=${String(bundle.counts.high)} normal=${String(bundle.counts.normal)} low=${String(bundle.counts.low)})`,
        );
      }
    } else if (signals.length > this.#caps.total) {
      const dropped = signals.length - this.#caps.total;
      signals.length = this.#caps.total;
      warnings.push(
        `bundle truncated to ${String(this.#caps.total)} signals (total cap); dropped ${String(dropped)} from tail`,
      );
      finalSignals = signals;
    } else {
      finalSignals = signals;
    }

    // Partition action items assigned to this agent
    const agentIdValue = context.agentId.value;
    const actionItems = finalSignals.filter((s) => {
      if (s.kind !== "github-issue") return false;
      const labels = (s as unknown as { labels: readonly string[] }).labels;
      return labels.includes(ACTION_ITEM_LABEL) && labels.includes(assignedLabel(agentIdValue));
    });

    return {
      ok: true,
      bundle: {
        wakeId: context.wakeId,
        assembledAt: this.#now(),
        signals: finalSignals,
        actionItems,
        warnings,
        partialFailures,
      },
    };
  }

  // ---------------------------------------------------------------------
  // GitHub source
  // ---------------------------------------------------------------------

  async #collectGithub(
    context: SignalAggregationContext,
    warnings: string[],
    partialFailures: SignalAggregationFailure[],
  ): Promise<readonly Signal[]> {
    const client = this.#config.github;
    const scopes = this.#config.githubScopes ?? [];
    if (!client || scopes.length === 0) return [];

    // Per-issue dedup across multi-query fan-out: a single issue may
    // match multiple `anyLabel` queries on the same scope (e.g. an
    // issue labeled both `assigned:foo` AND `scope:all` shows up in
    // both queries). Key by repo+number so multi-repo scopes don't
    // collide. We collect the *raw* issue + its trust level so we can
    // sort the merged set by `updatedAt` (deterministic, recency-first)
    // before applying the per-source cap — older `assigned:` items
    // would otherwise crowd out newer `scope:agent:<self>` directives
    // because fan-out queries returned them in collection order
    // (QA review of harness#331).
    const seen = new Set<string>();
    const raw: { readonly issue: GithubIssue; readonly trust: SignalTrustLevel }[] = [];
    const baseFilter = (scope: GithubSignalScope): ListIssuesFilter => ({
      perPage: Math.min(this.#caps.githubIssue + 5, 30),
      ...(scope.filter ?? {}),
    });
    const recordIssues = async (
      scope: GithubSignalScope,
      filter: ListIssuesFilter,
      anyLabel: string | undefined,
    ): Promise<void> => {
      const result = await client.listIssues(scope.repo, filter);
      const repoCoord = `${scope.repo.owner.value}/${scope.repo.name.value}`;
      if (!result.ok) {
        warnings.push(`github source: ${repoCoord} failed (${result.error.code})`);
        partialFailures.push({
          source: "github",
          repo: repoCoord,
          ...(anyLabel !== undefined ? { anyLabel } : {}),
          code: result.error.code,
          detail: result.error.message,
        });
        return;
      }
      const baseTrust: SignalTrustLevel = scope.trusted === true ? "trusted" : "semi-trusted";
      for (const issue of result.value) {
        const key = `${issue.repo.owner.value}/${issue.repo.name.value}#${String(issue.number.value)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // Sec M1: scope:all provenance check. If the scope declares
        // trusted authors and this issue carries scope:all, verify the
        // author is in the allowlist. Untrusted authors get downgraded
        // (or dropped if dropScopeAllFromUntrusted is set).
        if (
          scope.scopeAllTrustedAuthors !== undefined &&
          issue.labels.includes(SCOPE_ALL_LABEL) &&
          !scope.scopeAllTrustedAuthors.includes(issue.authorLogin)
        ) {
          if (scope.dropScopeAllFromUntrusted === true) continue;
          raw.push({ issue, trust: "untrusted" });
          continue;
        }
        raw.push({ issue, trust: baseTrust });
      }
    };

    for (const scope of scopes) {
      const baseFilterForScope = baseFilter(scope);
      if (scope.anyLabel === undefined || scope.anyLabel.length === 0) {
        // Single-query fast path — no OR semantics needed.
        await recordIssues(scope, baseFilterForScope, undefined);
        continue;
      }
      // Fan-out: one query per anyLabel value. Each query AND-combines
      // the existing labels filter (if any) with the OR-label.
      // Sec L1 / harness#342: cap concurrent GitHub requests via a
      // worker-pool pattern. JavaScript continuations are atomic so the
      // shared `seen` Set needs no locking.
      const baseLabels = baseFilterForScope.labels ?? [];
      const concurrency = Math.max(1, this.#config.fanOutParallelism ?? 4);
      const queue = scope.anyLabel.map((orLabel) => ({
        filter: {
          ...baseFilterForScope,
          labels: [...baseLabels, orLabel],
        } satisfies ListIssuesFilter,
        orLabel,
      }));
      let qi = 0;
      const worker = async (): Promise<void> => {
        while (qi < queue.length) {
          const item = queue[qi++];
          if (item === undefined) break;
          await recordIssues(scope, item.filter, item.orLabel);
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
    }

    // Sort by recency before applying the cap so the most-recent-N is
    // what survives, regardless of which fan-out query produced them.
    // Tie-breaker on `(repo, number)` keeps the order stable across
    // ties so two runs with identical input produce identical output.
    raw.sort((a, b) => {
      const ta = a.issue.updatedAt.getTime();
      const tb = b.issue.updatedAt.getTime();
      if (ta !== tb) return tb - ta; // DESC by updatedAt
      const repoA = `${a.issue.repo.owner.value}/${a.issue.repo.name.value}`;
      const repoB = `${b.issue.repo.owner.value}/${b.issue.repo.name.value}`;
      if (repoA !== repoB) return repoA.localeCompare(repoB);
      return b.issue.number.value - a.issue.number.value; // DESC by issue number
    });

    // Filter out issues that carry routing labels (assigned:* or scope:*)
    // that belong to a different agent BEFORE applying the cap. Filtering
    // first ensures the githubIssue cap applies to the agent-relevant pool,
    // not the merged cross-agent pool (harness#353). Issues with NO routing
    // labels pass through — they carry operational metadata (priority:*, bug,
    // etc.) that every agent should see. Uses isAssignedLabel/isScopeLabel
    // from the labels module so the predicate stays in sync with any future
    // label vocabulary additions.
    const agentRoutingSet = new Set(
      buildAgentRoutingLabels(
        context.agentId.value,
        context.groupMemberships.map((g) => g.value),
      ),
    );
    const agentFiltered = raw.filter(({ issue }) => {
      const routingLabels = issue.labels.filter(
        (l) => isAssignedLabel(l) || isScopeLabel(l) || isGroupProposalLabel(l),
      );
      if (routingLabels.length === 0) return true;
      return routingLabels.some((l) => agentRoutingSet.has(l));
    });
    if (agentFiltered.length < raw.length) {
      warnings.push(
        `github-issue source: filtered ${String(raw.length - agentFiltered.length)} out-of-scope issue(s) for agent ${context.agentId.value}`,
      );
    }

    let kept: typeof agentFiltered = agentFiltered;
    if (agentFiltered.length > this.#caps.githubIssue) {
      kept = agentFiltered.slice(0, this.#caps.githubIssue);
      warnings.push(
        `github-issue source truncated to ${String(this.#caps.githubIssue)} of ${String(agentFiltered.length)} matches (cap, sorted by updatedAt desc)`,
      );
    }

    // harness#350: fetch comments for issues that have them so agents see
    // Source answers posted as comments, not just the original body.
    // Comments are wrapped in <untrusted-comment> tags so agents can distinguish
    // user-contributed content from harness-structured signals (prompt injection
    // boundary). Each comment fetch requests exactly MAX_COMMENTS_PER_ISSUE
    // entries so we never pay for more than we use.
    const MAX_COMMENTS_PER_ISSUE = 20;
    const enrichedBodies = new Map<string, string>();
    const issuesWithComments = kept.filter(({ issue }) => issue.commentCount > 0);
    if (issuesWithComments.length > 0) {
      await Promise.all(
        issuesWithComments.map(async ({ issue }) => {
          const key = `${issue.repo.owner.value}/${issue.repo.name.value}#${String(issue.number.value)}`;
          const result = await client.listIssueComments(issue.repo, issue.number, {
            perPage: MAX_COMMENTS_PER_ISSUE,
          });
          if (!result.ok) {
            warnings.push(
              `github-issue source: failed to fetch comments for ${key} (${result.error.code}); falling back to body-only`,
            );
            return;
          }
          const comments = result.value.slice(0, MAX_COMMENTS_PER_ISSUE);
          if (comments.length === 0) return;
          const shown = comments.length;
          const truncationNote =
            issue.commentCount > shown
              ? ` — showing first ${String(shown)} of ${String(issue.commentCount)}`
              : "";
          const commentSection = comments
            .map((c) => {
              const date = c.createdAt.toISOString().split("T")[0] ?? "";
              return `<untrusted-comment author="@${c.authorLogin}" date="${date}">\n${c.body}\n</untrusted-comment>`;
            })
            .join("\n\n");
          const bodyPart = issue.body ?? "";
          enrichedBodies.set(
            key,
            `${bodyPart}\n\n---\n**Comments (${String(shown)}${truncationNote}):**\n\n${commentSection}`,
          );
        }),
      );
    }

    return kept.map(({ issue, trust }) => {
      const key = `${issue.repo.owner.value}/${issue.repo.name.value}#${String(issue.number.value)}`;
      return issueToSignal(issue, trust, context.now, enrichedBodies.get(key));
    });
  }

  // ---------------------------------------------------------------------
  // Private-note source
  // ---------------------------------------------------------------------

  async #collectPrivateNotes(
    context: SignalAggregationContext,
    warnings: string[],
  ): Promise<readonly Signal[]> {
    const notesRoot = resolve(this.#config.rootDir, "agents", context.agentDir, "notes");
    const files = await listMarkdownFiles(notesRoot, warnings, "private-note");
    if (files.length === 0) return [];

    const mutable = [...files];
    mutable.sort((a, b) => b.mtime - a.mtime);
    const capped = mutable.slice(0, this.#caps.privateNote);

    const out: Signal[] = [];
    for (const f of capped) {
      try {
        const content = await readFile(f.path, "utf8");
        const firstPara = extractFirstParagraph(content);
        out.push({
          kind: "private-note",
          id: `private-note:${f.basename}`,
          trust: "trusted",
          fetchedAt: context.now,
          path: f.path,
          summary: sanitizeText(firstPara, SUMMARY_MAX_CHARS),
        });
      } catch (cause) {
        warnings.push(`private-note source: failed to read ${f.path}: ${String(cause)}`);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // Inbox source
  // ---------------------------------------------------------------------

  async #collectInboxMessages(
    context: SignalAggregationContext,
    warnings: string[],
  ): Promise<readonly Signal[]> {
    const inboxRoot = resolve(this.#config.rootDir, "agents", context.agentDir, "inbox");
    const files = await listMarkdownFiles(inboxRoot, warnings, "inbox-message");
    if (files.length === 0) return [];

    const mutable = [...files];
    mutable.sort((a, b) => a.mtime - b.mtime);
    const capped = mutable.slice(0, this.#caps.inboxMessage);

    const out: Signal[] = [];
    for (const f of capped) {
      try {
        const content = await readFile(f.path, "utf8");
        const { fromAgentSlug } = parseInboxFilename(f.basename);
        const trust: SignalTrustLevel = this.#trustedSenders.has(fromAgentSlug)
          ? "trusted"
          : "semi-trusted";
        const excerpt = sanitizeText(content, EXCERPT_MAX_CHARS);
        out.push({
          kind: "inbox-message",
          id: `inbox-message:${f.basename}`,
          trust,
          fetchedAt: context.now,
          fromAgent: safeMakeAgentId(fromAgentSlug),
          path: f.path,
          excerpt,
        });
      } catch (cause) {
        warnings.push(`inbox source: failed to read ${f.path}: ${String(cause)}`);
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Collaboration provider items (ADR-0021)
  // -------------------------------------------------------------------------

  async #collectCollaborationItems(): Promise<Signal[]> {
    if (!this.#config.collaborationProvider) return [];
    try {
      const signals = await this.#config.collaborationProvider.collectSignals({ state: "open" });
      return [...signals];
    } catch {
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TITLE_MAX_CHARS = 200;
const LABEL_MAX_CHARS = 100;

const issueToSignal = (
  issue: GithubIssue,
  trust: SignalTrustLevel,
  fetchedAt: Date,
  enrichedBody?: string,
): Signal => ({
  kind: "github-issue",
  id: `github-issue:${issue.repo.owner.value}/${issue.repo.name.value}#${String(issue.number.value)}`,
  trust,
  fetchedAt,
  number: issue.number.value,
  title: sanitizeText(issue.title, TITLE_MAX_CHARS),
  url: issue.htmlUrl,
  labels: issue.labels.map((l) => sanitizeText(l, LABEL_MAX_CHARS)),
  excerpt: sanitizeText(enrichedBody ?? issue.body ?? "", EXCERPT_MAX_CHARS),
});

const listMarkdownFiles = async (
  dir: string,
  warnings: string[],
  sourceName: string,
): Promise<
  readonly { readonly path: string; readonly basename: string; readonly mtime: number }[]
> => {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (cause) {
    if (isEnoent(cause)) return [];
    warnings.push(`${sourceName} source: cannot read ${dir}: ${String(cause)}`);
    return [];
  }
  const canonicalDir = resolve(dir) + sep;
  const out: { path: string; basename: string; mtime: number }[] = [];
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const full = join(dir, name);
    const canonical = resolve(full);
    if (!canonical.startsWith(canonicalDir)) {
      warnings.push(`${sourceName} source: path escapes sandbox, skipped: ${full}`);
      continue;
    }
    try {
      const info = await stat(full);
      out.push({ path: full, basename: name, mtime: info.mtimeMs });
    } catch (cause) {
      warnings.push(`${sourceName} source: stat failed ${full}: ${String(cause)}`);
    }
  }
  return out;
};

const isEnoent = (err: unknown): boolean => {
  if (typeof err !== "object" || err === null) return false;
  return (err as { code?: unknown }).code === "ENOENT";
};

const extractFirstParagraph = (text: string): string => {
  let body = text;
  if (body.startsWith("---")) {
    const end = body.indexOf("\n---", 3);
    if (end > -1) body = body.slice(end + 4);
  }
  const paragraphs = body.split(/\n\s*\n/);
  for (const p of paragraphs) {
    const trimmed = p.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "";
};

const parseInboxFilename = (
  basename: string,
): { readonly fromAgentSlug: string; readonly timestamp: string | null } => {
  const withoutExt = basename.replace(/\.md$/, "");
  const parts = withoutExt.split("__");
  if (parts.length >= 2 && parts[0] !== undefined && parts[1] !== undefined) {
    return { fromAgentSlug: parts[0], timestamp: parts[1] };
  }
  return { fromAgentSlug: withoutExt, timestamp: null };
};

const safeMakeAgentId = (slug: string): AgentId => {
  try {
    return makeAgentId(slug);
  } catch {
    return { kind: "agent-id", value: slug };
  }
};
