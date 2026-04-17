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

```bash
# 1. Ensure clean main branch
git checkout main && git pull

# 2. Bump version across all packages
pnpm version --recursive <major|minor|patch>

# 3. Update CHANGELOG.md with the release notes

# 4. Commit and tag
git add -A
git commit -m "release: v0.2.0"
git tag v0.2.0

# 5. Push tag (triggers CI)
git push origin main --tags

# 6. Publish to npm
pnpm build
pnpm publish --recursive --access public --no-git-checks

# 7. Create GitHub Release from the tag
gh release create v0.2.0 --title "v0.2.0" --notes-file CHANGELOG-ENTRY.md
```

### Automated releases (future)

A GitHub Action will automate steps 6-7 when a version tag is pushed. Until then, releases are manual.

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
