# Release Recovery Procedures

Runbook for recovering from a failed or partial npm publish in the Murmuration Harness monorepo.

## Context

`release.yml` publishes packages via `pnpm -r publish --access public --no-git-checks`,
which serializes packages in dependency order:

```
@murmurations-ai/core
@murmurations-ai/github
@murmurations-ai/llm
@murmurations-ai/secrets-dotenv
@murmurations-ai/signals
@murmurations-ai/mcp
@murmurations-ai/dashboard-tui
@murmurations-ai/cli
```

If the workflow dies mid-run (network drop, OOM, NPM_TOKEN expiry, rate limit), some packages
will be on npm and others will not. npm's 72-hour unpublish window is the only automated rollback surface.

---

## Step 1 - Triage: which packages published?

```bash
VERSION=0.7.1  # replace with the release version

for pkg in core github llm secrets-dotenv signals mcp dashboard-tui cli; do
  STATUS=$(npm view "@murmurations-ai/${pkg}@${VERSION}" version 2>/dev/null || echo "NOT FOUND")
  echo "@murmurations-ai/${pkg}@${VERSION}: ${STATUS}"
done
```

Record which packages are present on npm. This is your blast radius.

---

## Step 2 - Stop-gap: deprecate partially-published packages

If some packages published but not all, deprecate all published packages immediately
to prevent accidental adoption of an inconsistent release:

```bash
VERSION=0.7.1

for pkg in core github llm secrets-dotenv signals mcp dashboard-tui cli; do
  if npm view "@murmurations-ai/${pkg}@${VERSION}" version > /dev/null 2>&1; then
    npm deprecate "@murmurations-ai/${pkg}@${VERSION}" \
      "partial publish -- do not use; use previous version until clean release available"
    echo "Deprecated @murmurations-ai/${pkg}@${VERSION}"
  fi
done
```

Non-destructive and reversible via `npm undeprecate`.

---

## Step 3 - Decision: patch tag vs. unpublish and retry

### Use a patch tag when

- More than 24 hours have elapsed since the failed publish
- External consumers may have installed a partially-published package
- Any package is > 72 hours old on npm
- The publish failure was a transient infrastructure problem (not a code bug)

```bash
# Bump patch across all packages, e.g. 0.7.1 -> 0.7.2
git add -A
git commit -m "release: v0.7.2 (recovery from partial 0.7.1 publish)"
git tag v0.7.2
git push origin main --tags
```

### Unpublish and retry when

- Less than 24 hours since the failed publish
- No known consumers of any partially-published package
- All packages still within the 72-hour unpublish window
- Failure was transient (expired token, network blip) not requiring a version bump

**Unpublish in REVERSE dependency order (cli first, core last):**

```bash
VERSION=0.7.1

for pkg in cli dashboard-tui mcp signals secrets-dotenv llm github core; do
  if npm view "@murmurations-ai/${pkg}@${VERSION}" version > /dev/null 2>&1; then
    npm unpublish "@murmurations-ai/${pkg}@${VERSION}"
    echo "Unpublished @murmurations-ai/${pkg}@${VERSION}"
  fi
done

# Fix root cause, then delete the remote tag and re-push:
git push origin --delete v0.7.1
git tag -d v0.7.1
# ... apply fix ...
git tag v0.7.1
git push origin v0.7.1
```

---

## Step 4 - The 72-hour constraint

npm allows unpublish of a specific version within 72 hours of publish. After that window closes,
the package is permanent on npm and the only option is deprecation + patch release.

Check your remaining window:

```bash
npm view "@murmurations-ai/core@0.7.1" time.created
# Subtract from now. If < 12h remain, go to patch tag, not unpublish.
```

---

## Release-day checklist condition

Before pushing any release tag:

- [ ] `pnpm run check` passes locally (build + typecheck + lint + format + test)
- [ ] All packages are bumped to the release version
- [ ] `NPM_TOKEN` is valid (`npm whoami --registry https://registry.npmjs.org`)
- [ ] CHANGELOG.md entry is written
- [ ] Boundary 5 gate cleared (see `docs/DEPLOYMENT-RUNBOOK.md`)
- [ ] This recovery runbook is current for the release version

See also: `docs/RELEASE-POLICY.md` for the full release process.

---

## Preventing partial publishes (future work)

File a tracking issue before implementing:

1. Pre-publish check: verify all packages at same version and none already on npm
2. Per-package publish steps with explicit continue-on-error and post-step triage
3. Post-publish verification that all expected packages are present on npm
