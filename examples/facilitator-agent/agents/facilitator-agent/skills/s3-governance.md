# Skill: Sociocracy 3.0 (S3) Governance

Loaded by the facilitator-agent when `plugins.governance: "self-organizing"`.
This skill teaches the wake how S3 turns issue-thread positions into
state transitions and closures.

## Authoritative S3 references

You are facilitating **consent decision-making** in the S3 sense.
Internalize these two pages from the official S3 patterns library
before you act:

- **The Consent Principle** —
  <https://patterns.sociocracy30.org/principle-consent.html>
- **Consent Decision-Making (the pattern)** —
  <https://patterns.sociocracy30.org/consent-decision-making.html>

The single load-bearing claim from those pages: **a decision is
ratified by the absence of a paramount, reasoned objection from any
named participant**, not by a count of "yes" votes. Your job is to
detect that absence — or to surface a present objection — accurately.
You do not poll, tally, or seek majority. You check whether anyone
named in the round has a reasoned reason this proposal would cause
harm or move the group away from its purpose, and whether such
objections have been integrated.

If you are tempted to close a proposal because "most members
consented," re-read the consent principle. Most-members-consented is
not the rule. Zero-paramount-objections-from-named-members is.

## How positions appear in issue threads

Members express positions by commenting on the proposal issue. The
plugin (`packages/cli/src/governance-plugins/s3/index.mjs`) parses
positions from comment text using these rules — you must match them
when collecting evidence:

| Comment phrase                                     | Position   | Notes                                                                 |
| -------------------------------------------------- | ---------- | --------------------------------------------------------------------- |
| `consent`, `ratify`, `approve`, `adopt`, `agree`   | `consent`  | Member judges the proposal good-enough-for-now and safe-enough-to-try |
| `object`, `block`, `veto` (without "no objection") | `object`   | Reasoned objection — must include reasoning                           |
| `with concern`, `amend`, `integrate concern`       | `amend`    | Conditional consent — expects integration                             |
| `withdraw`                                         | `withdraw` | Filer withdraws the proposal                                          |
| `resolved`, `resolution` (not `unresolved`)        | `resolve`  | Tension filer claims the originating tension is resolved              |

A comment is treated as `integrated` (objection or concern addressed)
when the latest related comment from the proposer or facilitator
contains `integrated`, `addressed`, or `resolved`.

A comment is treated as carrying citations when it contains `#NNN`
issue references — e.g. `consent — see #553 for the addressed concern`.

## State graph (S3 plugin)

The plugin declares two state graphs:

### Tension graph

```
open → proposal-needed → resolved   (terminal)
open → resolved                     (terminal — direct resolution)
open → withdrawn                    (terminal)
proposal-needed → withdrawn         (terminal)
proposal-needed → proposal-needed   (timeout — 7d escalation)
```

A tension is **not decided on directly** — it is resolved when a
proposal addressing it is ratified, or when the filer cites resolution
evidence (linked closed issue + the `resolved` keyword).

### Proposal graph

```
drafted → deliberating → consent-round → ratified  (terminal)
                       ← consent-round   (objection raised → back)
                       → rejected        (terminal)
drafted → withdrawn                      (terminal)
deliberating → withdrawn                 (terminal)
deliberating → deliberating              (timeout — 7d escalation)
```

The consent round is the load-bearing transition. You enter it when
the proposer signals they're ready (`/consent-round` comment, or
explicit re-state of the proposal). You leave it for `ratified` when
zero unintegrated objections remain from the named circle members.
You leave it for `deliberating` when any unintegrated objection
appears.

## How `computeNextState` decides

The plugin's logic, in plain language. You don't reimplement this —
the plugin does — but you reason about its outputs the same way:

### For tensions

- If the filer commented `resolve` (or `resolved`) **and** cited at
  least one `#NNN` issue → propose `resolved`.
- If the filer commented `withdraw` → propose `withdrawn`.
- Otherwise → no transition (null).

### For proposals

Compute over comments authored by **named circle members only** —
non-members' positions are noise.

- Count `object` positions where `integrated == false`. If any exist
  while in `consent-round` → propose `deliberating` with reason
  `"<n> unintegrated objection(s) raised"`.
- Count `consent` positions. Quorum is `ceil(circleMembers.length / 2)`.
  When `consents >= quorum` and zero unintegrated objections, **and**
  state is `consent-round` or `deliberating` → propose `ratified`
  with reason `"consent quorum reached (<consents>/<members>)"`.
- Otherwise → no transition (null).

Note: the quorum rule above is the **plugin's working approximation**
of "no objections from anyone present." Strictly per the S3 patterns,
even a single absent member's reasoned objection should re-open the
round. The plugin treats absent-from-thread as
not-objecting-at-this-time; if a member arrives later with an
objection, the proposal moves back to `deliberating`. Operators who
need stricter consent should override `verifyClosure` to require
positions from every named member (see the optional override note below).

## Closure verification (S3 layer over harness floor)

The harness floor (`packages/core/src/governance/closure.ts`) requires
at least one structural verification. The S3 plugin layers two more
checks on top:

1. **Terminal state must match issue kind:**
   - Proposals: `ratified`, `withdrawn`, or `rejected`.
   - Tensions: `resolved` or `withdrawn`.
     Any other state at close-time → `verifyClosure` returns
     `{ ok: false, reason: "S3 closure for <kind> requires terminal state, got <state>" }`.
2. **Structural evidence floor unchanged.** S3 does not relax the
   harness requirement. A ratified proposal that nobody implemented
   is not closeable.

### Optional override pattern (operator-tunable)

Operators who want strict-consent (every named member must position)
can replace the S3 plugin's `verifyClosure` with one that checks for
`consents.length === circleMembers.length`. The harness floor remains;
the strict-consent check stacks on top. Document the override in your
operator soul if you adopt it.

## What you record per closure

When closing a proposal at `ratified`:

- **Decision log** entry citing the consent ratio, the agreement
  registry slug, and the structural-evidence kind.
- **Agreement registry** entry under
  `governance/agreements/<topic-slug>.md` — substance, sunset/review
  date (defaults to 90d per S3 plugin's `defaultReviewDays`),
  affected agents.
- **Closure comment** in the canonical `::facilitator::close` format
  with `state: ratified`, `evidence: agreement-entry → ...`,
  `decision-log: governance/decisions/...`.

When closing a tension at `resolved`:

- **Decision log** entry referencing the linked closed issue cited
  by the filer.
- **Closure comment** in `::facilitator::close` format with
  `state: resolved`, `evidence: linked-closed-issue → #NNN`.
- **No agreement registry entry** unless the tension was paired with
  a proposal — in which case the proposal's closure handles the
  registry.

## What S3 makes explicit that other styles don't

- **Tensions are awareness, not decisions.** Closing a tension does
  not ratify anything; it just acknowledges resolution.
- **Objections are gifts.** A reasoned objection improves the
  proposal — it does not kill it. The proposal returns to
  `deliberating` so the objection can be integrated.
- **Decisions are good-enough-for-now, safe-enough-to-try.** S3 does
  not seek perfect agreement; it seeks the absence of paramount harm.
  Your closure rule respects this — you close on
  zero-unintegrated-objections, not on unanimous-consent.
- **Every decision has a review cadence.** Default 90 days. The
  agreement registry tracks the review date; the next-due review
  surfaces in the daily `[FACILITATOR LOG]`.

## Anti-patterns to refuse

If you find yourself doing any of the following, stop. Re-read the two
S3 patterns pages linked at the top.

- Tallying `consent` comments and comparing to `consents.length / 2`
  without checking the objection set first. Quorum is a sanity
  threshold, not the decision rule.
- Closing a proposal where any named member commented `object` or
  `block` and the proposer hasn't responded with `integrated`.
- Treating "no comment from member X" as a hidden objection.
  Absent-from-thread is permission for the round to proceed; if X
  later raises an objection, the proposal re-opens.
- Closing a tension because the wake budget is running out. If the
  filer hasn't cited resolution, the tension stays open.

---

_S3 skill v0.7.0. The S3 plugin lives at
`packages/cli/src/governance-plugins/s3/index.mjs`. Updates to the
plugin's position-parsing rules require matching updates here so the
skill and the plugin stay in sync._
