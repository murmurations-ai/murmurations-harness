# Deployment Runbook

Operational runbook for deploying and promoting the Murmuration Harness daemon.
This document is the authoritative reference for deployment gate requirements.

---

## Pre-deployment gate checklist

All checks must pass before promoting to production or pushing a release tag.

### Gate 1 — Boundary 5 integration points (required before any release)

Boundary 5 is the directive validation boundary: the `validateWake()` function at
`packages/core/src/execution/index.ts` that verifies agent wakes addressed assigned
directives with structured action, not narrative-only claims.

**Durable commit pattern check:**
Confirm `packages/core/src/execution/index.ts` exports `UnaddressedDirective` and
`directivesUnaddressed` on `WakeValidationResult`. Run:

```bash
grep -n 'UnaddressedDirective\|directivesUnaddressed' \
  packages/core/src/execution/index.ts | head -10
# Expected: type definition and field usage both present
```

**Observability coverage check:**
Confirm the daemon emits `daemon.wake.directives.unaddressed` when directives are
unaddressed. Run:

```bash
grep -n 'daemon.wake.directives.unaddressed' \
  packages/core/src/daemon/index.ts
# Expected: at least one grep hit (warn log call)
```

**Unit test coverage gate:**

```bash
npx vitest run packages/core/src/execution/execution.test.ts
# Expected: all tests pass, including narrative-only-claim and no-structured-action cases
# Minimum test count for B5 coverage: 52 tests in execution.test.ts
```

**Gate 1 clearance status (current):**

- [x] `UnaddressedDirective` type present in execution/index.ts
- [x] `directivesUnaddressed` field on `WakeValidationResult`
- [x] `daemon.wake.directives.unaddressed` warn log event in daemon/index.ts
- [x] 52 execution tests passing (confirmed in PR #240 merge)
- [x] CI runs `pnpm test` on every push to main and every PR

Gate 1 was cleared with the merge of PR #240 (feat(execution): Boundary 5 Phase 1).
For Phase 2 prevention work, Gate 1 requirements will expand — update this section
when Phase 2 ships.

---

### Gate 2 — IaC gate artifact (required before IaC deployment gate lifts)

The IaC deployment gate requires a trust boundary sign-off document authored by
security-agent before any IaC changes are promoted.

**What the IaC gate artifact must contain:**

The sign-off document (`docs/security/iac-gate-<date>.md` or equivalent) must include:

1. **Scope declaration** — which IaC components are covered by this review
2. **Trust boundary assessment** — confirmation that the deployment does not
   introduce new trust boundaries without corresponding threat model entries
3. **Secrets posture** — confirmation that no secrets are baked into IaC templates
   or exposed via state files
4. **Security-agent sign-off** — explicit LGTM or approval statement from
   security-agent (#25), with the GitHub issue or commit reference

**The gate is NOT lifted if:**

- No sign-off document exists in `docs/security/`
- The sign-off document exists but was authored before the current IaC change set
- The sign-off document covers different scope than the current deployment
- security-agent raised an unresolved blocking objection on the relevant PR or issue

**How to check gate status:**

```bash
ls docs/security/
# Look for iac-gate-*.md or equivalent sign-off document
# Cross-reference with the current IaC change date and scope
```

**Escalation path:**
If no sign-off document exists, file a request on the EP GitHub issue tracker
(`xeeban/emergent-praxis`) assigned to `security-agent` with label `priority:high`
and `assigned:security-agent`. Do not lift the IaC gate without the artifact.
The gate is owned by devops-release-agent; the artifact is owned by security-agent.

---

### Gate 3 — Full CI gate

```bash
pnpm run check
# Equivalent to: pnpm build && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
# Must exit 0 with zero errors
```

The CI pipeline (`.github/workflows/ci.yml`) runs this automatically on every push
to main and every PR. Check CI green status on the commit being promoted.

---

## Partial publish recovery

See `docs/RELEASE-RECOVERY.md` for the full procedure.

**Quick reference decision tree:**

1. Run triage script (check npm registry per package)
2. If partial: deprecate published packages immediately
3. If < 24h and no consumers: unpublish reverse-order, fix, re-tag, re-push
4. If > 24h or consumers exist: cut a patch tag (e.g., 0.7.2)
5. Never push a release tag without the release-day checklist in RELEASE-RECOVERY.md

---

## Daemon deployment (EP instance)

The EP murmuration daemon runs on a VPS as a systemd service. This section will
be expanded when the systemd unit file and VPS provisioning are completed (Phase 1).

Placeholder gate checks (to be confirmed when Phase 1 ships):

- [ ] systemd unit file present at `/etc/systemd/system/murmurations.service`
- [ ] Log rotation configured at `/etc/logrotate.d/murmurations`
- [ ] Health check endpoint responding at configured port
- [ ] Daemon restarts cleanly after `systemctl restart murmurations`

---

## References

- `docs/RELEASE-POLICY.md` — versioning, release process, milestones
- `docs/RELEASE-RECOVERY.md` — partial publish recovery procedures
- `docs/threat-model.md` — T2.1 source-directive label provenance, T1.x trust boundaries
- `docs/ARCHITECTURE.md` — Engineering Standard 12: narrative claims do not count as evidence
- PR #240 — Boundary 5 Phase 1 directive validation (merged)
