/**
 * Shared stale-issue classifier (harness#394).
 *
 * Two CLI features depend on the same heuristics for "issue is bloating
 * the signal bundle":
 *   - `murmuration doctor --live` (scope 1) — emits a hygiene category
 *     finding when the count crosses an attention threshold
 *   - `murmuration list-stale-issues` (scope 3) — read-only inventory
 *
 * Both originally shipped with their own copy of the classifier (PRs
 * #399 and #401, on independent branches). This module is the dedupe.
 *
 * The "stale" rule has two independent triggers:
 *   - **by-age**: open > 14 days AND no activity in last 7 days
 *   - **digest-pattern**: title prefix matches a known noise prefix
 *     ([DIGEST]/[FINANCE]/[STATUS]/[REPORT]/[KICKOFF], case-insensitive)
 *
 * Either trigger qualifies. An issue that hits both reports `reason: "both"`.
 */

// ---------------------------------------------------------------------------
// Thresholds + heuristics
// ---------------------------------------------------------------------------

export const DEFAULT_AGE_DAYS = 14;
export const DEFAULT_SILENCE_DAYS = 7;

export const DIGEST_TITLE_PATTERNS: readonly RegExp[] = [
  /^\s*\[?\s*DIGEST\s*\]?/i,
  /^\s*\[?\s*FINANCE\s*\]?/i,
  /^\s*\[?\s*STATUS\s*\]?/i,
  /^\s*\[?\s*REPORT\s*\]?/i,
  /^\s*\[?\s*KICKOFF\s*\]?/i,
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Narrow subset of a GitHub issue the classifier needs. Kept distinct
 *  from `GithubIssue` in @murmurations-ai/github so this module is
 *  trivially testable without importing the full client types. */
export interface StaleScanCandidate {
  readonly number: number;
  readonly title: string;
  readonly htmlUrl: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type StaleReason = "by-age" | "digest-pattern" | "both";

export interface StaleIssue {
  readonly number: number;
  readonly title: string;
  readonly htmlUrl: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly ageDays: number;
  readonly silenceDays: number;
  readonly reason: StaleReason;
}

export interface StaleScanOptions {
  /** Age threshold in days (default 14). */
  readonly ageDays?: number;
  /** Comment-silence threshold in days (default 7). */
  readonly silenceDays?: number;
  /** When true, return only digest-pattern matches (skip by-age-only). */
  readonly digestOnly?: boolean;
  /** Clock override for tests. */
  readonly now?: Date;
}

// ---------------------------------------------------------------------------
// Pure classifier
// ---------------------------------------------------------------------------

/** Partition open issues into the stale set. Results are sorted with
 *  the oldest-silence-first so the most urgent review surface bubbles up. */
export const classifyStaleIssues = (
  issues: readonly StaleScanCandidate[],
  options: StaleScanOptions = {},
): readonly StaleIssue[] => {
  const ageDays = options.ageDays ?? DEFAULT_AGE_DAYS;
  const silenceDays = options.silenceDays ?? DEFAULT_SILENCE_DAYS;
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const ageThresholdMs = ageDays * 24 * 60 * 60 * 1000;
  const silenceThresholdMs = silenceDays * 24 * 60 * 60 * 1000;

  const out: StaleIssue[] = [];
  for (const issue of issues) {
    const ageMs = nowMs - issue.createdAt.getTime();
    const silenceMs = nowMs - issue.updatedAt.getTime();
    const stalledByAge = ageMs > ageThresholdMs && silenceMs > silenceThresholdMs;
    const matchesDigest = DIGEST_TITLE_PATTERNS.some((p) => p.test(issue.title));
    if (!stalledByAge && !matchesDigest) continue;
    if (options.digestOnly && !matchesDigest) continue;
    const reason: StaleReason =
      stalledByAge && matchesDigest ? "both" : stalledByAge ? "by-age" : "digest-pattern";
    out.push({
      number: issue.number,
      title: issue.title,
      htmlUrl: issue.htmlUrl,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      ageDays: Math.floor(ageMs / (24 * 60 * 60 * 1000)),
      silenceDays: Math.floor(silenceMs / (24 * 60 * 60 * 1000)),
      reason,
    });
  }
  return out.sort((a, b) => b.silenceDays - a.silenceDays);
};

/** Sugar for callers (doctor's hygiene check) that want the two-bucket
 *  view: "how many stale-by-age vs how many digest-pattern." An issue
 *  with `reason: "both"` appears in both buckets. */
export const partitionByReason = (
  issues: readonly StaleIssue[],
): {
  readonly byAge: readonly StaleIssue[];
  readonly byDigestPattern: readonly StaleIssue[];
} => {
  const byAge: StaleIssue[] = [];
  const byDigestPattern: StaleIssue[] = [];
  for (const issue of issues) {
    if (issue.reason === "by-age" || issue.reason === "both") byAge.push(issue);
    if (issue.reason === "digest-pattern" || issue.reason === "both") byDigestPattern.push(issue);
  }
  return { byAge, byDigestPattern };
};

// ---------------------------------------------------------------------------
// Network fetch (REST /repos/{owner}/{name}/issues, paginated, capped)
// ---------------------------------------------------------------------------

interface RestIssueResponse {
  readonly number: number;
  readonly title: string;
  readonly html_url: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly pull_request?: unknown;
}

/** Per-item runtime guard. The `Array.isArray(body)` check alone is not
 *  enough: a transferred issue or future REST quirk could yield items
 *  missing `created_at`, which would silently produce `new Date(undefined)`
 *  → `Invalid Date` → NaN ageDays and broken sort. */
const isRestIssueResponse = (v: unknown): v is RestIssueResponse => {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.number === "number" &&
    typeof o.title === "string" &&
    typeof o.html_url === "string" &&
    typeof o.created_at === "string" &&
    typeof o.updated_at === "string"
  );
};

const withTimeout = async <T>(promise: Promise<T>, ms: number, what: string): Promise<T> => {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => {
        reject(new Error(`timed out (${String(ms)}ms): ${what}`));
      }, ms),
    ),
  ]);
};

/** GitHub owner / repo slug grammar: alphanumerics, hyphen, underscore,
 *  period; cannot start with `.` or `-` (and `..` is rejected outright
 *  to defang any path-traversal attempt). Validating both halves prevents
 *  a malicious `harness.yaml` from redirecting our Bearer-token-bearing
 *  request to a non-GitHub host via embedded `?`, `#`, `/`, or `@`. */
const VALID_SLUG = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

const splitRepo = (repo: string): { owner: string; name: string } | null => {
  const slash = repo.indexOf("/");
  if (slash <= 0 || slash === repo.length - 1) return null;
  const owner = repo.slice(0, slash);
  const name = repo.slice(slash + 1);
  if (!VALID_SLUG.test(owner) || !VALID_SLUG.test(name)) return null;
  if (owner.includes("..") || name.includes("..")) return null;
  return { owner, name };
};

/** Bound `statusText` length when surfacing GitHub errors so a hostile
 *  upstream cannot dump arbitrarily long content into operator-facing
 *  logs. 200 chars is well past GitHub's normal reason phrases. */
const truncateStatusText = (text: string): string =>
  text.length > 200 ? `${text.slice(0, 200)}…` : text;

/** Page through open issues for `owner/name`. Caps at 5 pages (500
 *  issues) so rate-limit cost is bounded. `userAgent` distinguishes
 *  doctor's call from list-stale-issues' call in server-side logs. */
export const fetchOpenIssues = async (
  repo: string,
  token: string,
  userAgent: string,
): Promise<readonly StaleScanCandidate[]> => {
  const parts = splitRepo(repo);
  if (!parts) throw new Error(`invalid repo: "${repo}" (expected "owner/name" slug)`);
  const collected: StaleScanCandidate[] = [];
  const maxPages = 5;
  for (let page = 1; page <= maxPages; page++) {
    const url = `https://api.github.com/repos/${parts.owner}/${parts.name}/issues?state=open&per_page=100&page=${String(page)}`;
    const res = await withTimeout(
      fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": userAgent,
        },
      }),
      10_000,
      `GitHub GET /issues page ${String(page)}`,
    );
    if (!res.ok) {
      throw new Error(`${String(res.status)} ${truncateStatusText(res.statusText)}`);
    }
    const body: unknown = await res.json();
    if (!Array.isArray(body)) break;
    let pageItemCount = 0;
    for (const it of body) {
      pageItemCount++;
      if (!isRestIssueResponse(it)) continue;
      // REST /issues returns PRs alongside issues; skip them.
      if (it.pull_request !== undefined) continue;
      collected.push({
        number: it.number,
        title: it.title,
        htmlUrl: it.html_url,
        createdAt: new Date(it.created_at),
        updatedAt: new Date(it.updated_at),
      });
    }
    if (pageItemCount < 100) break;
  }
  return collected;
};
