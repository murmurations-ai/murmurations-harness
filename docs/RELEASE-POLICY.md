# Release Policy

## Versioning

The harness follows [Semantic Versioning](https://semver.org/):

```
MAJOR.MINOR.PATCH
```

- **MAJOR** (1.0.0, 2.0.0) — breaking changes to the public API (GovernancePlugin, AgentExecutor, CLI commands, socket protocol)
- **MINOR** (0.2.0, 0.3.0) — new features, new CLI commands, new executor modes, additive protocol changes
- **PATCH** (0.1.1, 0.1.2) — bug fixes, documentation updates, dependency bumps

### Pre-1.0 rules

While at 0.x.y (current), the API is not considered stable:

- Minor bumps (0.1.0 → 0.2.0) may include breaking changes with migration notes
- Patch bumps (0.1.0 → 0.1.1) are always backward-compatible
- The CLI command surface is more stable than the TypeScript API — we avoid breaking CLI usage

### Post-1.0 rules

Once 1.0.0 ships:

- Breaking changes require a major bump and a migration guide
- The GovernancePlugin, AgentExecutor, and DaemonLogger interfaces are the public API surface
- CLI commands and socket protocol methods are part of the stable surface
- Internal modules (daemon internals, boot.ts) are not part of the public API

## Release process

### When to release

Releases are **milestone-based**, not time-based. A release ships when its milestone is complete:

1. All issues in the milestone are closed
2. `pnpm check` passes (build + typecheck + lint + format + test)
3. CHANGELOG.md is updated
4. Source approves the release

### How to release

Pushing a `v*` tag triggers `.github/workflows/release.yml`, which runs the
full gate (build / typecheck / lint / format / test), publishes all 8
packages to npm via Trusted Publishing (OIDC — no long-lived tokens), and
creates the GitHub Release.

```bash
# 1. Ensure clean main branch
git checkout main && git pull

# 2. Bump version across all packages
pnpm version --recursive <major|minor|patch>

# 3. Update CHANGELOG.md with the release notes

# 4. Commit, tag, push
git add -A
git commit -m "release: v0.2.0"
git tag v0.2.0
git push origin main --tags
# The Release workflow handles npm publish + GH release automatically.
```

### npm Trusted Publishing setup (one-time, per package)

The release workflow uses [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers)
via GitHub OIDC. Each `@murmurations-ai/*` package must be configured on
npmjs.com to trust this repository's `release.yml` workflow.

Setup, once per package:

1. Sign in to npmjs.com as a maintainer of `@murmurations-ai/*`.
2. Go to the package page → **Settings** → **Publishing access**.
3. Under **Trusted Publishers**, click **Add publisher**.
4. Select **GitHub Actions** and fill:
   - Repository: `murmurations-ai/murmurations-harness`
   - Workflow filename: `release.yml`
   - Environment: (leave blank unless we wire an env later)
5. Save.

Repeat for all 8 packages: `cli`, `core`, `dashboard-tui`, `github`, `llm`,
`mcp`, `secrets-dotenv`, `signals`.

Once configured, the workflow's `pnpm -r publish --provenance` step
exchanges a GitHub OIDC token for a short-lived npm publish token per
package — no `NPM_TOKEN` secret needed in the repo. The `--provenance`
flag attaches a signed attestation linking the published tarball to the
source commit and workflow run, visible on each package's npmjs.com page.

### Manual publish (fallback)

When Trusted Publishing isn't viable (e.g. tagging from a fork, or npm
OIDC outage), publish manually from a clean local checkout of the tag:

```bash
git checkout v0.2.0
pnpm install --frozen-lockfile
pnpm build && pnpm check
pnpm -r publish --access public --no-git-checks
# This will prompt for npm 2FA. An automation token in ~/.npmrc bypasses
# the prompt but is subject to npm's periodic security rotations.
```

## Milestones

Each release targets a GitHub Milestone. Issues are assigned to milestones during planning. The milestone progress bar shows how close the release is.

### Current milestones

| Version | Milestone      | Theme                                                                        | Status       |
| ------- | -------------- | ---------------------------------------------------------------------------- | ------------ |
| v0.1.0  | —              | Initial publish (7 packages, 353 tests)                                      | **Released** |
| v0.2.0  | tmux CLI       | ADR-0018: protocol.ts, parity matrix, batch verbs, REPL                      | **Released** |
| v0.3.0  | Vercel + MCP   | ADR-0020: Vercel AI SDK, tool calling, MCP, Langfuse (8 packages, 427 tests) | **Released** |
| v0.3.1  | AgentSkills    | Three-Tier Progressive Disclosure, SKILL.md scanner (441 tests)              | **Released** |
| v0.3.3  | CollabProvider | ADR-0021: CollaborationProvider, harness.yaml, cwd auto-detect (463 tests)   | **Released** |
| v0.3.5  | Extensions     | ADR-0023: extension system, web search, REPL improvements (486 tests)        | **Released** |
| v0.4.0  | Multi-instance | Multiple daemons, one repo                                                   | Planning     |
| v1.0.0  | Stable API     | Public API freeze, migration guide, Docker                                   | Planning     |

## Changelog

Every release gets an entry in `CHANGELOG.md` following [Keep a Changelog](https://keepachangelog.com/) format:

```markdown
## [0.2.0] - 2026-MM-DD

### Added

- tmux-style CLI with leader keys and parity matrix
- `murmuration agents`, `murmuration events` batch verbs

### Changed

- REPL commands now use `:` prefix

### Fixed

- Session heartbeat false positives on macOS
```

Categories: Added, Changed, Deprecated, Removed, Fixed, Security.
