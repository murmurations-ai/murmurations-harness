# ADR-0037 — Subscription-CLI Binary Integrity

- **Status:** Proposed
- **Date:** 2026-05-01
- **Decision-maker(s):** Source (Nori), Engineering Circle
- **Driver:** harness#731 (governance item from 2026-05-01 engineering meta-live review of PR #270), Security Agent (#25)

## Context

PR #270's `cli-detect.ts` resolves CLI binaries via `spawnSync("claude", ["--version"])` — i.e., trusts whatever `PATH` resolution returns. The Security Agent flagged this during the meta-live review:

> There is also a supply-chain/PATH risk: auto-detection and execution
> trust whatever `claude`, `codex`, or `gemini` resolves to in the
> operator environment.

Concrete attack surface:

1. **PATH shimming**: a malicious process prepends `/tmp/evil` to PATH; `spawnSync("claude")` runs `/tmp/evil/claude`. The harness now executes attacker-controlled code with the agent's environment (including loaded secrets).
2. **Binary substitution**: legitimate path, but the binary itself was replaced (post-install or supply-chain compromise upstream).
3. **Silent upgrades**: a CLI auto-updates between boot and wake; behavior changes invisibly. (Not an attack, but observability matters.)

The engineering circle's governance ask:

> Define and implement an explicit execution policy with a safer default,
> operator opt-in for native CLI tools or dangerous permission modes,
> and persisted effective policy in wake artifacts.

This ADR proposes a **layered defense** that's cheap at the bottom (record + display) and progressively stricter for operators who want it (pin paths, hash-pin binaries).

## Decision (proposed)

We add three layers of binary integrity, each independently opt-in:

### Layer 1 — Record (always on, from this ADR's acceptance)

At every daemon boot, log resolved binary metadata for each detected CLI:

```json
{
  "ts": "2026-05-01T20:39:17Z",
  "level": "info",
  "event": "daemon.boot.cli.resolved",
  "cli": "claude",
  "resolvedPath": "/opt/homebrew/bin/claude",
  "version": "2.1.126 (Claude Code)",
  "binarySha256": "a3f1...",
  "size": 89234567
}
```

Each wake's cost record gains a new optional field:

```typescript
readonly cliBinary?: {
  readonly resolvedPath: string;
  readonly version: string;
  readonly sha256: string;
};
```

Persisted in `index.jsonl` and surfaced in digest YAML. Cost: one `realpath` + one `crypto.createHash('sha256')` per CLI per boot. Negligible.

### Layer 2 — Pin (operator opt-in)

`harness.yaml` accepts an optional pin block:

```yaml
subscription_cli:
  paths:
    claude: "/opt/homebrew/bin/claude"
    codex: "/opt/homebrew/bin/codex"
```

When pinned, `cli-detect` skips PATH resolution for that CLI and verifies the pinned absolute path exists + is executable. PATH manipulation can no longer redirect.

`murmuration init` adds a final-page yes/no: "Pin detected CLI paths to absolute locations? [Y/n]" Default Y when any subscription CLI is selected. The init writes the resolved absolute paths into harness.yaml automatically.

### Layer 3 — Hash-pin (operator opt-in, paranoid mode)

`harness.yaml` extends the pin block:

```yaml
subscription_cli:
  paths:
    claude: "/opt/homebrew/bin/claude"
  binary_hashes:
    claude: "sha256:a3f1..."
```

At each boot, the daemon recomputes sha256 and compares. On mismatch:

- **Default:** boot fails with `daemon.boot.cli.hash-mismatch` and a clear message ("`claude` binary changed since hash was pinned. Recompute and update harness.yaml, or remove the pin.")
- **Override:** `murmuration start --allow-hash-drift` proceeds with a warning (for the case where the operator just upgraded their CLI legitimately).

Hash mismatch is information dense: it tells the operator "something changed" without trying to distinguish malicious vs benign. Operator decides.

### Surfacing

`murmuration doctor` gains a "CLI binaries" section:

```
CLI binaries
  ✓ claude   /opt/homebrew/bin/claude     v2.1.126   sha256:a3f1...  (pinned, hash matches)
  ⚠ codex    /opt/homebrew/bin/codex      v0.128.0   sha256:b8c2...  (pinned, hash mismatch — see harness.yaml)
  ℹ gemini   /opt/homebrew/bin/gemini     v0.21.0    sha256:f7e3...  (not pinned)
```

The TUI dashboard's existing "Subscription usage" panel grows a one-line "Binary integrity: ✓ all pinned" / "⚠ 1 not pinned" indicator.

## Open questions

1. **Hash recomputation cost**: a 90 MB binary takes ~50ms to sha256. Three CLIs × every boot = 150ms boot overhead. Acceptable. Could be cached against `(path, mtime, size)` to avoid recompute on identical-binary reboots.
2. **CLI auto-update friction**: Claude Code, Gemini CLI, and Codex all self-update. Hash-pinning forces operators to update the pin on every CLI update. Layer 3 is opt-in for this reason; Layer 1+2 don't have this friction.
3. **Sigstore / cosign integration**: future ADR could verify against vendor-signed releases instead of operator-pinned hashes. Out of scope for v0.1 — none of the three CLIs ships sigstore manifests today (verified 2026-05-01).
4. **Cross-platform**: macOS / Linux paths differ; Windows operators (none today) would need different defaults. The pin block accepts any absolute path; auto-pin in init reads `which <cli>` so it's platform-agnostic by construction.
5. **What about MCP servers?** They have the same supply-chain surface. This ADR scopes to subscription-CLI only; an MCP-server-integrity ADR is a sibling concern, not a blocker.

## Alternatives considered

### Option A — Layered (CHOSEN if accepted)

Layer 1 always; Layer 2 + 3 opt-in.

Pros: Cheap default. Operators who don't care about supply chain pay nothing. Operators who do care have a clear escalation ladder.

Cons: Three layers to document. Init flow grows another question.

### Option B — Pin only, no hash

Skip Layer 3 entirely.

Pros: Simpler. No CLI-update friction.

Cons: PATH defense without binary defense — a determined attacker who can replace the pinned binary still wins. Layer 3 is the only defense against that case, and it's cheap to implement.

### Option C — Always hash, no pin

Hash-verify on every boot regardless of operator config; record-only on first boot.

Pros: Maximum default security.

Cons: Fights against legitimate CLI auto-updates. Every CLI bump becomes a boot failure. Operator burden too high; would push people to disable.

### Option D — Skip integrity entirely; rely on OS-level codesigning

macOS verifies binary signatures at exec time; Linux package managers verify on install.

Pros: Zero implementation cost.

Cons: Doesn't address PATH shimming (the OS happily executes /tmp/evil/claude if it's signed by anyone). Doesn't help operators detect post-install tampering. Insufficient by itself.

## Consequences

### Easier

- Every wake has an audit trail of which binary actually ran.
- Operators who pin paths get PATH-shimming protection for free.
- Operators who hash-pin get tamper detection.

### Harder

- Layer 3 friction on legitimate CLI updates. Mitigated by `--allow-hash-drift` and clear error message.
- One more thing to document; one more init question. Both are skippable defaults.

### Reversibility

Pin and hash blocks in harness.yaml are pure config; remove to revert. `cliBinary` field on cost record is additive (undefined for old records is valid). No persistent state migration.

## Implementation outline (non-binding, post-acceptance)

1. Layer 1: extend `cli-detect.ts` to compute sha256 + record absolute path. Daemon boot logs `daemon.boot.cli.resolved`. `WakeCostRecord` schema gains optional `cliBinary`.
2. Layer 2: harness.yaml schema extension; `cli-detect` honors pinned paths first. `murmuration init` auto-pin question.
3. Layer 3: `binary_hashes` in harness.yaml; boot-time verification; `--allow-hash-drift` flag.
4. Surfacing: `murmuration doctor` section; TUI dashboard one-liner.
5. Tests: cli-detect unit tests gain pinned-path + hash-mismatch cases.

## Related

- ADR-0034 — Subscription-CLI provider family
- ADR-0036 — Subscription-CLI permission mode (sibling defense layer)
- harness#731 — Governance item: Define harness policy for local subscription CLI authority
- harness#727 — Action item: Record CLI wake execution artifacts (subset of Layer 1)
