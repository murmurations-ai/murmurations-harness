/**
 * `murmuration list-stale-issues` — read-only inventory of open GitHub
 * issues bloating every watching agent's SignalBundle.
 *
 * harness#394 scope 3: the diagnostic sibling of the `murmuration doctor`
 * hygiene check (scope 1). Where doctor surfaces "you have N stale
 * issues" as a single line in the report, this command lists them
 * outright so an operator can decide what to close. Replaces the manual
 * `python + gh issue close` loop run on 2026-05-21.
 *
 * Closure is NOT in scope (operator judgement on each issue). A
 * `--close` mutation flag is a separate, deliberate follow-up.
 *
 * Output:
 *   - Default: human-readable table (number, age, last-activity, reason, title)
 *   - `--json`: machine-readable array for scripting
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { loadHarnessConfig } from "./harness-config.js";

// ---------------------------------------------------------------------------
// Heuristics (duplicates doctor.ts scope-1 classifier; intentional —
// the two PRs ship independently and can be deduped in a follow-up.)
// ---------------------------------------------------------------------------

const DIGEST_TITLE_PATTERNS: readonly RegExp[] = [
  /^\s*\[?\s*DIGEST\s*\]?/i,
  /^\s*\[?\s*FINANCE\s*\]?/i,
  /^\s*\[?\s*STATUS\s*\]?/i,
  /^\s*\[?\s*REPORT\s*\]?/i,
  /^\s*\[?\s*KICKOFF\s*\]?/i,
];

const DEFAULT_AGE_DAYS = 14;
const DEFAULT_SILENCE_DAYS = 7;

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

/** Pure classifier — given a list of open issues, partition into the
 *  stale set. Exported so tests don't need an HTTP fixture. */
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
  // Sort: oldest activity first (most urgent to review).
  return out.sort((a, b) => b.silenceDays - a.silenceDays);
};

// ---------------------------------------------------------------------------
// GitHub fetch (same shape as doctor.ts; capped pagination)
// ---------------------------------------------------------------------------

export interface StaleScanCandidate {
  readonly number: number;
  readonly title: string;
  readonly htmlUrl: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface RestIssueResponse {
  readonly number: number;
  readonly title: string;
  readonly html_url: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly pull_request?: unknown;
}

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

const splitRepo = (repo: string): { owner: string; name: string } | null => {
  const slash = repo.indexOf("/");
  if (slash <= 0 || slash === repo.length - 1) return null;
  return { owner: repo.slice(0, slash), name: repo.slice(slash + 1) };
};

const fetchOpenIssues = async (
  repo: string,
  token: string,
): Promise<readonly StaleScanCandidate[]> => {
  const parts = splitRepo(repo);
  if (!parts) throw new Error(`invalid collaboration.repo: "${repo}" (expected "owner/name")`);
  const collected: StaleScanCandidate[] = [];
  const maxPages = 5;
  for (let page = 1; page <= maxPages; page++) {
    const url = `https://api.github.com/repos/${parts.owner}/${parts.name}/issues?state=open&per_page=100&page=${String(page)}`;
    const res = await withTimeout(
      fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "murmuration-list-stale-issues",
        },
      }),
      10_000,
      `GitHub GET /issues page ${String(page)}`,
    );
    if (!res.ok) {
      throw new Error(`${String(res.status)} ${res.statusText}`);
    }
    const body: unknown = await res.json();
    if (!Array.isArray(body)) break;
    const items = body as RestIssueResponse[];
    for (const it of items) {
      if (it.pull_request !== undefined) continue;
      collected.push({
        number: it.number,
        title: it.title,
        htmlUrl: it.html_url,
        createdAt: new Date(it.created_at),
        updatedAt: new Date(it.updated_at),
      });
    }
    if (items.length < 100) break;
  }
  return collected;
};

// ---------------------------------------------------------------------------
// .env reader (same shape as doctor.ts; small enough to inline)
// ---------------------------------------------------------------------------

const parseDotEnv = (content: string): Map<string, string> => {
  const map = new Map<string, string>();
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    map.set(key, value);
  }
  return map;
};

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export interface ListStaleIssuesOptions extends StaleScanOptions {
  readonly rootDir: string;
  readonly json?: boolean;
}

export interface ListStaleIssuesReport {
  readonly repo: string;
  readonly scannedAt: string;
  readonly thresholdDays: { readonly age: number; readonly silence: number };
  readonly issues: readonly StaleIssue[];
}

/** Library entry — returns a structured report or throws on
 *  configuration errors. The CLI wrapper handles formatting. */
export const runListStaleIssues = async (
  options: ListStaleIssuesOptions,
): Promise<ListStaleIssuesReport> => {
  const rootDir = resolve(options.rootDir);
  const harness = await loadHarnessConfig(rootDir);
  if (harness.collaboration.provider !== "github") {
    throw new Error(
      `list-stale-issues requires collaboration.provider: "github" (current: ${harness.collaboration.provider}). Local-mode murmurations have no GitHub issues to scan.`,
    );
  }
  const repo = harness.collaboration.repo;
  if (!repo) {
    throw new Error(
      `collaboration.repo not configured in murmuration/harness.yaml. Set it to "owner/name" so the scan knows where to look.`,
    );
  }
  const envPath = join(rootDir, ".env");
  if (!existsSync(envPath)) {
    throw new Error(`.env not found at ${envPath}. Cannot authenticate to GitHub without a token.`);
  }
  const env = parseDotEnv(await readFile(envPath, "utf8"));
  const token = env.get("GITHUB_TOKEN");
  if (!token || token.length === 0 || token === "ghp_your-token-here") {
    throw new Error(`GITHUB_TOKEN is not set in .env. Cannot authenticate.`);
  }
  const issues = await fetchOpenIssues(repo, token);
  const stale = classifyStaleIssues(issues, options);
  return {
    repo,
    scannedAt: (options.now ?? new Date()).toISOString(),
    thresholdDays: {
      age: options.ageDays ?? DEFAULT_AGE_DAYS,
      silence: options.silenceDays ?? DEFAULT_SILENCE_DAYS,
    },
    issues: stale,
  };
};

const formatTable = (report: ListStaleIssuesReport): string => {
  const lines: string[] = [];
  lines.push("");
  lines.push(`Stale open issues in ${report.repo}`);
  lines.push(
    `  thresholds: age > ${String(report.thresholdDays.age)}d, silence > ${String(report.thresholdDays.silence)}d`,
  );
  lines.push("");
  if (report.issues.length === 0) {
    lines.push("  (no stale issues found — your signal bundle is clean)");
    lines.push("");
    return lines.join("\n");
  }
  // Column widths sized to typical 80-col terminal.
  const reasonLabel: Record<StaleReason, string> = {
    "by-age": "age",
    "digest-pattern": "digest",
    both: "age+digest",
  };
  for (const issue of report.issues) {
    const num = `#${String(issue.number)}`.padEnd(6);
    const age = `${String(issue.ageDays)}d`.padStart(5);
    const silence = `${String(issue.silenceDays)}d`.padStart(5);
    const reason = reasonLabel[issue.reason].padEnd(11);
    const title = issue.title.length > 50 ? `${issue.title.slice(0, 47)}...` : issue.title;
    lines.push(`  ${num} age:${age}  silent:${silence}  ${reason}  ${title}`);
  }
  lines.push("");
  lines.push(`  ${String(report.issues.length)} stale issue(s).`);
  lines.push(
    `  Review and close once consumed; see docs/CONVENTIONS-GITHUB-VS-FILES.md for the rationale.`,
  );
  lines.push("");
  return lines.join("\n");
};

export const runListStaleIssuesCli = async (options: ListStaleIssuesOptions): Promise<number> => {
  let report: ListStaleIssuesReport;
  try {
    report = await runListStaleIssues(options);
  } catch (err) {
    console.error(`list-stale-issues: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          repo: report.repo,
          scannedAt: report.scannedAt,
          thresholdDays: report.thresholdDays,
          issues: report.issues.map((i) => ({
            number: i.number,
            title: i.title,
            htmlUrl: i.htmlUrl,
            createdAt: i.createdAt.toISOString(),
            updatedAt: i.updatedAt.toISOString(),
            ageDays: i.ageDays,
            silenceDays: i.silenceDays,
            reason: i.reason,
          })),
        },
        null,
        2,
      ),
    );
  } else {
    console.log(formatTable(report));
  }
  return 0;
};
