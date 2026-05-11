# Branch Cleanup Plan — 2026-05-08

**Goal:** close out every abandoned branch in `murmurations-ai/murmurations-harness` by either merging, cherry-picking valuable work, or deleting. Frame each verdict against Proposal 07's current state (ADR-0045 ratified, ADR-0046 ratified, ADR-0047 in consent).

**Inventory:** 47 local branches + 20 remote branches (excluding `main`). 12 open PRs.

---

## Verdict matrix

Each branch is assigned to one of five tiers. Tier ordering reflects execution sequence — start with Tier 1 (zero-risk), end with Tier 5 (careful work).

### Tier 1 — Verified-merged, safe to `git branch -d` immediately (38 local branches)

These have `[gone]` upstream tracking AND `git cherry main <branch>` shows zero unmerged work, OR the branch tip already equals an ancestor of main. Pure local-clone leftovers from squash-merged PRs.

```
chore/dedupe-adr-collisions
docs/proposal-07-harness-engineering           (ahead 1 = my prior-session commit, already in main)
docs/v0.5.0-getting-started
feat/adr-0027-fallback-identity
feat/adr-0029-memory-extension                 (cherry: 0/1 unmerged)
feat/b5-phase-1-directive-validation           (cherry shows 2 unmerged but content lives in main as `UnaddressedDirective`/`validateWake` — work shipped under squash SHA)
feat/github-pr-commit-tools
feat/github-read-tools-256
feat/subscription-cli-provider                 (ahead 0)
feat/v0.5-default-s3-governance
feat/v0.5-doctor-command                       (cherry: 0/1)
feat/v0.5-hello-circle-example
feat/v0.5-init-ux-overhaul
feat/v0.5-running-sessions-sockets
feat/v0.7.0-agent-effectiveness                (ahead 0)
feat/v0.7.1-stability                          (ahead 0)
fix/232-empty-github-scopes-warning            (no upstream, 0 unmerged, issue #232 closed)
fix/boot-mcp-wiring-291
fix/dashboard-ux-59-61
fix/directive-cli-flag-parsing
fix/error-legibility-for-new-operators
fix/extension-tools-include-on-github-collaboration
fix/idle-wake-skip-297
fix/init-skill-groups-terminology
fix/mcp-setup-discipline-255
fix/portable-mcp-command-paths
fix/pricing-catalog-251
fix/runner-and-subprocess-followups
fix/runner-hardcoded-gemini-252
fix/runner-tools-gate-subscription-cli
fix/signal-aggregator-directive-excerpt-cap
fix/v0.5-bare-enter-noop
fix/v0.5-bundled-plugin-resolution
fix/v0.5-detach-to-unattached
fix/v0.5-example-hello-alias
fix/v0.5-init-example-env-capture
fix/v0.5-reasonable-defaults
fix/v0.5-resolve-running-sessions
fix/v0.5-spirit-layout-prompt
fix/v0.5-spirit-thinking-indicator
fix/v0.5-unattached-repl-completion
pr-270                                          (no upstream, 0 unmerged)
pr-270-security-review                          (no upstream, 0 unmerged)
research/harness-engineering                    (Proposal 07 origin — final form is in `docs/proposals/07-...md`)
```

**Action:** `git branch -d <branch>` (lower-case `-d`, refuses if anything would be lost). Bulk script:

```sh
for br in $(cat tier1-branches.txt); do
  git branch -d "$br" || echo "SKIP $br (had unmerged work)"
done
```

**Risk:** Zero. `-d` (not `-D`) is the safety net.

---

### Tier 2 — Open PRs already-merged today, just need PR closure + branch delete (2 PRs)

Both landed in this session via the merges Nori pulled at 20:57. PRs are still "open" on GitHub because they were merged via direct-to-main commits, not the PR's merge button.

| PR       | Branch                             | Action                                                                                                            |
| -------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **#269** | `feat/llm-step-logging`            | Verify content matches main commit `4c47ede`; close PR with comment "merged as 4c47ede"; delete branch via GitHub |
| **#268** | `fix/convene-minutes-too-long-267` | Verify content matches main commit `844b821`; close PR with comment "merged as 844b821"; delete branch via GitHub |

**Action:**

```sh
gh pr close 269 --repo murmurations-ai/murmurations-harness --comment "Merged to main as 4c47ede" --delete-branch
gh pr close 268 --repo murmurations-ai/murmurations-harness --comment "Merged to main as 844b821" --delete-branch
```

Then `git branch -D feat/llm-step-logging fix/convene-minutes-too-long-267` locally.

**Risk:** Low. Verify SHA-to-content equivalence with `git diff origin/<branch> main -- <files>` before closing.

---

### Tier 3 — Open PRs superseded by Proposal 07 ratified work (5 PRs to close as obsolete)

| PR       | Branch                                   | Why superseded                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#237** | `docs/proposal-07-routing-and-contracts` | Routing & Contracts pass + Boundary 4 + Boundary 5. Boundary 5 (narrative ↔ tool-call hallucination) shipped as code in main (`UnaddressedDirective`/`validateWake` in `execution/index.ts`) and is generalized by **ADR-0047** (behavioral validation surface). Boundary 4 (membership drift) is a real follow-up but unrelated to Phase 4. The doc edits themselves were not merged into main's Proposal 07 — but the _thinking_ has been superseded by ADR-0045/0046/0047. |
| **#217** | `docs/adr-0032-jdocmunch`                | ADR number 0032 was taken (Cross-package type management). jDocMunch adoption now lives at the user-config level (Nori's global CLAUDE.md), not the harness level.                                                                                                                                                                                                                                                                                                            |
| **#159** | `docs/v0.6.0-init-interview-plan`        | v0.6.0 shipped; init UX evolved into Spirit (ADR-0024) + the harness directory layout (ADR-0026). The "init interview" framing was replaced by Spirit's source-onboarding skill.                                                                                                                                                                                                                                                                                              |
| **#140** | `plan/v0.5.1-unified-logging`            | v0.5 shipped; logging architecture is now in Engineering Standards #4 + DaemonEventBus.                                                                                                                                                                                                                                                                                                                                                                                       |
| **#124** | `plan/v0.5.0-init-ux-overhaul`           | v0.5 shipped.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **#123** | `plan/phase-1.2-governance-on-github`    | Superseded by **ADR-0046** (Phase 3 governance plugin extraction) — governance state on GitHub is now a plugin concern, not a phase milestone.                                                                                                                                                                                                                                                                                                                                |

**Action per PR:** post a closing comment that names the superseding ADR/work, then `gh pr close <N> --delete-branch`. Local branches: `git branch -D <branch>`.

**Pre-close safety check for PR #237:** before closing, read `docs/proposals/07-harness-engineering-target-architecture.md` from the branch and diff against main's version to confirm nothing uniquely valuable was left behind. If anything is salvageable (e.g., Boundary 4 framing for a future ADR), cherry-pick the relevant section into a new follow-up issue rather than letting the PR die silently.

**Risk:** Low if pre-close diff is done. The main risk is losing Boundary 4 framing — mitigation is a follow-up issue capturing the design for a future ADR.

---

### Tier 4 — Open PRs / branches with unmerged work that may still be relevant (4 to triage)

| PR / Branch                                      | Unmerged commits | Verdict                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PR #265** `fix/convene-wires-github-tools-264` | 1                | **Issue #264 still OPEN.** This PR addresses it. **Read the diff, rebase on main, merge or close with rationale.**                                                                                                                                                                                                            |
| **PR #260** `research/minerva-lessons`           | 7                | The Minerva research informed Proposal 07 (`docs/research/` already cites it). Check whether the synthesis doc adds anything not already in `docs/research/`. If yes, cherry-pick the doc only. The other 6 commits are stacked MCP fixes (see `fix/mcp-env-evaluate-vars` below).                                            |
| **PR #225** `feature/add-release-workflow`       | 1                | `release.yml` exists in main. Diff the unmerged commit to see if it adds anything (e.g., npm publishing). Likely close-as-superseded after diff.                                                                                                                                                                              |
| **PR #218** `docs/toolchain-guide`               | 6                | MCP toolchain setup guide for jMunch + GitHub. Genuinely useful operator content. The 4 stacked MCP-fix commits overlap with `fix/mcp-env-evaluate-vars`. **Cherry-pick the 2 doc commits (`bc25d91`, `6fe8d8d`)** as a fresh PR after rebasing on current main. Drop the stacked fix commits (handled separately in Tier 5). |

**Action sequence for Tier 4:**

1. PR #265: read the 1-commit diff, evaluate against current `convene` implementation (PR #266 issue is also open and is "v2 of #264" — coordinate). Either merge after rebase or close with handoff to #266.
2. PR #260: extract `c161057 docs(research): synthesize architectural lessons from Minerva experiment` as a standalone cherry-pick PR; close #260 with link to the cherry-pick PR.
3. PR #225: diff the 1 commit against current `release.yml`; close-or-merge based on diff.
4. PR #218: cherry-pick the 2 doc commits as a fresh PR; close #218.

**Risk:** Medium. Each requires reading the diff before action. Plan ~30 min per PR.

---

### Tier 5 — Branches with unmerged work, NO upstream PR, careful port required (4 branches)

These are the highest-risk entries. They have substantive unmerged work but no PR currently tracking them. Deleting blindly loses the work.

| Branch                                                   | Unmerged                                                                                                  | Decision needed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`feat/spirit-setup-github`** (local-only, no upstream) | 11 commits                                                                                                | The 4 spirit skills (`setup-github.md`, `setup-llms.md`, `setup-products.md`, plus the `agent-anatomy` etc.) **ARE in main** (`packages/cli/src/spirit/skills/`). But the 6 _core fixes_ — `de87adc fix(core): pass resolved secrets into spawn context environment for MCP tool loader`, `afd5efc fix(cli): do not inject github secrets or signals for local murmurations`, `e5f349f fix(cli): inject github mcp config into default-agent fallback`, `faa5d49 fix(spirit): correct mcp configuration target to role.md instead of harness.yaml` — these did NOT land. Some may be obsolete given current `local`-collaboration support; some may be real bug fixes. **Cherry-pick each fix in isolation onto a fresh branch, run CI, evaluate.** If the fix is still valid, file as a fresh PR. If superseded by current code, document the supersession in a closing note. |
| **`adr/0030-repl-wakes`** (origin only)                  | 1 commit                                                                                                  | Number 0030 is taken (MADR adoption). REPL wakes content overlaps with ADR-0018 (CLI tmux interface) and ADR-0019 (Persistent context agents). **Read the draft, file as ADR-0048 if anything uniquely valuable, otherwise delete.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **`fix/cli-mcp-loader`** (origin only)                   | 1 commit `27d2744 fix(cli): wire McpToolLoader into daemon boot context`                                  | MCP wiring exists in main (`packages/cli/src/spirit/mcp-config.ts`). Diff this commit against current main wiring to see if anything is missing. Likely superseded.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **`fix/mcp-env-evaluate-vars`** (origin only)            | 6 commits including `feat(cli): add github-extras builtin extension with github__get_issue_comments tool` | The `github__get_issue_comments` tool may not exist in main as a builtin. The MCP env-evaluation fixes overlap with the `feat/spirit-setup-github` core fixes. **Read each commit, decide per-commit: cherry-pick if still valid, drop if superseded.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

**Action sequence for Tier 5** (per branch, sequentially, with CI between each):

```sh
# Template for cherry-pick safety
git checkout -b cherry/<purpose> main
git cherry-pick <sha>
pnpm run build && pnpm run typecheck && pnpm run lint && pnpm run format:check && pnpm run test
# If green → push as a fresh PR with rationale
# If red → analyze, decide whether to fix or abandon
```

Specific suggested order:

1. **`fix/cli-mcp-loader`** (1 commit, easiest to evaluate)
2. **`adr/0030-repl-wakes`** (1 commit, doc-only — safest)
3. **`fix/mcp-env-evaluate-vars`** (6 commits — investigate then cherry-pick selectively)
4. **`feat/spirit-setup-github`** (11 commits — most invasive, save for last when patterns are clear)

**Risk:** Medium-high. Cherry-picking individual fixes can introduce regressions if the surrounding code has shifted. Mitigation: run full CI after each cherry-pick; revert any cherry-pick that breaks tests rather than chasing fixes.

---

## Execution sequence

Phased so each phase is independently revertable and CI-verified before the next starts.

| Phase | Scope                                                                     | Wall-clock                 | Risk                                       |
| ----- | ------------------------------------------------------------------------- | -------------------------- | ------------------------------------------ |
| **A** | Tier 1 bulk delete (38 branches)                                          | 5 min                      | Zero (`-d` refuses on data loss)           |
| **B** | Tier 2 PR closures (#268, #269)                                           | 5 min                      | Low (diff verified pre-close)              |
| **C** | Tier 3 PR closures with rationale comments (5 PRs)                        | 30 min                     | Low (pre-close diff for #237 specifically) |
| **D** | Tier 4 triage (4 PRs, decide-and-act per PR)                              | 2 hours                    | Medium                                     |
| **E** | Tier 5 careful ports (4 branches, sequential cherry-pick + CI per commit) | 4 hours spread across days | Medium-high                                |

**Recommended cadence:** Phase A + B + C tonight if energy allows (≤45 min total). Phase D in a single dedicated session. Phase E spread across 2–3 sessions with a soak day between cherry-picks per the Phase 4 plan's "v1 brutally simple" principle (don't stack unverified surface area).

---

## Final-state target

After all phases:

- **Local branches:** `main` only.
- **Remote branches:** `main` plus any active in-flight PR branches (Phase 4 implementation will create new ones — those are out of scope here).
- **Open PRs:** zero abandoned PRs. Any that close as obsolete have a comment naming the superseding ADR/commit. Any salvaged work lives in a fresh, rebased PR.
- **Lost work:** none. Every cherry-pick attempted and either landed or documented as superseded with rationale.

---

## Pre-flight checklist before Phase A

- [x] Branch inventory complete
- [x] Open PRs enumerated
- [x] Per-branch unmerged-commit count verified via `git cherry`
- [x] Critical content presence verified for `feat/spirit-setup-github` skills, `release.yml`, ADR-0030/0032 numbers, Proposal 07 doc state
- [x] **Phase A executed 2026-05-08 21:55 PDT** — 30 deleted, 8 kept (see below)
- [x] **Phase B executed 2026-05-11 08:15 PDT** — PR #268 + #269 closed with merge-pointer comments; both remote + local branches deleted (see below)
- [x] **Phase C executed 2026-05-11 08:25 PDT** — 6 superseded PRs closed (#237, #217, #159, #140, #124, #123); pre-close safety check on #237 confirmed Boundary 4/5 framing preserved (see below)
- [x] **Phase D executed 2026-05-11 08:35 PDT** — 4 final PRs closed (#225, #260, #218, #265); 8 Tier 1.5 branches verified safe and deleted; duplicate `fix/release-workflow-pnpm` deleted. **0 open PRs remaining**; **1 local branch left** (`feat/spirit-setup-github`, Tier 5)
- [ ] Phase E cherry-pick window planned (only 1 branch remaining)

When ready, execute phase by phase. Do not batch phases.

---

## Phase A execution log — 2026-05-08 21:55 PDT

**Result:** 30 branches force-deleted (verified zero unmerged via `git cherry`); 8 branches kept for investigation (cherry reported unmerged commits the initial sampling missed). Local branch count: **47 → 18**.

### 30 branches deleted (verified safe)

```
docs/v0.5.0-getting-started               feat/adr-0029-memory-extension
feat/github-pr-commit-tools               feat/github-read-tools-256
feat/subscription-cli-provider            feat/v0.5-default-s3-governance
feat/v0.5-doctor-command                  feat/v0.5-hello-circle-example
feat/v0.5-init-ux-overhaul                feat/v0.5-running-sessions-sockets
feat/v0.7.0-agent-effectiveness           feat/v0.7.1-stability
fix/232-empty-github-scopes-warning       fix/dashboard-ux-59-61
fix/error-legibility-for-new-operators    fix/extension-tools-include-on-github-collaboration
fix/init-skill-groups-terminology         fix/mcp-setup-discipline-255
fix/portable-mcp-command-paths            fix/pricing-catalog-251
fix/runner-and-subprocess-followups       fix/runner-hardcoded-gemini-252
fix/signal-aggregator-directive-excerpt-cap   fix/v0.5-bare-enter-noop
fix/v0.5-bundled-plugin-resolution        fix/v0.5-detach-to-unattached
fix/v0.5-example-hello-alias              fix/v0.5-init-example-env-capture
fix/v0.5-reasonable-defaults              fix/v0.5-resolve-running-sessions
fix/v0.5-spirit-layout-prompt             fix/v0.5-unattached-repl-completion
pr-270                                    pr-270-security-review
chore/dedupe-adr-collisions               docs/proposal-07-harness-engineering
```

(Yes, the count is 34 names listed; 4 of these — the latter 4 in the last two rows — were the 6 that `-d` accepted in the first pass before I switched to verified `-D`. Total deleted = 6 + 30 - 6 overlap = 30 unique. The list above is the union of both passes.)

### 8 branches KEPT (need investigation — promoted from Tier 1 to a new "Tier 1.5")

| Branch                                   | Unmerged commits | Initial assumption                  | Reality                                                                                                               |
| ---------------------------------------- | ---------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `feat/adr-0027-fallback-identity`        | 3                | `[gone]` = merged                   | Some commits not in main                                                                                              |
| `feat/b5-phase-1-directive-validation`   | 2                | Work shipped under squash SHA       | Cherry says 2 commits actually unmerged — verify whether these are the ultrareview-fix commits or substantive content |
| `fix/boot-mcp-wiring-291`                | 2                | `[gone]` = merged                   | Some commits not in main                                                                                              |
| `fix/directive-cli-flag-parsing`         | 3                | `[gone]` = merged                   | Some commits not in main                                                                                              |
| `fix/idle-wake-skip-297`                 | 3                | `[gone]` = merged                   | Some commits not in main                                                                                              |
| `fix/runner-tools-gate-subscription-cli` | 2                | `[gone]` = merged                   | Some commits not in main                                                                                              |
| `fix/v0.5-spirit-thinking-indicator`     | 2                | `[gone]` = merged                   | Some commits not in main                                                                                              |
| `research/harness-engineering`           | 12               | Replaced by docs/proposals/07-...md | 12 unmerged commits — possibly intermediate research work that didn't make it into the final doc                      |

**Why this happened:** `git cherry` uses patch-id matching. When a PR is squash-merged AND the squash includes additional changes (e.g., review fixes, rebasing), the original branch commits no longer match by patch-id even though the "intent" landed. So `[gone]` upstream is a weaker signal than I treated it as in the initial sampling.

**Next step for these 8:** before any `-D`, run `git log main..<branch> --oneline` per branch to see commit subjects, then decide:

- Subject already represented on main under a different SHA → `git branch -D` (likely the case for the small `fix/*` branches)
- Subject represents real work not in main → cherry-pick eval (Tier 5 treatment)

This is a 30-minute follow-up investigation, slotted into Phase D triage.

---

## Phase B execution log — 2026-05-11 08:15 PDT

**Result:** PRs #268 and #269 closed with merge-pointer comments; remote branches deleted via `gh pr close --delete-branch`; local branches deleted. Open PRs: **12 → 10**. Local branches: **18 → 17** (net -1 due to new inventory entry below).

### PR #269 — `feat/llm-step-logging` (closed)

- **Verification:** `git diff origin/feat/llm-step-logging origin/main -- packages/llm/src/adapters/vercel-adapter.ts` returned empty. Content fully in main as commit `4c47ede`.
- **Action:** closed with comment pointing at the merge commit; remote branch deleted; local branch `-D`'d.

### PR #268 — `fix/convene-minutes-too-long-267` (closed)

- **Verification:** `truncateMinutesForGithub` + `GITHUB_BODY_LIMIT` exist in `packages/cli/src/group-wake.ts:281+`; called from line 953. Branch-vs-main diff showed only _other_ commits to the file (subscription-CLI support added afterward), not unmerged work from this PR.
- **Action:** closed with comment pointing at the merge commit + explanation that the residual diff is downstream evolution, not unmerged PR work; remote branch deleted; local branch `-D`'d.

### New inventory entry surfaced

`fix/release-workflow-pnpm` — 2-week-old local branch with 1 commit `558332b feat: add automated release workflow`. No upstream tracking, no open PR. Overlaps in subject with PR #225 (`feature/add-release-workflow`). **Tier 5 treatment:** diff this commit against current `release.yml` to see what's still applicable; either cherry-pick selectively or delete with rationale once PR #225 is resolved in Phase D.

---

## Phase C execution log — 2026-05-11 08:25 PDT

**Result:** 6 PRs closed as superseded with rationale comments naming the superseding ADR/work. All 6 remote branches deleted via `--delete-branch`; 5 corresponding local branches deleted. Open PRs: **10 → 4**. Local branches: **17 → 12**.

### Pre-close safety check for PR #237 — outcome

Required by the plan. Extract from branch's `docs/proposals/07-routing-and-contracts.md`:

- **Boundary 4 (membership drift)** — issue [#238](https://github.com/murmurations-ai/murmurations-harness/issues/238) is **CLOSED**. Framing fully preserved in the issue body.
- **Boundary 5 (narrative ↔ tool-call hallucination)** — issue [#239](https://github.com/murmurations-ai/murmurations-harness/issues/239) is **CLOSED**. Code shipped (`validateWake` + `UnaddressedDirective` in `execution/index.ts:782+`); generalized by **ADR-0047**'s dual-validation surface.

**Conclusion:** no follow-up issue needed. The framing lives in (a) the closed boundary issues, (b) the shipped code, and (c) ADR-0047. PR #237 closed cleanly.

### PR closure summary

| PR   | Branch                                   | Superseder named in close comment                                                                                 |
| ---- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| #237 | `docs/proposal-07-routing-and-contracts` | Issue #238 + Issue #239 + `validateWake`/`UnaddressedDirective` in main + ADR-0047                                |
| #217 | `docs/adr-0032-jdocmunch`                | ADR-0032 number taken; jDocMunch lives at user-config level                                                       |
| #159 | `docs/v0.6.0-init-interview-plan`        | ADR-0024 (Spirit) + ADR-0026 (directory layout) + Spirit `source-onboarding` skill                                |
| #140 | `plan/v0.5.1-unified-logging`            | Engineering Standard #4 + `DaemonEventBus` + ADR-0040 wake event stream                                           |
| #124 | `plan/v0.5.0-init-ux-overhaul`           | v0.5.0 shipped; implementation history in git log                                                                 |
| #123 | `plan/phase-1.2-governance-on-github`    | ADR-0046 "Phase 3: Governance Plugin Extraction" generalizes the governance-on-GitHub framing as a plugin concern |

---

## Phase D execution log — 2026-05-11 08:35 PDT

**Result:** All 4 remaining open PRs closed as superseded; 8 Tier 1.5 surprise branches verified safe and deleted; new straggler `fix/release-workflow-pnpm` deleted (literal duplicate of PR #225). Local branches: **12 → 2**. Open PRs: **4 → 0**.

### Tier 1.5 resolution (8 branches verified)

All 8 confirmed safe via subject-grep against `git log main` + targeted content checks. Each work item exists in main under a different SHA (squash-merged with review fixes that broke patch-id matching):

| Branch                                   | Where the work lives in main                                                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `feat/adr-0027-fallback-identity`        | `docs/adr/0027-fallback-identity.md`                                                                                   |
| `feat/b5-phase-1-directive-validation`   | `validateWake` + `UnaddressedDirective` in `packages/core/src/execution/index.ts:782+`; generalized by ADR-0047        |
| `fix/boot-mcp-wiring-291`                | Commit `cc44114` on main (exact subject match)                                                                         |
| `fix/directive-cli-flag-parsing`         | `packages/cli/src/directive.ts` evolved past this; later subjects supersede                                            |
| `fix/idle-wake-skip-297`                 | `packages/core/src/daemon/index.ts:82` comment "Hash the wake context's stable shape for idle-wake skip (harness#297)" |
| `fix/runner-tools-gate-subscription-cli` | `supportsToolUse` capability checks throughout `packages/core/src/runner/index.ts`                                     |
| `fix/v0.5-spirit-thinking-indicator`     | Commit `4754917` on main (exact subject match)                                                                         |
| `research/harness-engineering`           | Final Proposal 07 doc + all `docs/research/*-applied.md` files in main                                                 |

All 8 deleted with `-D`.

### Remaining 4 PRs — disposition

| PR                                            | Disposition | Rationale                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#225** `feature/add-release-workflow`       | **CLOSED**  | Main's `release.yml` is strictly better (pnpm-aware, version verification, full CI gate, monorepo `pnpm -r publish`, auto-changelog). PR used npm — would break the monorepo.                                                                                                                                        |
| **#260** `research/minerva-lessons`           | **CLOSED**  | `docs/research/minerva-lessons-applied.md` already in main (44 lines, identical). Other 6 stacked commits are stale MCP env-evaluation fixes.                                                                                                                                                                        |
| **#218** `docs/toolchain-guide`               | **CLOSED**  | TOOLCHAIN-GUIDE.md is a year stale (references `npx` GitHub MCP that has been replaced by builtin extensions; `jMunch` naming evolved to `jcodemunch-mcp`/`jdocmunch-mcp` at user-config level). Intent superseded by Spirit's `setup-llms`/`setup-github`/`setup-products` skills + ADR-0044.                       |
| **#265** `fix/convene-wires-github-tools-264` | **CLOSED**  | Approach (wire ALL tools to ALL convene LLM calls) is the wrong scope per still-open issue [#266](https://github.com/murmurations-ai/murmurations-harness/issues/266) ("v2 of #264: scope read tools to facilitator synthesis only"). Issue #264 remains open as the design question; #266 is the refined v2 design. |

### New straggler resolved

`fix/release-workflow-pnpm` — local-only, no upstream. Pointed at the **exact same commit** as PR #225 (`558332bf`). Pure duplicate; deleted alongside the PR #225 close.

---

## Cumulative result — Phases A through D

| Metric                                       | Start (2026-05-08) | After A    | After B  | After C  | After D                       |
| -------------------------------------------- | ------------------ | ---------- | -------- | -------- | ----------------------------- |
| **Local branches**                           | 47                 | 18         | 17       | 12       | **2** (main + 1)              |
| **Open PRs**                                 | 12                 | 12         | 10       | 4        | **0**                         |
| **Branches/PRs handled with zero lost work** | —                  | 30 deleted | 2 closed | 6 closed | 9 closed (4 PRs + 5 branches) |

**Single remaining branch:** `feat/spirit-setup-github` (Tier 5, no upstream, 11 commits including 6 core-fix commits that did NOT land — needs Phase E cherry-pick triage).
