# Convention: GitHub issues vs. repository files

**Audience:** Operators wiring agent `role.md` / `soul.md`, and agents reading these conventions during a wake.

## Why this matters

Every open GitHub issue lands in every watching agent's signal bundle on
every wake. If a murmuration has 10 agents and 30 perpetually-open digest
issues, each wake pulls in 30 issues × 10 agents × (daily or hourly
cadence) — a meaningful chunk of the agent's context budget burned on
static reports the agent has already seen.

The rule is simple: **issues are for actionable coordination; everything
else goes to the filesystem**.

## File this in the repository (NOT as a GitHub issue)

| Artifact kind                                                       | Suggested path                                                        |
| ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Daily/weekly digests, status reports                                | `chronicles/<agent>/YYYY-MM-DD.md` or `digests/<agent>/YYYY-MM-DD.md` |
| Meeting minutes (record of what was said)                           | `meetings/<group>/YYYY-MM-DD.md`                                      |
| Research notes, analysis, briefs                                    | `docs/research/` or `drafts/`                                         |
| Operational chronicles, post-incident logs                          | `chronicles/decisions/`, `chronicles/retrospectives/`                 |
| Knowledge artifacts maintained over time (e.g. `baseline.md`, FAQs) | A stable path inside the relevant domain                              |

The principle: if the artifact's job is to be **read** (now or later),
it's a file. Files don't burn context the next time an agent wakes.

## File this as a GitHub issue (NOT a file)

| Artifact kind                                      | Why issue                                                             |
| -------------------------------------------------- | --------------------------------------------------------------------- |
| Action items — "agent X needs to do Y"             | Other agents pick it up from their signal bundle; close on completion |
| Source-input requests — "Nori, decide on Z"        | Source's queue is the open-issue list                                 |
| Cross-agent coordination / handoffs                | Issue thread is the canonical place for the exchange                  |
| Tensions (governance items requiring response)     | Plugin-defined governance flow runs through issues                    |
| Bugs / incidents requiring tracking until resolved | State (open vs. closed) is the signal                                 |

The principle: if the artifact's job is to **drive action by someone
other than the author**, it's an issue — and it gets closed when the
action is done.

## Closure responsibility

- **The agent that filed an issue closes it when the action is done.**
  The agent has the most context on whether the work is complete.
- **Source can close any issue** when it's no longer relevant.
- **Meeting facilitators close meeting issues** at meeting close (after
  the minutes file is committed and any action items are filed as
  separate issues).

## Decision tree

When an agent has a report or output to produce:

1. Does someone need to take action because of this output? If **no**,
   write a file.
2. Is the action a structured task that needs to be tracked until done?
   If **yes**, file an issue with a clear `Action:` line and an owner
   (assignee label or scope label).
3. Is the action "Source must decide / answer"? If **yes**, file an
   issue with `[DIRECTIVE]` or `tier: consent` and route to Source.
4. Otherwise it's a coordination message between agents — file an issue
   if the receiving agent needs to ack/track it; otherwise, leave the
   information in the source agent's chronicle file and trust the
   receiver to pull it on next wake.

## Anti-patterns to avoid

- **"Digest issues"** that summarize what happened in the wake but ask
  for nothing. → File. Close any existing ones during cleanup sweeps.
- **Meeting issues that stay open after the meeting**, with the minutes
  embedded in comments. → Commit the minutes as a file; close the
  meeting issue.
- **Onboarding kickoff issues that stay open after kickoff**. → Close
  them once the kickoff outcome is committed elsewhere.
- **"Tension" issues that document a systemic harness gap** but offer
  no per-wake action. → File the gap as a harness issue; close the
  per-murmuration tension issue once the harness issue exists.

## Token-budget rationale

Naive cost model for an N-agent murmuration with M open issues:

- Per-wake context cost ≈ M × (avg issue size) × (issues-in-bundle ratio)
- Daily cost across all agents ≈ N × M × ... × (wakes/day)

Closing perpetually-open digest issues is one of the highest-leverage
moves an operator can make to reduce a murmuration's running cost.
Empirically, sweeps that close 15+ stale issues have reduced per-wake
input tokens by 20–40% on murmurations of ~6–10 agents.

## See also

- The `findIncompleteAgents` boot guard in v0.8.0 enforces an analogous
  rule on agent directories: half-configured agents are surfaced and
  skipped, not silently synthesized. The same hygiene applies to
  signal-bundle inputs.
- The `daemon.validate.legacy-fallback` event introduced in v0.8.0
  measures how many wakes still skip the obligation sub-contract;
  a parallel "stale-issue-load" signal is a candidate for a future
  release.
