# ADR-0010 — SecretsProvider interface and dotenv default provider

- **Status:** Accepted
- **Date:** 2026-04-09 (landed in commit `1B-c`)
- **Decision-maker(s):** Security Agent #25 (authored the design doc), Engineering Circle
- **Consulted:** TypeScript / Runtime Agent #24 (interface shape review), DevOps / Release Agent #26 (implementation)
- **Closes:** Phase 1B step B1 from `docs/PHASE-1-PLAN.md`

## Context

The harness needs to load secrets (GitHub PAT, LLM API keys, channel
webhook tokens) at daemon boot and make them available to agents and
plugins without leaking them through structured logging. The Security
Agent #25 role doc and the Engineering Circle doc §5 (Notify tier, 24h
Security pre-merge window on new top-level dependencies) constrained
the design.

Three plausible approaches:

1. **`process.env` only.** Simple, but every subprocess inherits
   `process.env` by default, defeating least-privilege. No redaction in
   logs. No declaration / validation of which secrets are required.
2. **Bespoke secrets manager.** Full-featured (rotation, scoping,
   audit log) but large surface for v0.1.
3. **Pluggable `SecretsProvider` interface with a default dotenv
   implementation.** One interface, one default backend; alternate
   providers (keychain, 1Password, Vault) slot in later without
   breaking changes.

## Decision

**Adopt approach 3.** The interface lives in `@murmuration/core/secrets`
and the default provider lives in `@murmuration/secrets-dotenv` as a
separate workspace package.

### Key sub-decisions

1. **Eager, read-once loading.** `SecretsProvider.load()` is called
   exactly once at daemon boot via `Daemon.loadSecrets()`. A missing
   required secret halts boot immediately — fail fast, not at first
   use. Rotation requires a daemon restart.

2. **`SecretValue` uses a method accessor, not a property.** This is
   a deliberate deviation from ADR-0006 (branded primitives usually
   expose a `.value` field). Rationale: property access is enumerable
   and would leak the raw secret through `JSON.stringify` and
   structured logging. A `reveal()` closure is non-enumerable,
   grep-able in code review, and `toJSON` / `toString` both return the
   sentinel `"[REDACTED:length=N]"`.

3. **Three layers of redaction.**
   - **Type-level:** `SecretValue` has no enumerable raw-bytes field.
   - **Runtime serialization:** `toJSON` returns the redaction sentinel.
   - **Logger scrubber:** `scrubLogRecord` in the default daemon logger
     walks the record and replaces any string-valued field whose key
     name matches `/token|secret|password|credential|auth|apikey|…/i`
     and whose value is ≥ 8 characters with
     `"[REDACTED:scrubbed-by-name]"`. Plugins can opt into symbol-bucket
     redaction via the `REDACT` symbol (`Symbol.for(...)`).

4. **Least-privilege on undeclared keys.** Keys present in `.env` but
   not declared by the caller are not loaded into memory — we don't
   hold what we weren't asked for.

5. **POSIX permission enforcement.** `.env` must be at mode `0600` or
   stricter. Looser modes return `EnvFilePermissionsError` and halt
   boot. Windows skips the check (documented follow-up).

6. **No interpolation.** The dotenv parser is invoked without
   `dotenv.expand`. Variable interpolation (`${OTHER}`) makes the trust
   graph harder to audit; adopters who need it can do it out of band.

### Dependency added

`dotenv@^16.4.5` — cleared by Security #25 under the Engineering
Circle §5 Notify 24h pre-merge protocol. Zero runtime deps, no
post-install scripts, ~35M weekly downloads, MIT licensed.

## Consequences

### Positive

- Fail-fast boot prevents "works for hours, then explodes at the
  first real wake" failure modes.
- Log-leak defense is layered — even an incorrectly written plugin
  that does `logger.info("oops", { apiKey: raw })` hits the scrubber.
- Interface is forward-compatible with keychain, 1Password, Vault
  providers as additive packages.
- `SecretValue`'s toJSON behaviour means accidental structural logging
  of a whole object containing a secret fails safe.

### Negative

- Rotation requires daemon restart. Acceptable for v0.1; remote
  providers will lift this.
- The `SecretValue` deviation from ADR-0006 is a wart in the branded
  primitive story. The deviation is documented here and in the
  interface TSDoc.
- Mid-wake secret audit logging is out of scope for v0.1 (who called
  `get()` when). Tracked as a follow-up.

### Follow-ups

1. **CF-new-A — Subprocess env var leakage.** The `SubprocessExecutor`
   currently inherits `process.env` into child processes; it must
   explicitly scrub secret keys before Phase 2. Owner: Security #25 +
   Architecture #23.
2. **CF-new-B — Capability-scoped secrets access.** Once the plugin
   trust boundary (harness repo #4) lands in Phase 3, `get()` needs a
   capability parameter to enforce `secrets:read:GITHUB_TOKEN` per
   plugin. Breaking change, tracked as Consent-tier.
3. **CF-new-C — `.gitignore` preflight.** Before Phase 7 ship, the
   `murmuration init` command should refuse to write a `.env` unless
   `.gitignore` lists it. Policy owner: Security #25, implementation:
   DevOps #26.

## Alternatives considered

- **`@dotenvx/dotenvx`** — larger surface (CLI, crypto, ~20 transitive
  deps) for features we don't need in v0.1. Reconsider post-v0.1 if
  encrypted-at-rest becomes a requirement.
- **Node 20 `--env-file`** — only loads into `process.env`, which is
  exactly what we're trying to avoid inheriting into subprocesses.
  Rejected.
- **Roll our own parser** — `.env` parsing rules (quotes, escapes,
  multi-line) are subtle enough that the maintenance burden isn't
  worth it for a commodity format.
