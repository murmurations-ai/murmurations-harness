# @murmurations-ai/github

Typed GitHub REST client for the Murmuration Harness. Rate-limit aware,
ETag-caching, secret-safe (SecretValue auth), errors-as-values.

Owned by TypeScript / Runtime Agent #24. Ships in Phase 1B step B2.

## Scope (1B-d)

Read-only methods needed by the `SignalAggregator`:

- `getIssue(repo, number)`
- `listIssues(repo, filter)`
- `listIssueComments(repo, number)`
- `listIssueLabels(repo, number)`

Mutations, GraphQL, webhooks, and App authentication are out of scope
for v0.1 — additive when they land.

## Design choices

- **Native `fetch`** in production, `undici.MockAgent` dev-only. No
  Octokit — its code-generated endpoint-methods plugin leaks thousands
  of types into any package that exposes its shape.
- **SecretValue auth** — the `token` config is a `SecretValue` from
  `@murmurations-ai/core/secrets`. `reveal()` is called in exactly one
  place (the request builder). Never logged, never stored in error
  messages.
- **Errors-as-values** per ADR-0005 for all expected failure modes
  (404, 401, 403, 422, 5xx). Only `AbortError` re-throws.
- **Branded primitives** per ADR-0006 — `RepoCoordinate`,
  `IssueNumber`, `GithubOwner`, `GithubRepoName`.
- **Per-call cost hook** bound to `WakeCostBuilder.addGithubCall` so a
  daemon-long-lived client can cooperate with per-wake cost builders.
- **ETag caching** via a pluggable `GithubCache` interface + default
  in-memory LRU. Cache hits signal `{ cacheHit: true }` to the cost
  hook.
- **Zod** for parsing untrusted response bodies.

See `docs/adr/0012-github-client.md` for the full rationale.

## Usage sketch

```ts
import { makeSecretKey } from "@murmurations-ai/core";
import { DotenvSecretsProvider } from "@murmurations-ai/secrets-dotenv";
import { createGithubClient, makeRepoCoordinate, makeIssueNumber } from "@murmurations-ai/github";

const GITHUB_TOKEN = makeSecretKey("GITHUB_TOKEN");
const provider = new DotenvSecretsProvider({ envPath: ".env" });
await provider.load({ required: [GITHUB_TOKEN], optional: [] });

const client = createGithubClient({
  token: provider.get(GITHUB_TOKEN),
});

const repo = makeRepoCoordinate("xeeban", "emergent-praxis");
const result = await client.getIssue(repo, makeIssueNumber(241), {
  costHook: { onGithubCall: (call) => builder.addGithubCall(call) },
});
if (result.ok) {
  console.log(result.value.title);
}
```
