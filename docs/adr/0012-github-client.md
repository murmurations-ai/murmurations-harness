# ADR-0012 — `@murmurations-ai/github` typed REST client

- **Status:** Accepted
- **Date:** 2026-04-09 (landed in commit `1B-d`)
- **Decision-maker(s):** TypeScript / Runtime Agent #24 (authored the design), Engineering Circle
- **Consulted:** DevOps / Release Agent #26 (implementation), Security Agent #25 (SecretValue integration, zod Notify review), Performance / Observability Agent #27 (cost hook integration with ADR-0011)
- **Closes:** Phase 1B step B2 from `docs/PHASE-1-PLAN.md`

## Context

The harness needs a typed GitHub REST client to support the signal
aggregator (B4) and, later in Phase 2, pipeline and governance writes.
It must:

- Integrate with `WakeCostBuilder.addGithubCall` (ADR-0011) without
  breaking the daemon-long-lived / wake-scoped boundary.
- Accept a `SecretValue` for auth per ADR-0010 and never leak the
  raw token through error paths, logs, or structured bookkeeping.
- Surface rate-limit headers as a `GithubRateLimitSnapshot` that can
  feed the cost hook.
- Cache responses via ETag to reduce rate-limit consumption on repeat
  reads.
- Use errors-as-values per ADR-0005 for expected failures (404, 401,
  403, 422, rate-limited).
- Be narrow at the type system level so the public API is minimal and
  reviewable.

## Decision

**Use native `fetch` in production; `undici.MockAgent` dev-only.** No
Octokit. The client is hand-rolled in ~400 lines of TypeScript in
`packages/github/`.

### Key sub-decisions

1. **Octokit rejected.** Its code-generated endpoint-methods plugin
   leaks thousands of generated types into any package that exposes
   its shape. For a package whose public API is four read methods,
   that type surface is pure liability.

2. **Native `fetch` accepted.** Node 20+ provides `fetch`, `Headers`,
   `Request`, `Response`, and `AbortController` in the standard
   library. All of the custom behaviour we need (retry, ETag cache,
   rate-limit accounting, cost hook) lives in our wrapper anyway;
   there is nothing Octokit would offload that we actually want.

3. **`undici` as dev-only dependency.** `MockAgent` is the cleanest
   fetch mock in Node 20; it goes in `devDependencies` and never
   ships. (In practice the 1B-d test suite uses a minimal hand-rolled
   fake-fetch helper rather than `MockAgent` — sufficient for the
   coverage needed and avoids even the dev dep.)

4. **Per-call cost hook, not constructor-scoped.** The `GithubClient`
   is a daemon-long-lived instance (shares cache, rate-limit state,
   connection pool). `WakeCostBuilder` is per-wake. The hook rides on
   per-call options so the same client can cooperate with many
   successive builders without a new instance per wake.

5. **`reveal()` called in exactly one place.** The `SecretValue.reveal()`
   call happens inside `#buildHeaders` in `client.ts`. One other
   `reveal()` exists in `scrubCause` purely for a string-replace safety
   net on incoming error messages — both are grep-checkable. The
   revealed string never leaves local scope.

6. **Errors-as-values.** All expected failures return `{ ok: false,
error }`. Only `AbortError` re-throws. The error taxonomy mirrors
   `ExecutorError` and `SecretsProviderError` with a stable `code`
   discriminant.

7. **Branded primitives** for `GithubOwner`, `GithubRepoName`,
   `RepoCoordinate`, `IssueNumber` per ADR-0006. Parse untrusted
   input through Zod before calling the constructors.

8. **ETag cache with LRU eviction.** `LruGithubCache` backed by
   insertion-order `Map`, default 500 entries. Cache hits signal
   `{ cacheHit: true }` to the cost hook.

9. **Retry on 502/503/504 only.** 4xx errors surface immediately;
   429 / 403-rate-limited go through the rate-limit error path;
   5xx get up to 3 exponential-backoff attempts. No retry on
   mutations — moot for 1B-d (read-only).

### New runtime dependency

- **`zod@^4.3.6`** — matching the version already in
  `@murmurations-ai/core`. Zero new package-level exposure because it
  was already in the monorepo dependency graph; Security #25 review
  not re-triggered.

## Consequences

### Positive

- Net new runtime deps for this package: `zod` (already in graph) and
  `@murmurations-ai/core`. No new supply-chain surface.
- The public API is ten exports: `createGithubClient`, `GithubClient`,
  four branded constructors, one cache class, and the error taxonomy.
- `SecretValue.reveal()` is grep-checkable (one call in `client.ts`
  for header construction, one in `scrubCause` for error scrubbing).
- The cost-hook adapter is a two-line closure on every call site.
- Errors-as-values keeps the signal aggregator call sites free of
  `try/catch`.

### Negative

- Hand-rolling retries, cache, and pagination means we reimplement
  behaviour Octokit would provide. For 1B-d (four read methods) this
  is the right trade; if the surface grows to 20+ methods we should
  revisit.
- Retry collapses to a single cost-hook call per user call. If
  Performance #27 wants per-attempt visibility, an additive
  `onGithubAttempt` hook method lands in a future minor (CF-github-A).
- LRU cache is in-memory only; daemon restarts empty it (CF-github-B).

### Follow-ups

- **CF-github-A** — Per-attempt cost-hook granularity.
- **CF-github-B** — Disk-backed ETag cache for restart resilience.
- **CF-github-D** — Retry budget linked to wake wall-clock.
- **CF-github-E** — `Result<T, E>` deduplication to `@murmurations-ai/core`.
- **CF-github-F** — GitHub App (JWT) auth when plugin trust boundary
  lands (Phase 3).
- **CF-github-G** — Mutation surface (comments, labels, issues) for
  Phase 2.

## Alternatives considered

- **`@octokit/rest`** — rejected; type-leak concerns and surface
  area we don't consume.
- **Roll our own parser instead of Zod** — rejected; Zod is already
  in the dependency graph and its failure messages are the right
  shape for `GithubValidationError`.
- **`got` or `ky`** — adds a runtime dependency for negligible value
  over native fetch in Node 20.
