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

import { parseDotEnv } from "./dotenv.js";
import { loadHarnessConfig } from "./harness-config.js";
import {
  classifyStaleIssues,
  fetchOpenIssues,
  DEFAULT_AGE_DAYS,
  DEFAULT_SILENCE_DAYS,
  type StaleIssue,
  type StaleReason,
  type StaleScanOptions,
} from "./stale-issues.js";

// Re-export the shared types so callers (including the existing test
// file) can keep importing them from this module unchanged.
export {
  classifyStaleIssues,
  type StaleIssue,
  type StaleReason,
  type StaleScanCandidate,
  type StaleScanOptions,
} from "./stale-issues.js";

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
  const issues = await fetchOpenIssues(repo, token, "murmuration-list-stale-issues");
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
