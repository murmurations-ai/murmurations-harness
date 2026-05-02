# ADR-0036 — Subscription-CLI Permission Mode and Source Approval

- **Status:** Proposed
- **Date:** 2026-05-01
- **Decision-maker(s):** Source (Nori), Engineering Circle
- **Driver:** harness#726 (action item from 2026-05-01 engineering meta-live review of PR #270), Security Agent (#25)

## Context

PR #270 ships the subscription-CLI provider family (ADR-0034). Each per-CLI adapter currently emits a hardcoded "auto-approve everything" flag in `buildFlags()`:

| CLI    | Flag                                         | Effect                                                            |
| ------ | -------------------------------------------- | ----------------------------------------------------------------- |
| claude | `--dangerously-skip-permissions`             | Skip all confirmation prompts; allow file write, shell exec, etc. |
| gemini | `--yolo`                                     | Auto-approve all tools                                            |
| codex  | `--dangerously-bypass-approvals-and-sandbox` | Skip all confirmation prompts; bypass workspace sandbox           |

The Security Agent objected during the meta-live review:

> Subscription-cli currently uses native CLI permission modes such as
> dangerous/yolo flags **implicitly**. A prompt-injected or compromised
> meeting input could cause the vendor CLI runtime to use its own tool
> surface outside the harness's GitHub scopes, audit model, budget
> attribution, or approval gates.

The decision recorded in the meta-live meeting:

> Conditional consent for controlled merge/dogfooding of PR #270.
> Subscription-cli must **not** be promoted as broad default while
> dangerous/yolo CLI permission modes are implicit.

This ADR proposes the mechanism that converts the implicit posture into an explicit, opt-in, auditable one — including how Source grants elevation when no interactive session is available (the harness runs cron-driven wakes; Source is rarely watching the terminal at wake time).

## Decision (proposed)

We add a **three-state permission mode** to subscription-CLI configuration, default-restricted, with a **tension-for-permission** mechanism that lets Source grant elevation asynchronously via GitHub Issues.

### Permission modes

| Mode                   | Effect on CLI argv                                                        | When to use                                                                          |
| ---------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `restricted` (default) | Adapter omits the dangerous/yolo flag. CLI runs with default permissions. | New operators, untrusted agents, agents that don't need shell/file write.            |
| `operator-approved`    | Adapter emits the flag only if the agent has a granted permission record. | Agents that legitimately need elevation (e.g. a build agent running migrations).     |
| `trusted`              | Adapter emits the flag unconditionally (current PR #270 behavior).        | Source's own dev sandbox, single-operator murmurations, throwaway test environments. |

Configurable in three places (cascade order):

1. **`harness.yaml`** — fleet default (e.g. `restricted` for production):
   ```yaml
   subscription_cli:
     permission_mode: "restricted"
   ```
2. **Per-agent `role.md`** — overrides fleet default:
   ```yaml
   llm:
     provider: subscription-cli
     cli: claude
     permission_mode: "operator-approved"
   ```
3. **Per-wake** (programmatic only; not operator-facing) — for the daemon to escalate during a single wake after consent lands.

### Tension-for-permission flow

When `permission_mode: operator-approved` and the agent's wake fails (or self-reports needing elevation), the post-wake hook auto-files a GitHub issue:

```
Title:  [PERMISSION-REQUEST] {agentId}: {flag} for {reason}
Labels: tension, source-required, scope:agent:{agentId}
Body:
  **Agent:** {agentId}
  **CLI:** {cli} ({version})
  **Requested flag:** {flag}
  **Reason (agent-reported):** {one-line reason}
  **Wake context:** wake {wakeId} on {finishedAt}
  **Sample stderr:** {first 500 chars}

  ---
  Source consent: close this issue with label `permission:granted`.
  Source denial: close with label `permission:denied`.
  Auto-expires after 30 days if neither is set.
```

Source consents asynchronously by closing-with-label. The daemon's pre-wake gate reads the granted-permission set per agent (cached in `state.permissions.json`) and re-emits the elevated flag at the next wake.

### Audit trail

Every wake's `costRecord.permissions` field records the effective set actually used:

```typescript
readonly permissions: {
  readonly mode: "restricted" | "operator-approved" | "trusted";
  readonly elevatedFlags: readonly string[]; // empty unless granted
  readonly grantSource: "fleet" | "agent-role" | "issue-{n}" | "none";
};
```

This lands in the wake digest YAML so reviewers can answer "did this wake use elevated permissions, and where did the grant come from?"

### Defaults that change with this ADR

- `harness.yaml` default for new murmurations: `restricted`
- Existing operators (those who ran `init` before this lands): grandfathered to `trusted` via a one-shot migration that emits the explicit value with a deprecation comment, so behavior doesn't change silently
- `murmuration init` interview adds: "Subscription-CLI permission mode (restricted / operator-approved / trusted) [restricted]:" with one-line guidance

## Open questions

1. **Issue spam**: a misconfigured agent could file dozens of permission requests per wake. Mitigation: dedupe by `(agentId, flag)` — only one open request per pair at a time.
2. **Grant scope**: does a granted permission apply forever, or for a time window? Proposal: **forever per (agent, flag)** until Source revokes by reopening the issue. Source can audit by listing `label:permission:granted` issues.
3. **Failure mode of the tension itself**: if Source ignores the issue, the agent stays blocked. Should there be a timeout? Proposal: **no auto-grant ever**; expired requests just close, agent re-requests on next wake.
4. **Granularity**: do we grant `--dangerously-skip-permissions` (boolean), or a vendor-specific subset (e.g. `--allowedTools shell,write`)? v0.1: boolean; future ADR may refine.
5. **Test environment**: how do operators run integration tests with elevated permissions without round-tripping GitHub? Proposal: `permission_mode: trusted` is the test-env answer; document this in the testing guide.

## Alternatives considered

### Option A — Tension-for-permission (CHOSEN if accepted)

Pros: Explicit audit trail, async-friendly, fits S3 governance, leverages existing GitHub-as-system-of-record.

Cons: Adds friction to first wake of every newly-elevated agent. Source must be reachable to grant.

### Option B — Interactive prompt at boot

Daemon asks once at start: "Grant elevated permissions to all agents in this fleet?" Y/N stored in `state.permissions.json`.

Pros: Simple. Familiar.

Cons: Doesn't compose with cron-driven non-interactive starts. Defeats the point of subscription-CLI's "set it and forget it" appeal. Doesn't model per-agent grants.

### Option C — Status quo + warning banner

Keep `trusted` as default; print a one-time banner at boot warning operators about elevated permissions.

Pros: Zero implementation cost.

Cons: Doesn't address the security objection. Banners get ignored. Defeats the engineering circle's conditional consent.

### Option D — Disable subscription-CLI entirely until proper sandboxing exists

Pros: Maximally safe.

Cons: Throws away PR #270 entirely. Engineering circle's verdict was "merge for dogfooding, not broad default" — Option D would even block dogfooding.

## Consequences

### Easier

- Source has a clear audit trail of which agents have elevation and why.
- New operators get safe defaults; the harness no longer ships with implicit dangerous flags.
- Per-agent grant scope keeps blast radius small.

### Harder

- First wake of an agent that needs elevation will fail and file an issue. Source must respond. Frustrating for solo operators in a hurry.
- Implementation requires: state store extension, post-wake hook for issue creation, pre-wake gate for grant lookup, cli-detect surfacing of available flags, init interview update.
- Governance: who can grant `permission:granted` besides Source? v0.1 says only Source; future ADR may extend to circle facilitators.

### Reversibility

Mode is a config field; changing it is a one-line edit. Existing wakes don't reference any permission field today, so the schema migration is additive (`permissions: undefined` for old records is valid).

## Implementation outline (non-binding, post-acceptance)

1. Schema: add `permission_mode` to `harness.yaml` and `role.md` `llm:` block (Zod schemas in `@murmurations-ai/core`).
2. Adapter: each CLI adapter takes a `permissionMode` argument in `buildFlags(req, opts)` and conditionally emits the dangerous flag.
3. State: extend `state.permissions.json` with `{ agentId: { flag: { grantedAt, issueNumber } } }`.
4. Hook: post-wake handler in `Daemon` checks for `LLMUnauthorizedError` with a "permission" hint and files the GitHub issue.
5. Audit: `WakeCostRecord.permissions` field; daemon log; digest YAML.
6. Init: interview adds the permission_mode question after the subscription-CLI choice.
7. Migration: one-shot at boot — if a murmuration has subscription-cli config but no `permission_mode`, write `trusted` with a deprecation comment.

## Related

- ADR-0034 — Subscription-CLI provider family
- harness#726 — Action item: Make subscription CLI execution policy explicit and opt-in
- harness#731 — Governance item: Define harness policy for local subscription CLI authority
- ADR-0017 — GitHub write-scope enforcement (mental model for "elevation needs a grant")
