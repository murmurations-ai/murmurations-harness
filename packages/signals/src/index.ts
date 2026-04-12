/**
 * @murmuration/signals
 *
 * Default {@link SignalAggregator} implementation for the Murmuration
 * Harness. Composes github + filesystem sources. See
 * `docs/adr/0013-signal-aggregator.md`.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { makeAgentId, type AgentId, type Signal, type SignalTrustLevel } from "@murmuration/core";
import type {
  SignalAggregationContext,
  SignalAggregationResult,
  SignalAggregator,
  SignalAggregatorCapabilities,
  SignalSourceId,
} from "@murmuration/core";
import type {
  GithubClient,
  GithubIssue,
  ListIssuesFilter,
  RepoCoordinate,
} from "@murmuration/github";

// ---------------------------------------------------------------------------
// Public config + caps
// ---------------------------------------------------------------------------

export interface GithubSignalScope {
  readonly repo: RepoCoordinate;
  readonly filter?: ListIssuesFilter;
  /** If true, signals start at "trusted". Otherwise "semi-trusted". */
  readonly trusted?: boolean;
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

export interface DefaultSignalAggregatorConfig {
  readonly github?: GithubClient;
  readonly githubScopes?: readonly GithubSignalScope[];
  readonly rootDir: string;
  readonly caps?: Partial<AggregatorCaps>;
  readonly now?: () => Date;
  readonly trustedSenderAgentIds?: readonly string[];
}

// ---------------------------------------------------------------------------
// Text hygiene — bounds + control-char scrub
// ---------------------------------------------------------------------------

const EXCERPT_MAX_CHARS = 500;
const SUMMARY_MAX_CHARS = 300;
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
    const signals: Signal[] = [];

    const results = await Promise.allSettled([
      this.#collectGithub(context, warnings),
      this.#collectPrivateNotes(context, warnings),
      this.#collectInboxMessages(context, warnings),
    ]);

    const names: readonly SignalSourceId[] = ["github-issue", "private-note", "inbox-message"];
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

    if (signals.length > this.#caps.total) {
      const dropped = signals.length - this.#caps.total;
      signals.length = this.#caps.total;
      warnings.push(
        `bundle truncated to ${String(this.#caps.total)} signals (total cap); dropped ${String(dropped)} from tail`,
      );
    }

    return {
      ok: true,
      bundle: {
        wakeId: context.wakeId,
        assembledAt: this.#now(),
        signals,
        warnings,
      },
    };
  }

  // ---------------------------------------------------------------------
  // GitHub source
  // ---------------------------------------------------------------------

  async #collectGithub(
    context: SignalAggregationContext,
    warnings: string[],
  ): Promise<readonly Signal[]> {
    const client = this.#config.github;
    const scopes = this.#config.githubScopes ?? [];
    if (!client || scopes.length === 0) return [];

    const collected: Signal[] = [];
    for (const scope of scopes) {
      const filter: ListIssuesFilter = {
        perPage: Math.min(this.#caps.githubIssue + 5, 30),
        ...(scope.filter ?? {}),
      };
      const result = await client.listIssues(scope.repo, filter);
      if (!result.ok) {
        warnings.push(
          `github source: ${scope.repo.owner.value}/${scope.repo.name.value} failed (${result.error.code})`,
        );
        continue;
      }
      const baseTrust: SignalTrustLevel = scope.trusted === true ? "trusted" : "semi-trusted";
      for (const issue of result.value) {
        collected.push(issueToSignal(issue, baseTrust, context.now));
      }
    }

    if (collected.length > this.#caps.githubIssue) {
      const total = collected.length;
      collected.length = this.#caps.githubIssue;
      warnings.push(
        `github-issue source truncated to ${String(this.#caps.githubIssue)} of ${String(total)} matches (cap)`,
      );
    }
    return collected;
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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TITLE_MAX_CHARS = 200;
const LABEL_MAX_CHARS = 100;

const issueToSignal = (issue: GithubIssue, trust: SignalTrustLevel, fetchedAt: Date): Signal => ({
  kind: "github-issue",
  id: `github-issue:${issue.repo.owner.value}/${issue.repo.name.value}#${String(issue.number.value)}`,
  trust,
  fetchedAt,
  number: issue.number.value,
  title: sanitizeText(issue.title, TITLE_MAX_CHARS),
  url: issue.htmlUrl,
  labels: issue.labels.map((l) => sanitizeText(l, LABEL_MAX_CHARS)),
  excerpt: sanitizeText(issue.body ?? "", EXCERPT_MAX_CHARS),
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
