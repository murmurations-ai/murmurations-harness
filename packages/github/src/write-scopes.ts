/**
 * Write-scope enforcement for `@murmurations-ai/github` mutations.
 *
 * Per ADR-0017 §4 and §9: enforcement is client-level, default-deny.
 * Absent `writeScopes` on the client config means every mutation
 * method returns `GithubWriteScopeError`.
 *
 * Glob syntax is deliberately tiny (ADR-0017 §4):
 *   - `**`   — any number of path segments including zero
 *   - `*`    — any characters within a single segment (no slash)
 *   - literals
 *
 * `?`, `{a,b}`, `[abc]` throw at compile time. No `minimatch` dep.
 */
export interface GithubWriteScopes {
  readonly issueComments: readonly string[]; // "owner/repo"
  readonly branchCommits: readonly {
    readonly repo: string; // "owner/repo"
    readonly paths: readonly string[]; // glob patterns
  }[];
  readonly labels: readonly string[]; // reserved; not enforced in 2D
  readonly issues: readonly string[]; // "owner/repo"
}

export type WriteScopeKind = "issue-comment" | "branch-commit" | "issue" | "label";

/**
 * Compiled form of a `GithubWriteScopes` — globs are pre-compiled to
 * anchored `RegExp`s once at client construction, so per-call checks
 * are literal-equality + regex tests.
 */
export interface CompiledWriteScopes {
  readonly issueComments: ReadonlySet<string>;
  readonly branchCommits: ReadonlyMap<string, readonly RegExp[]>;
  readonly labels: ReadonlySet<string>;
  readonly issues: ReadonlySet<string>;
}

export const compileWriteScopes = (scopes: GithubWriteScopes): CompiledWriteScopes => {
  const branchCommits = new Map<string, readonly RegExp[]>();
  for (const entry of scopes.branchCommits) {
    branchCommits.set(entry.repo, entry.paths.map(compileGlob));
  }
  return {
    issueComments: new Set(scopes.issueComments),
    branchCommits,
    labels: new Set(scopes.labels),
    issues: new Set(scopes.issues),
  };
};

/**
 * Compile a glob pattern to an anchored RegExp. Rejects unsupported
 * metacharacters at construction time so misconfiguration surfaces
 * loudly rather than silently allowing or denying at runtime.
 */
export const compileGlob = (pattern: string): RegExp => {
  for (const ch of pattern) {
    if (ch === "?" || ch === "[" || ch === "]" || ch === "{" || ch === "}") {
      throw new Error(
        `unsupported glob metacharacter "${ch}" in "${pattern}" (only **, *, and literals are supported)`,
      );
    }
  }

  let re = "^";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      // `**` matches any number of path segments including zero. We
      // also swallow a trailing `/` so that "notes/**" matches both
      // "notes/a.md" and (vacuously) "notes".
      if (pattern[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 3;
      } else {
        re += ".*";
        i += 2;
      }
      continue;
    }
    if (ch === "*") {
      // Single `*` matches within a segment — no slashes.
      re += "[^/]*";
      i += 1;
      continue;
    }
    // Literal — escape regex metacharacters.
    re += (ch ?? "").replace(/[.+^$()|\\]/g, "\\$&");
    i += 1;
  }
  re += "$";
  return new RegExp(re);
};

export const matchesRepoPath = (compiled: readonly RegExp[] | undefined, path: string): boolean => {
  if (!compiled) return false;
  for (const rx of compiled) {
    if (rx.test(path)) return true;
  }
  return false;
};
