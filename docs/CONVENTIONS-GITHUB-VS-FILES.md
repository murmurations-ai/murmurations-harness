# Convention: GitHub issues vs. repository files

**Audience:** Operators wiring agent `role.md` / `soul.md`, and agents reading these conventions during a wake.

## Why this matters

Every open GitHub issue lands in every watching agent's signal bundle on every wake. Perpetually-open digest issues sit in the bundle until they're closed — re-fetched and re-read by every agent every cycle. The harness already filters per-agent (routing-label scope at `packages/signals/src/index.ts`), and excerpt sizes are capped, so the cost is bounded — but the cap is large (`EXCERPT_MAX_CHARS = 64_000` per signal, up to 20 comments per issue), and one chatty issue carries more weight than many sparse ones.

The rule is simple: **issues are for actionable coordination; everything else goes to the filesystem.**

## Scope reconciliation with `GITHUB-AS-SYSTEM-OF-RECORD.md`

Both GitHub issues and committed files are the system of record. The harness's "GitHub as SoR" claim still holds for the auditable, collaborative, multi-instance properties named in that doc. This convention partitions by **purpose** (drive action vs. be read), not by **durability** — committed files are equally durable, equally auditable, and travel with the code without requiring GitHub auth for offline read.

## File this in the repository (NOT as a GitHub issue)

| Artifact kind                                                       | Suggested path                                                                                |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Daily/weekly digests, status reports                                | `chronicles/<agent>/YYYY-MM-DD.md`                                                            |
| Meeting minutes (record of what was said)                           | `meetings/<group>/YYYY-MM-DD.md`                                                              |
| Research notes, analysis, briefs                                    | `docs/research/` or `drafts/`                                                                 |
| Operational chronicles, post-incident logs                          | `chronicles/decisions/`, `chronicles/retrospectives/`                                         |
| Knowledge artifacts maintained over time (e.g. `baseline.md`, FAQs) | A stable path inside the relevant domain                                                      |
| **Ratified governance decisions**                                   | `governance/decisions/<id>.md` (referenced by the closing comment on the consent-round issue) |

If the artifact's job is to be **read** (now or later), it's a file. Files don't burn context the next time an agent wakes.

## File this as a GitHub issue (NOT a file)

| Artifact kind                                                                                    | Why issue                                                                                         |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Action items — "agent X needs to do Y"                                                           | Other agents pick it up from their signal bundle; close on completion                             |
| Source-input requests — "Nori, decide on Z"                                                      | Source's queue is the open-issue list                                                             |
| Cross-agent coordination / handoffs                                                              | Issue thread is the canonical place for the exchange                                              |
| Tensions, proposals, consent rounds (governance items requiring response)                        | The plugin-defined governance flow runs through issues                                            |
| Bugs / incidents requiring tracking until resolved                                               | State (open vs. closed) is the signal                                                             |
| A **single rolling aggregator issue** per domain (Renovate-style "Dependency Dashboard" pattern) | One bot-owned issue with checkboxes is fine; many digest issues are not — see the exception below |

If the artifact's job is to **drive action by someone other than the author**, it's an issue — and it gets closed when the action is done. The cleanest framing (IssueOps terminology): an issue exists when it has a **state transition another agent or human observes**.

## Three exceptions where neither a plain file nor a typical issue is the right answer

1. **Single rolling aggregator issue (Renovate "Dependency Dashboard" pattern).** If a domain needs a clickable surface — e.g. "open the Mayne-Island dashboard and tick what's actually done" — one perpetually-open issue, owned by the bot, with a body the bot rewrites in place, is fine. It is _one_ issue per domain, not N per cadence. Examples where this is right: a "next-action board" per group; a list of in-flight CRA installments. The line between this and an anti-pattern: if the bot is appending comments instead of rewriting the body, you're back to digest-issue noise.

2. **Public/operator-visible surface.** Files in a private repo are not discoverable by anyone outside the contributor set. If a digest or status needs visibility to a broader audience (newsletter subscribers, partners, the public), the right answer is **GitHub Pages** generated from the chronicles directory, or a **separate public mirror repo** — not an in-repo file (audience can't see it) and not an issue (defeats the convention).

3. **GitHub Discussions.** Convention does not use Discussions. Reasoning: Discussions are still a GitHub API surface that could be pulled into the signal bundle, and they require GitHub auth for offline read. Git history is our discourse log because it travels with the code.

## Closure responsibility

- **The agent that filed an issue closes it when the action is done.** The agent has the most context on whether the work is complete.
- **Source can close any issue** when it's no longer relevant.
- **Meeting facilitators close meeting issues** at meeting close — after the minutes file is committed and any action items are filed as separate issues. (If a meeting doesn't have separate-action follow-ups and the minutes file is the only output, no meeting issue need exist.)
- **Closure-failure fallback.** Subscription-CLI mutations can fail silently. If an agent attempts a close and it fails, the agent should leave a `Done: ...` comment on the issue so a sweep can later reconcile by closing-by-comment-marker.
- **Don't auto-close certain tiers regardless of age.** `tier: consent`, `source-input`, and `bug` labels should never be swept by staleness alone — silent auto-close on these is the well-known stale-bot anti-pattern that destroys real reported work.

## Decision tree

When an agent has a report or output to produce:

1. **Does someone need to take action because of this output?** If **no**, write a file.
2. **Is the artifact's value a state transition another agent or human observes?** If **yes**, file an issue. (E.g. `assigned:foo-agent` watching a label change; Source watching a `tier: consent` queue.) If **no**, write a file.
3. **Is it a single-exchange Q&A between agents?** File an issue. The receiving agent answers in a comment and **immediately closes the issue** — don't leave it open as a record of having answered.
4. **Is it Source-input?** File an issue with `[DIRECTIVE]` or `tier: consent` and route to Source via the right circle labels.
5. **Otherwise it's a coordination message** — file an issue if the receiving agent needs to ack/track it; otherwise, leave the information in the source agent's chronicle file and trust the receiver to pull it on next wake.

## File-write discipline (the corollary)

Issues are append-only by construction (comments + timeline). Files are not. If we replace issues with files, we have to enforce the discipline that issues provided for free:

- **One file per wake, never rewritten.** A digest from `mayne-island-agent` on 2026-05-21 lives at `chronicles/mayne-island-agent/2026-05-21.md` and is not modified after the wake closes. The next wake writes a new dated file.
- **Cumulative artifacts are append-only or versioned.** `baseline.md`, FAQs, knowledge files — if multiple wakes contribute, either append (clearly date-stamped) or maintain prior versions under `archive/`.
- **Don't squash the audit trail.** A force-pushed branch that rewrites a chronicle file destroys the audit property the issue would have given you for free.

## Cross-agent visibility (open question, harness-level)

Issues had a side benefit the convention removes: by sitting in every agent's signal bundle, digest issues inadvertently kept agents aware of each other's state. With digests in files, no agent sees another's daily report unless something specific surfaces it.

Two paths to restore cross-agent visibility, neither shipped yet:

- **File-signal aggregator source.** The signal aggregator currently reads GitHub issues + private notes. A file-signal source would surface recent commits under `chronicles/` into peer agents' signal bundles, capped to a small number per peer per wake.
- **Weekly synthesis issue per group.** One bot-owned aggregator issue (per the Renovate pattern in §Exceptions) that the facilitator updates with last-week's chronicle file links. Lower harness surface area, requires facilitator discipline.

Tracked at murmurations-ai/murmurations-harness#394.

## Anti-patterns to avoid

**Over-filing as issues:**

- "Digest issues" that summarize what happened in the wake but ask for nothing. → File. Close any existing ones during cleanup sweeps.
- Meeting issues that stay open after the meeting, with the minutes embedded in comments. → Commit the minutes as a file; close the meeting issue.
- Onboarding kickoff issues that stay open after kickoff. → Close them once the kickoff outcome is committed elsewhere.
- "Tension" issues that document a systemic harness gap but offer no per-wake action. → File the gap as a harness issue; close the per-murmuration tension issue once the harness issue exists.
- **One verbose issue with 50+ comments ≈ 30 well-behaved status issues** in context cost. Comment-count, not issue-count, is the real signal-bundle load driver. If a thread has grown long, split off any unresolved sub-thread as a new issue and close the parent.

**Under-filing as files (the opposite direction):**

- Action items hidden inside chronicle prose. → If a paragraph contains "Source should decide X", that's an issue, not a buried line in a file no other agent will read.
- Tensions written up as research briefs. → Governance items need the issue surface so the governance plugin can drive them through the right state machine.
- Cross-agent handoffs left in your own chronicle expecting the receiver to discover them. → If the receiver doesn't have your chronicle path in their reading list, the handoff isn't happening.

**Closure hygiene:**

- Auto-closing issues purely by age. → Specifically don't sweep `tier: consent`, `source-input`, or `bug` labels by staleness; Source is the right closure authority for those.

## Token-budget rationale

Naive per-agent cost model:

- Per-wake context cost ≈ `M_per_agent × (issue body + comments excerpt)`, where `M_per_agent` is the issues filtered by the agent's routing-label scope (not the full open-issue count — the harness already filters at `packages/signals/src/index.ts`).
- The dominant variable is not the **count** of open issues; it's the **size** of each (body + up to 20 comments × up to 64 KB each at the current caps).

Concrete signal: the 2026-05-21 Chinook Wind cleanup sweep closed 16 stale issues and observed `cache_read_tokens` reductions in the 58–94% range on the 4 most-active agents the next wake. Attributable causes appear to be a mix of (a) reduced bundle size, (b) cache rotation, (c) closure of one particularly chatty issue thread. The savings are real and material; the exact attribution is sweep-dependent.

## Higher-leverage harness-side levers (complementary to this convention)

Operator discipline (this convention) is necessary but not sufficient. The biggest per-wake cost reductions come from harness-side changes the operator can request via #394:

- **Lower `MAX_COMMENTS_PER_ISSUE`** (currently 20) → ~5 with a "+N more" tail summary. Single-line change, immediate ~50% cut on chatty issues.
- **Lower `EXCERPT_MAX_CHARS`** (currently 64,000) → 8-16K with LLM summarization for overflow. Already flagged as a follow-up in the signals package.
- **Per-issue staleness label that excludes from signal bundle** (without closing). The right answer for slow-burn governance items where Source is the closure authority but the agents don't need to re-read every wake.
- **`daemon.signal-bundle.large` event.** Observability so operators can _see_ whether sweeps and excerpt-cap changes help.

## Migration path

This PR updates the **default-agent role.md template** and the in-process synthesized fallback. Agents with their own `role.md` in operator repos are not auto-updated. The migration path:

- The Source directives at `xeeban/emergent-praxis#900` and `xeeban/chinook-wind#50` notify existing agents.
- Each agent, on next wake, is expected to propose a `role.md` edit if its current role text directs it to file digests as issues.
- A future harness `murmuration doctor` check (under #394) can diff operator `role.md` files against the convention's key phrases and surface drift to the operator.

## See also

- `docs/GITHUB-AS-SYSTEM-OF-RECORD.md` — the broader claim this convention specializes.
- The `findIncompleteAgents` boot guard in v0.8.0 enforces an analogous rule on agent directories: half-configured agents are surfaced and skipped, not silently synthesized.
- The `daemon.validate.legacy-fallback` event introduced in v0.8.0 measures how many wakes still skip the obligation sub-contract; the parallel `daemon.signal-bundle.large` event is tracked at #394.
- Industry parallels: **Renovate's Dependency Dashboard** (single aggregator issue pattern), **GitHub IssueOps** (labels-as-state-machine framing), **Argo CD / Flux GitOps** (reconciliation history in git, not in issue trackers).
- Stale-bot harms documented at drewdevault.com and pypa/virtualenv issue #1311.
