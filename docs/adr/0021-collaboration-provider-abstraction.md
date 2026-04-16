# ADR-0021 — Abstract collaboration layer behind a pluggable provider interface

- **Status:** Proposed
- **Date:** 2026-04-15
- **Decision-maker(s):** Source (design)
- **Related:** ADR-0012 (GitHub client), ADR-0017 (GitHub mutations), ADR-0020 (Vercel AI SDK migration pattern)

## Context

The harness currently uses GitHub as the system of record for three distinct roles:

1. **Coordination** — issues as work items, governance items, directives, meeting outcomes
2. **Artifacts** — committed files (digests, drafts, decisions, reports)
3. **Signals** — issues feed into agent signal bundles at wake time

This works well for open-source murmurations, but couples the harness to GitHub. Real-world use cases need alternatives:

- **Offline / air-gapped** — local development without API keys
- **Enterprise** — GitLab, Azure DevOps, or on-prem Gitea
- **Non-git workflows** — Linear for project management, Notion for knowledge bases, plain files for personal use
- **Testing** — fast local provider, no network calls

The ADR-0020 migration proved the "borrow infrastructure, build differentiators" pattern: abstract the _what_ we need, let the ecosystem provide the _how_. The same principle applies here — GitHub is the default tool, not the only tool.

## Key Insight: Murmuration Repo vs Product Repos

Every murmuration has a two-tier repo architecture:

**Murmuration repo (ONE, private by default):** The murmuration's home — governance, operations, agent identity, meetings, signals, and runtime state. This is where the `CollaborationProvider` writes by default.

**Product repos (MANY, public or private):** What the murmuration _builds_ — code, content, documentation, courses, designs. Agents access these via MCP tools or explicit write scopes for committing artifacts.

```
my-murmuration/                    ← murmuration repo (private)
├── agents/                        ← identity docs
├── governance/                    ← consent rounds, decisions, circles
├── notes/                         ← meeting minutes, daily notes
└── .murmuration/                  ← runtime state

org/product-a/                     ← product repo (public)
├── packages/                      ← code
└── docs/                          ← technical docs

org/product-b/                     ← another product repo
```

A murmuration may work on many products simultaneously, but its governance and operations are unified in one place. Internal meeting discussions, role amendments, and governance tensions must not pollute public product repos.

## Decision

### §1 — Define a `CollaborationProvider` interface

Abstract the three roles into a single provider interface in `@murmurations-ai/core`:

```typescript
interface CollaborationProvider {
  readonly id: string; // e.g. "github", "local", "gitlab"
  readonly displayName: string;

  // --- Coordination (work items, governance, directives) ---

  /** Create a coordination item (issue, ticket, file). */
  createItem(input: {
    title: string;
    body: string;
    labels?: string[];
    assignees?: string[];
  }): Promise<Result<ItemRef, CollaborationError>>;

  /** List items matching a filter. */
  listItems(filter: ItemFilter): Promise<Result<readonly Item[], CollaborationError>>;

  /** Post a comment / update on an item. */
  postComment(ref: ItemRef, body: string): Promise<Result<CommentRef, CollaborationError>>;

  /** Update item state (open → closed, etc.). */
  updateItemState(ref: ItemRef, state: ItemState): Promise<Result<void, CollaborationError>>;

  /** Add labels / tags to an item. */
  addLabels(ref: ItemRef, labels: readonly string[]): Promise<Result<void, CollaborationError>>;

  /** Remove a label / tag from an item. */
  removeLabel(ref: ItemRef, label: string): Promise<Result<void, CollaborationError>>;

  // --- Artifacts (committed files, persisted outputs) ---

  /** Write an artifact (file commit, direct write, etc.). */
  commitArtifact(input: {
    path: string;
    content: string;
    message: string;
  }): Promise<Result<ArtifactRef, CollaborationError>>;

  // --- Signals (read coordination state for agent consumption) ---

  /** Collect signals from the provider's coordination items. */
  collectSignals(scopes: readonly SignalScope[]): Promise<Signal[]>;
}
```

### §2 — GitHub becomes the default provider

The existing `@murmurations-ai/github` package becomes the implementation of `CollaborationProvider` for GitHub. No breaking changes — `createGithubClient()` stays, the provider wraps it.

### §3 — Provider is selected at boot, targeting the murmuration repo

```yaml
# murmuration/harness.yaml
collaboration:
  provider: "github" # or "local", "gitlab"
  repo: "xeeban/emergent-praxis" # the murmuration's governance home

products: # repos the murmuration works on
  - name: harness
    repo: "murmurations-ai/murmurations-harness"
  - name: website
    repo: "xeeban/emergent-praxis-site"
```

The `CollaborationProvider` targets the murmuration repo by default for all governance, signals, and operational coordination. Product repos are accessed by agents via MCP tools or explicit `branch_commits` write scopes for committing code/content artifacts.

Or via CLI: `murmuration start --collaboration local`

### §4 — Local markdown provider ships as built-in alternative

A `LocalCollaborationProvider` uses the filesystem:

| Role         | Implementation                                   |
| ------------ | ------------------------------------------------ |
| Coordination | YAML frontmatter files in `.murmuration/items/`  |
| Artifacts    | Direct file writes to the murmuration root       |
| Signals      | Glob `.murmuration/items/` and parse frontmatter |

This enables zero-dependency local development — no GitHub token, no network. Useful for testing, personal murmurations, and air-gapped environments.

### §5 — Existing subsystems adapt to the interface

| Subsystem          | Current                                    | After                                                                    |
| ------------------ | ------------------------------------------ | ------------------------------------------------------------------------ |
| Governance sync    | `GovernanceSyncGitHub` (5 methods)         | `CollaborationProvider.createItem/postComment/addLabels/updateItemState` |
| Signal aggregation | `GithubClient.listIssues()`                | `CollaborationProvider.collectSignals()`                                 |
| Runner commits     | `GithubClient.getRef/createCommitOnBranch` | `CollaborationProvider.commitArtifact()`                                 |
| CLI `directive`    | `GithubClient.createIssue()`               | `CollaborationProvider.createItem()`                                     |
| CLI `backlog`      | `GithubClient.listIssues()`                | `CollaborationProvider.listItems()`                                      |
| CLI `group-wake`   | Multiple GitHub calls                      | Multiple `CollaborationProvider` calls                                   |

### §6 — Write-scope enforcement moves to the provider

Each provider enforces its own access control model:

- GitHub: glob-based write scopes per repo/path (existing ADR-0017 model)
- Local: directory-based write restrictions
- GitLab: project-level permissions

The harness declares _what_ the agent wants to do. The provider decides _whether_ it's allowed.

## Consequences

### Positive

- Harness works without GitHub — local development, testing, air-gapped
- Enterprise providers (GitLab, Azure DevOps) become possible without forking
- Non-git coordination (Linear, Notion, database) can be added as plugins
- Cleaner architecture — subsystems depend on the interface, not the implementation
- Governance sync, signal aggregation, and runner all use the same abstraction

### Negative

- Abstraction layer adds indirection
- Each new provider must implement the full interface (or a subset with graceful degradation)
- GitHub-specific features (GraphQL atomic commits, ETag caching) may not have equivalents
- Migration work across governance, signals, runner, and CLI commands

### Neutral

- GitHub remains the recommended default for open-source murmurations
- Agent identity docs (role.md) stay the same — only the harness config changes
- MCP tools provide additional provider-specific access when needed (e.g., `@modelcontextprotocol/server-github` for advanced GitHub operations)

## Implementation phases

1. **Define the interface** — `CollaborationProvider`, `ItemRef`, `ItemFilter`, `Signal` mapping
2. **Wrap GitHub** — `GitHubCollaborationProvider` wraps existing `@murmurations-ai/github`
3. **Adapt subsystems** — governance sync, signal aggregator, runner, CLI commands
4. **Local provider** — `LocalCollaborationProvider` for filesystem-based coordination
5. **Boot config** — provider selection via harness.yaml or CLI flag

## Alternatives considered

- **Keep GitHub hard-coded** — Rejected: limits adoption to GitHub-only teams, prevents offline development
- **Abstract only signals** — Rejected: coordination and artifacts are equally coupled; partial abstraction creates inconsistency
- **Use MCP for everything** — Rejected: MCP is for LLM tool calling during wakes; the harness needs direct programmatic access to coordination state for governance, scheduling, and CLI commands outside of wake context
