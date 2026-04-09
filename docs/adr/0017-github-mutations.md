# ADR-0017 — `@murmuration/github` mutation surface

- **Status:** Accepted
- **Date:** 2026-04-09
- **Decision-maker(s):** TypeScript / Runtime Agent #24 (design), Engineering Circle (consent), Source + Claude Code (implementation)
- **Consulted:** DevOps / Release Agent #26 (implementation), Security Agent #25 (write-scope enforcement, token scrubbing), Performance / Observability Agent #27 (cost hook extension)
- **Closes:** Phase 2 P5 (harness#16), CF-github-G from ADR-0012
- **Extends:** ADR-0012 (read client), ADR-0016 (role template `github.write_scopes`)

## Context

Phase 2 Research Agent #1 posts a weekly digest to `xeeban/emergent-praxis` by (a) committing a markdown file to `notes/weekly/**` on a branch and (b) posting an issue comment linking to it. The existing `@murmuration/github` surface is read-only (ADR-0012 landed in 1B-d). We need an additive mutation surface that:

- Respects the per-agent `github.write_scopes` declared in role frontmatter (ADR-0016).
- Matches the read-side posture: native `fetch`, errors-as-values, branded primitives, cost-hook per call, `SecretValue` with a single `reveal()` site.
- Does **not** retry non-idempotent operations.
- Supports the Research #1 flow end-to-end without forcing a second round of design for common cases.

The read-side `GithubClient` interface, error taxonomy, and cost hook stay untouched. This ADR only adds.

## Decision

### §1 — Scope

**Ships in 2D:**

1. `createIssueComment(repo, issueNumber, body, options)` — REST `POST /repos/{owner}/{repo}/issues/{n}/comments`
2. `createCommitOnBranch(repo, branch, message, fileChanges, expectedHeadOid, options)` — GraphQL `createCommitOnBranch`
3. `createIssue(repo, input, options)` — REST `POST /repos/{owner}/{repo}/issues`

**Out of scope for this ADR:** `addLabels`, `closeIssue`, `updateIssueComment`, pull-request creation, multi-commit sequences, reactions, releases, webhooks, forks, GraphQL beyond `createCommitOnBranch`, idempotency keys, retry on mutation (explicitly forbidden — see §6).

### §2 — Transport split: REST for comments/issues, GraphQL for commits

**Decision: dual-transport client.**

- **Comments and issue creation ship as REST** — single call each, slots into the existing `#request` pipeline with method + body extensions.
- **`createCommitOnBranch` ships as GraphQL.** The REST equivalent is 4 sequential calls (blob → tree → commit → ref update) each needing their own error mapping. GraphQL writes blob+tree+commit+ref atomically in one round-trip and supports optimistic concurrency via `expectedHeadOid`.

New private `#requestGraphql` in `client.ts` shares `#buildHeaders`, `parseRateLimitHeaders`, `scrubCause`, and cost-hook dispatch with the existing `#request`.

`GithubCostHook` gains an optional `transport` discriminant (already present in `WakeCostBuilder.addGithubCall` per ADR-0011):

```ts
export interface GithubCostHook {
  onGithubCall(call: {
    readonly transport: "rest" | "graphql";
    readonly cacheHit?: boolean;
    readonly rateLimitRemaining?: number;
  }): void;
}
```

### §3 — Method signatures

All return `Promise<Result<T, GithubClientError>>`. All accept the same `CallOptions` as reads.

```ts
export interface GithubCreateCommentInput {
  readonly body: string;
}
export interface GithubCreatedComment {
  readonly id: number;
  readonly issueNumber: IssueNumber;
  readonly repo: RepoCoordinate;
  readonly body: string;
  readonly createdAt: Date;
  readonly htmlUrl: string;
}

export interface GithubCreateIssueInput {
  readonly title: string;
  readonly body?: string;
  readonly labels?: readonly string[];
  readonly assignees?: readonly string[];
}
export interface GithubCreatedIssue {
  readonly number: IssueNumber;
  readonly repo: RepoCoordinate;
  readonly title: string;
  readonly htmlUrl: string;
  readonly createdAt: Date;
}

export interface GithubFileAddition {
  readonly path: string;
  readonly contents: string; // UTF-8; client base64-encodes
}
export interface GithubFileDeletion {
  readonly path: string;
}
export interface GithubFileChanges {
  readonly additions?: readonly GithubFileAddition[];
  readonly deletions?: readonly GithubFileDeletion[];
}
export interface GithubCommitMessage {
  readonly headline: string;
  readonly body?: string;
}
export interface GithubCreatedCommit {
  readonly oid: string;
  readonly url: string;
  readonly repo: RepoCoordinate;
  readonly branch: string;
}

export interface GithubClient {
  // ...existing read methods unchanged...

  createIssueComment(
    repo: RepoCoordinate,
    issueNumber: IssueNumber,
    input: GithubCreateCommentInput,
    options?: CallOptions,
  ): Promise<Result<GithubCreatedComment, GithubClientError>>;

  createIssue(
    repo: RepoCoordinate,
    input: GithubCreateIssueInput,
    options?: CallOptions,
  ): Promise<Result<GithubCreatedIssue, GithubClientError>>;

  createCommitOnBranch(
    repo: RepoCoordinate,
    branch: string,
    message: GithubCommitMessage,
    fileChanges: GithubFileChanges,
    expectedHeadOid: string,
    options?: CallOptions,
  ): Promise<Result<GithubCreatedCommit, GithubClientError>>;
}
```

**`expectedHeadOid` is required**, not optional. The GraphQL mutation requires it and the optimistic-concurrency guarantee is the primary reason to prefer GraphQL. Callers fetch it via a future `getRef` helper (CF-github-J) or hand-construct the REST call for 2D.

### §4 — Write-scope enforcement: client-level, default-deny

**Decision: enforce at the `GithubClient` level via a new `writeScopes` config field. No writeScopes = read-only.**

```ts
export interface GithubWriteScopes {
  readonly issueComments: readonly string[]; // "owner/repo"
  readonly branchCommits: readonly {
    readonly repo: string; // "owner/repo"
    readonly paths: readonly string[]; // glob patterns
  }[];
  readonly labels: readonly string[]; // reserved; not enforced in 2D
  readonly issues: readonly string[]; // "owner/repo" — for createIssue
}

export interface GithubClientConfig {
  // ...existing fields...
  readonly writeScopes?: GithubWriteScopes;
}
```

**Default:** absent `writeScopes` → all mutations return `GithubWriteScopeError("no write scopes configured")`. Explicit opt-in is required — a daemon-level bug that forgets to pass `writeScopes` surfaces as a loud error, not silent data writes.

#### Glob matching (hand-rolled)

~40 lines in `packages/github/src/write-scopes.ts`. Supported syntax:

- `**` — any number of path segments including zero
- `*` — any characters within a single segment
- literal characters

`?`, `{a,b}`, `[abc]` are **not** supported — throws at client construction if encountered. Globs compile to anchored `RegExp` once; repo match is literal string equality. No `minimatch` dep.

### §5 — Error taxonomy additions

Three new classes in `errors.ts`:

- **`GithubWriteScopeError`** (`code: "write-scope-denied"`) — with `attemptedRepo`, `attemptedPath`, `scopeKind: "issue-comment" | "branch-commit" | "issue" | "label"`.
- **`GithubConflictError`** (`code: "conflict"`, status 409) — with `expectedHeadOid`. Fired on stale-HEAD `createCommitOnBranch`.
- **`GithubMutationAbortedError`** (`code: "mutation-aborted"`) — with `phase: "before-send" | "in-flight"`.

#### Abort semantics decision

**Reads re-throw `AbortError` (existing). Mutations return `GithubMutationAbortedError` as a Result.**

Rationale: mutations are not idempotent. When a mutation abort fires, the caller needs to distinguish "aborted before bytes left the socket" from "aborted after the server may have received the request". Returning a Result with a `phase` discriminant forces the caller to make that distinction explicitly. Reads, being idempotent, stay with the simpler re-throw.

`GithubValidationError` (existing) is reused for 422s on mutation bodies.

### §6 — Idempotency and retry

**Mutations never retry on transport failure. Period.**

- Mutation methods use a **separate** `MUTATION_RETRY_POLICY` constant with `maxAttempts: 1`, `retryableStatuses: []`. Not configurable — a user-supplied `retryPolicy` override cannot re-enable mutation retry.
- 502/503/504 → `GithubTransportError` with `attempts: 1` immediately.
- Network-level fetch rejection → `GithubTransportError` with `attempts: 1` immediately.
- `GithubConflictError` (409) is **not** retried — the caller must re-fetch HEAD.

Test coverage includes a regression guard asserting fake fetch called exactly once for each mutation-error path.

GitHub REST does not support idempotency keys for these endpoints. `createCommitOnBranch` via GraphQL with `expectedHeadOid` gets partial protection (second attempt fails with a conflict). Comments and issues have no dedup protection — callers that need it must list-then-post. **Deferred to Phase 3 if real duplicates appear in production.**

### §7 — `createCommitOnBranch` GraphQL shape

Request body (JSON):

```graphql
mutation CreateCommitOnBranch($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) {
    commit {
      oid
      url
    }
  }
}
```

with variables:

```ts
{
  branch: { repositoryNameWithOwner: "xeeban/emergent-praxis", branchName: "main" },
  expectedHeadOid: "<40-char sha>",
  fileChanges: {
    additions: [{ path: "notes/weekly/2026-04-09.md", contents: "<base64>" }],
    deletions: [],
  },
  message: { headline: "research: weekly digest 2026-04-09" },
}
```

Response Zod schema parses `data.createCommitOnBranch.commit.{oid,url}`. GraphQL errors map via a small adapter:

- `type: "FORBIDDEN"` → `GithubForbiddenError`
- `type: "NOT_FOUND"` → `GithubNotFoundError`
- `type: "UNPROCESSABLE"` / `"INVALID"` → `GithubValidationError`
- Stale `expectedHeadOid` message (`"is not a fast-forward"` / `"expected head sha didn't match"`) → `GithubConflictError`
- `type: "RATE_LIMITED"` → `GithubRateLimitError` with `resource: "graphql"`
- Anything else → `GithubInternalError` (token-scrubbed)

Endpoint: `POST {baseUrl}/graphql`. Same auth header, same rate-limit parsing, `x-ratelimit-resource: graphql`.

### §8 — Cost hook integration

Mutations fire the hook exactly once (no retry). Scope denials fire the hook with `cacheHit: false` and no `rateLimitRemaining` (they never touched the network) — deliberate bookkeeping for the audit trail.

### §9 — Write-scope check site

Single private method `#checkWriteScope(kind, repo, path)` called as the first line of every mutation method, before any network I/O, cost hook, or body serialization. On denial returns immediately with `GithubWriteScopeError` (cost hook still fires once per §8).

For `createCommitOnBranch`, **every** path in `fileChanges.additions` and `fileChanges.deletions` is checked independently. Any path outside the configured globs denies the entire commit with the first-offending path in the error. Partial commits are worse than refused commits.

### §10 — Tests (~15-18 specs)

1. `createIssueComment` happy path
2. `createIssueComment` write-scope denied (repo not in `issueComments`)
3. `createIssueComment` with no `writeScopes` config at all → denied
4. `createCommitOnBranch` happy path (GraphQL 200 with parsed oid/url)
5. `createCommitOnBranch` with unlisted repo → denied
6. `createCommitOnBranch` with path matching `**` glob → allowed
7. `createCommitOnBranch` with path not matching → denied
8. `createCommitOnBranch` with two additions, one non-matching → denied, fake fetch called **zero** times
9. `createCommitOnBranch` 409 stale HEAD → `GithubConflictError` with `expectedHeadOid`
10. `createIssue` happy path
11. `createIssue` 422 → `GithubValidationError`
12. Mutation transport failure → `GithubTransportError` attempts=1, fetch called exactly once (regression guard)
13. Mutation 503 → `GithubTransportError` attempts=1, fetch called exactly once
14. Cost hook fires once per mutation with correct `transport` (parameterized)
15. Cost hook fires on scope denial without `rateLimitRemaining`
16. Token scrubbing on mutation error path
17. `createCommitOnBranch` base64 encoding invariant (`"# hello\n"` → `"IyBoZWxsbwo="`)
18. Mutation in-flight abort → `GithubMutationAbortedError` Result (not throw), phase `"in-flight"`

### §11 — Carry-forwards

- **CF-github-H** — Brand `BranchName` and `GitOid` primitives in Phase 3 if unsafe construction proliferates.
- **CF-github-I** — **Amend ADR-0016** to include `github.write_scopes.issues: string[]` in the role frontmatter schema. This ADR assumes the field will be added.
- **CF-github-J** — `getRef(repo, branch)` read helper returning branch head SHA.
- **CF-github-K** — `addLabels`, `closeIssue`, `updateIssueComment` additions when a concrete wake needs them.
- **CF-github-L** — Per-attempt cost-hook granularity for mutations (mostly moot given single-attempt policy).
- **CF-github-M** — Retry budget / circuit breaker on repeated `GithubConflictError`.
- **CF-github-N** — Binary file contents in `GithubFileAddition` (currently UTF-8 text only).

## Consequences

### Positive

- Research Agent #1 flow unblocked with three minimum-viable methods.
- Write-scope enforcement is centralized, greppable, defense-in-depth.
- Non-idempotent retry is structurally impossible (hard-coded `MUTATION_RETRY_POLICY`).
- GraphQL carries its own weight: atomic commits, optimistic concurrency, single round-trip.
- Read path and existing tests untouched.

### Negative

- Dual transport means two code paths inside the client.
- Hand-rolled glob matcher is one more thing to maintain (mitigated by deliberately tiny syntax).
- Default-deny means a daemon bug forgetting `writeScopes` surfaces as runtime errors rather than silent success — intentional but requires daemon-side integration test.
- Caller fetches `expectedHeadOid` themselves until CF-github-J lands.

### Neutral

- `writeScopes.labels` is defined but not enforced in 2D.
- `addLabels` / `closeIssue` / `updateIssueComment` are deliberately absent. Additive later.

## Alternatives considered

- **Enforce write scopes in the agent runner, not the client.** Rejected: bypassable, multiple call sites to audit.
- **Four-call REST commit sequence.** Rejected: 4× cost-hook fires, no atomicity, no optimistic concurrency.
- **Single shared retry policy with `isMutation` flag.** Rejected: too easy for a config override to re-enable mutation retry. Hard-coded constant removes the foot-gun.
- **Throw `AbortError` on mutation abort (matching reads).** Rejected: mutation callers need the before/in-flight distinction.
- **Ship `addLabels` + `closeIssue` "because they're small".** Rejected: scope discipline; each new mutation is a new write-scope surface and new test burden.
- **Use `minimatch`.** Rejected: new runtime dep for three glob patterns.

---

_End of ADR-0017. Source + Claude Code implements; Engineering Lead #22 gates against the 15-18 test specs and the write-scope default-deny invariant._
