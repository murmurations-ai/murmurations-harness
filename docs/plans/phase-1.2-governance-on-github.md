# Phase 1.2 — Governance State on GitHub Issues

**Status:** Draft plan (2026-04-20)
**Author:** Nori (via Claude pairing session)
**Addresses:** [#45](https://github.com/murmurations-ai/murmurations-harness/issues/45) — multi-instance last-write-wins on governance state can silently revert approvals
**Predecessors:** [ADR-0017](../adr/0017-github-mutations.md), [ADR-0021](../adr/0021-collaboration-provider-abstraction.md)
**Likely outputs:** ADR-0031 (governance state on GitHub Issues), amendment to ADR-0021 (new read methods on `CollaborationProvider`)

This is a **design plan**, not an implementation. It captures the problem, the proposed architecture, the open questions, and the phasing. No code changes until the ADR is drafted and accepted.

---

## 1. Problem recap

`GovernanceStateStore.#persist` (`packages/core/src/governance/index.ts:490`) rewrites `items.jsonl` with the full in-memory map on every create/transition. With two harness instances pointed at the same filesystem path (Phase 5 multi-instance, operator mistake, or a test-runner glitch), a last-write-wins race silently discards transitions:

1. Instance A reads `items.jsonl`, transitions item X `open → approved`, rewrites file.
2. Instance B read before A wrote — doesn't see X=approved. Transitions unrelated item Y, rewrites file with its stale X=open.
3. X is now `open` on disk. Agent on A proceeds (cached) while agent on B blocks. No error, no warning.

The `evaluateAction` gate that depended on a consented state is silently bypassed for A and silently deadlocks B. This is the governance equivalent of a torn write.

Today's severity is LOW only because multi-instance isn't shipped. The moment Phase 5 opens, the vulnerability escalates to HIGH and blocks release.

---

## 2. Why GitHub Issues

GitHub Issues give us the primitives we need without adding infrastructure:

- **Atomic state swap.** `PUT /repos/:owner/:repo/issues/:n/labels` _replaces_ the full label set in a single API call. Removing `state:open` and adding `state:approved` is one atomic operation on GitHub's side. That's our compare-and-swap primitive.
- **Durable audit trail.** Issue comments are append-only with server-authoritative timestamps. Our state-transition comments (already written by `GovernanceGitHubSync`) become the history of record.
- **Multi-writer native.** GitHub already arbitrates concurrent label edits — whichever PUT lands last wins _at the label level_, and our transition logic can re-read and retry on conflict.
- **No new dependency.** We already use the `@murmurations-ai/github` client (ADR-0017) and the `CollaborationProvider` abstraction (ADR-0021). Governance is the last subsystem still treating the filesystem as authoritative.
- **It's the direction we're already going.** `GovernanceGitHubSync` already writes this shape. We just need to make GitHub _authoritative_ rather than a downstream mirror.

The alternatives (database, file advisory lock) either add ops burden or don't actually solve the multi-instance problem.

---

## 3. Current architecture (what we have today)

### 3.1 The `IGovernanceStateStore` contract

```ts
interface IGovernanceStateStore extends GovernanceStateReader {
  registerGraph(graph: GovernanceStateGraph): void;
  create(kind, createdBy, payload, options?): GovernanceItem;
  transition(itemId, to, triggeredBy, reason?): GovernanceItem;
  setGithubIssueUrl(itemId, url): void;
  load(): Promise<number>;
  flush(): Promise<void>;
  // + reader methods: get, query, buildDecisionRecord, size, graphs
}
```

**All mutations are synchronous from the caller's point of view** — they return a `GovernanceItem` directly. Persistence is fire-and-forget (`#persistPending`). Any GitHub-backed implementation has to preserve this synchronous-return contract or force a wide refactor.

### 3.2 Current persistence

- `#persist()` (line 484) rewrites `items.jsonl` with the full in-memory map on every mutation. Errors are swallowed ("best-effort").
- `load()` parses the full file once at daemon start. No incremental loading, no polling.
- No locking, no CAS, no etag.

### 3.3 Existing GitHub sync (`GovernanceGitHubSync`)

Already fires on every create/transition via `GovernanceSyncCallbacks`:

- `onCreate(item)` → creates an issue with labels `governance:<kind>`, `state:<initial>`, `agent:<id>`, optionally `group:<id>`. Returns the issue URL.
- `onTransition(item, transition, isTerminal)` → posts a state-transition comment, removes `state:<from>` label, adds `state:<to>` label, closes the issue if terminal.
- `onDecision(record)` → posts a decision-record comment.

It already does the right _writes_. What it doesn't do is act as the source of truth on reads.

### 3.4 Current `CollaborationProvider` surface (reads)

```ts
listItems(filter?: ItemFilter): Promise<CollabResult<readonly CollaborationItem[]>>;
collectSignals(filter?: ItemFilter): Promise<readonly Signal[]>;
```

No `getItem(ref)`, no `listLabelsOnItem(ref)`, no `listComments(ref)`. The provider can enumerate items but can't fetch a single item's full state or history. This is a gap we need to close.

---

## 4. Proposed architecture

### 4.1 Two stores, same interface

Introduce a second implementation of `IGovernanceStateStore`:

```
┌─────────────────────────────────────────────────────────┐
│ IGovernanceStateStore (interface)                       │
├─────────────────────────────────────────────────────────┤
│ FileGovernanceStateStore      (current, rename)         │
│ GithubGovernanceStateStore    (new, authoritative)      │
└─────────────────────────────────────────────────────────┘
```

- **`FileGovernanceStateStore`** (rename of current `GovernanceStateStore`) stays the default for `provider: "local"` murmurations and tests. Known single-instance; no race.
- **`GithubGovernanceStateStore`** is wired when `provider: "github"`. Treats GitHub as source of truth; local in-memory map is a cache.

`boot.ts` picks the store based on `harness.yaml` `collaboration.provider`.

### 4.2 State representation on GitHub

| Concept        | GitHub encoding                                              |
| -------------- | ------------------------------------------------------------ |
| Item           | Issue                                                        |
| Kind           | Label `governance:<kind>`                                    |
| Current state  | Label `state:<name>` (exactly one per issue)                 |
| Terminal state | Issue closed + `state:<terminal-name>` label                 |
| Created by     | Label `agent:<id>`                                           |
| Group          | Label `group:<id>`                                           |
| Payload        | Serialized in issue body (fenced JSON block)                 |
| Item ID        | Footer of issue body: `<!-- murmuration-item-id: <uuid> -->` |
| History        | Issue comments, parsed from our own structured format        |
| Review date    | Body field + label `review-due` (set by a scheduled sweep)   |

### 4.3 Mutation flows

**Create:**

1. Generate `itemId` (UUID) locally.
2. `provider.createItem({ title, body with itemId footer, labels: [governance:<kind>, state:<initial>, agent:<id>, group:<id>?] })`.
3. On success, populate local cache with the returned `ItemRef`.
4. Return `GovernanceItem` synchronously (await the create call).

**Transition (the critical path):**

1. Read current state from GitHub: `provider.getItem(ref)` (new method — see §5).
2. Validate the transition against the registered graph.
3. **Compare-and-swap:** compute the new label set (strip `state:*`, add `state:<to>`) and call `provider.setLabels(ref, fullSet)` (new method — atomic replace). If the CAS fails because the current state label no longer matches what we expect, surface a typed error (`STALE_STATE`) and let the caller decide whether to retry.
4. On success, post the transition comment, close the issue if terminal.
5. Update local cache.

**Read:**

- `get(itemId)` → consult cache; on miss, look up via `listItems({ label: itemId-marker })` or a `ref` map, then fetch with `getItem`.
- `query(filter)` → `listItems(filter)` translated to GitHub label queries. Filters map naturally: `state` → `state:<name>` label, `kind` → `governance:<kind>` label, `createdBy` → `agent:<id>` label, `reviewDue` → `review-due` label.
- `load()` → list all open + recently-closed governance issues, hydrate cache. Replaces current JSONL parse.

### 4.4 Cache coherence

The local cache is a **read-through, write-through** cache, not a source of truth:

- Writes hit GitHub first; cache is updated from the authoritative response.
- Reads miss the cache → fetch from GitHub → populate cache.
- TTL is short (e.g. 30s) or event-driven: when a transition fails CAS, invalidate the cached item and force a refetch.
- Startup: `load()` fetches the current open-item set in one or two paginated calls, populates cache. Closed items are loaded lazily on `get()`.

Two instances each keep their own cache; GitHub is the arbiter. LWW cannot corrupt governance state because every transition goes through an atomic GitHub call.

---

## 5. `CollaborationProvider` gaps

New methods required. These likely justify an amendment to ADR-0021 rather than a fresh ADR:

```ts
interface CollaborationProvider {
  // existing: createItem, listItems, postComment, updateItemState,
  //           addLabels, removeLabel, commitArtifact, collectSignals

  // NEW
  getItem(ref: ItemRef): Promise<CollabResult<CollaborationItem>>;
  setLabels(ref: ItemRef, labels: readonly string[]): Promise<CollabResult<void>>;
  listComments(ref: ItemRef): Promise<CollabResult<readonly CommentRef[]>>;
}
```

- `getItem(ref)` — returns a single item with its full label set. Needed for the CAS read-before-write.
- `setLabels(ref, labels)` — atomic replace of the full label set. This is our CAS primitive. The existing `addLabels` + `removeLabel` combination is **not** atomic and must not be used for state transitions.
- `listComments(ref)` — replay history on cache miss or audit rebuild.

The `local` provider (file-backed, single-instance) can implement these trivially. The `github` provider implements them via REST.

---

## 6. Open design questions

### Q1. What do we do on CAS conflict?

Proposed: surface `CollaborationError { code: "STALE_STATE" }` up through `transition()`. The caller (daemon wake handler) decides: retry after refetching, or abort and let the plugin re-evaluate. **Default:** one retry, then fail the transition with a logged warning. The governance plugin's `evaluateAction` gate sees the failure and holds the action.

### Q2. Review-date sweep — who runs it?

Today: `query({ reviewDue: true })` iterates the in-memory map. On GitHub: we'd need a scheduled sweep that queries `label:review-due` issues. Options:

- **(a)** Push it into GitHub: a scheduled workflow or bot stamps `review-due` when the body's review date passes.
- **(b)** Keep it in the daemon: a nightly sweep queries all governance issues and emits `review-due` events without changing labels.

Leaning (b) — keeps the harness self-contained and avoids operator setup burden.

### Q3. Private / sensitive governance

Some governance items might contain secrets or identify humans who shouldn't appear in a public repo. Options:

- **(a)** Require the governance repo to be private. Simple, but couples the collaboration repo to governance sensitivity.
- **(b)** Allow a separate `governance_repo` distinct from the code repo. More config, more flexibility.
- **(c)** Redact payloads before writing to GitHub; keep sensitive fields in a local encrypted store and reference them by ID.

Recommendation: start with (a) — require private repos for governance — and revisit if a customer needs (b) or (c).

### Q4. Offline / degraded mode

If GitHub is unreachable, the current daemon still boots and processes wakes. A GitHub-backed store means:

- **Create** fails — the daemon can't authorize new governance items. Fail closed; the plugin sees the error.
- **Transition** fails — the daemon can't approve actions. Fail closed.
- **Read** falls back to the cache for items already known, but can't discover new items.

Fail-closed is the right default for a security-critical subsystem. Document it. The alternative (fail-open + retry later) is what created this bug in the first place.

### Q5. Decision-record storage

Today `buildDecisionRecord()` produces a serializable record; `GovernanceGitHubSync.onDecision()` posts it as a comment. Keep that. The decision record is derivable from the item + history, so we don't need a separate GitHub artifact.

### Q6. Rate limits

GitHub's authenticated limit is 5,000/hr. A busy murmuration (say 20 agents, 2 wakes/hr each, 1 governance operation per wake) uses ~40 ops/hr. Orders of magnitude under the limit. We can afford to be chatty. **Still worth adding:** a per-process rate limiter in the GitHub client as a safety net.

### Q7. What about `setGithubIssueUrl`?

In the new model the URL is the `ItemRef`, not a sidecar. This method disappears. Boot paths that rely on it get simpler, but we need to migrate any callers. Grep shows only internal use.

---

## 7. Phasing

Each phase is independently shippable and reversible.

### Phase 0 — Design (this document + ADR)

- Nori reviews this plan
- Draft ADR-0031 on a branch, open as draft PR, drive to consent
- Amend ADR-0021 for the new `CollaborationProvider` methods

### Phase 1 — Extend `CollaborationProvider` (no behavior change)

- Add `getItem`, `setLabels`, `listComments` to the interface
- Implement on `LocalCollaborationProvider` (file-backed) — single-instance, no CAS needed
- Implement on `GithubCollaborationProvider` via REST
- Unit + integration tests. Ship.

### Phase 2 — `GithubGovernanceStateStore`

- New class implementing `IGovernanceStateStore`
- Wire it behind a feature flag (`harness.governance.authoritative-store: "github" | "file"`, default `"file"`)
- Integration tests: concurrent transitions, CAS conflicts, cache coherence
- Soak-test in a throwaway repo. Ship.

### Phase 3 — Flip the default for `provider: "github"`

- When `collaboration.provider === "github"`, default to `authoritative-store: "github"`
- `file` remains for `provider: "local"`
- Migration guide for existing operators: run `murmuration governance migrate --from file --to github` (one-shot tool that hydrates GitHub from `items.jsonl`)

### Phase 4 — Remove the legacy sync path

- Once `GithubGovernanceStateStore` is the default, `GovernanceGitHubSync` becomes redundant (the store does its own writes). Delete it.
- Close #45.

### Phase 5 — Multi-instance (the original motivation)

- Gated on Phases 1–4 being complete
- Out of scope for this plan; listed only to keep the reader oriented

---

## 8. Risks

- **Test flakiness:** integration tests against a live GitHub repo will flake on rate limits or network. Mitigation: record/replay fixtures for unit tests; reserve the real repo for a small smoke-test tier.
- **Slow transitions:** every transition is now one or two REST calls (~200–500ms). Governance operations are rare, but the latency is visible to agents. Document the change; revisit if it bites.
- **Partial-failure modes:** we create an issue, then try to post the initial state-transition comment, and the second call fails. The issue exists with the right label but no body comment. Mitigation: idempotent retry keyed on the item-id marker; background reconciliation.
- **Vendor lock-in:** the governance subsystem becomes dependent on GitHub's label/issue semantics. That's already true for `GovernanceGitHubSync`; this makes it harder to walk back. Mitigation: the `CollaborationProvider` abstraction is the exit door. A future GitLab or Gitea provider implements the same surface.
- **The "governance:\*" label namespace collides with operator labels.** Document the reserved prefix; validate on create.

---

## 9. Out of scope

- Database-backed governance store (Option B in #45). Rejected — operational complexity exceeds benefit.
- File advisory locking (Option C in #45). Rejected — single-machine only, doesn't address the threat.
- Cross-repo governance (e.g. one governance repo serving many product repos). Nice to have, not needed for Phase 1.2.
- Encrypted payloads on GitHub. Q3 option (c). Deferred until a real requirement surfaces.
- GraphQL migration for batched reads. The REST client is sufficient at current scale.

---

## 10. Next actions

- [ ] Nori (or Source) reviews this plan and either accepts the direction or names the change
- [ ] Draft ADR-0031 on `adr/0031-governance-on-github` branch, open as draft PR
- [ ] Draft ADR-0021 amendment for new `CollaborationProvider` methods (can live in the same PR or a predecessor)
- [ ] Spike: implement `setLabels` on `GithubCollaborationProvider` and confirm the REST `PUT /issues/:n/labels` is indeed atomic across concurrent writes (test with two parallel calls against the same issue)
- [ ] Schedule implementation on a Wednesday/Thursday deep-work day, not between meetings
