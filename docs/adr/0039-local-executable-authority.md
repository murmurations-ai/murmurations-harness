# ADR-0039 — Local Executable Authority for Subscription-CLI Providers

- **Status:** Proposed
- **Date:** 2026-05-01
- **Decision-maker(s):** Source (Nori), Engineering Circle
- **Driver:** xeeban/emergent-praxis#731
- **Related:** ADR-0034, ADR-0036, ADR-0037, ADR-0038, ADR-0017

## Context

ADR-0034 makes locally installed vendor CLIs (`claude`, `gemini`, `codex`) part
of the LLM execution control plane. ADR-0038 extends that path by attaching a
local MCP server for Spirit tool calls. That changes the architecture: the
harness is no longer only calling HTTPS provider APIs through typed adapters; it
is executing operator-local binaries with the operator's filesystem, process
environment, cwd, subscription auth, and vendor-native tool surfaces.

The risk is not "subprocesses are bad." The risk is uncontrolled authority:
PATH resolution, inherited env vars, native tool auto-approval flags, cwd
semantics, tool calls invisible to the harness, and GitHub mutations that could
bypass ADR-0017 if the vendor CLI's own tools are allowed to write directly.

This ADR defines the governing policy. ADR-0036 and ADR-0037 are implementation
slices under this policy.

## Decision

Subscription-CLI execution is a **local executable authority boundary**. The
harness may use it, but only under these rules.

### 1. Executable identity

- Every vendor CLI invocation MUST record the effective executable identity:
  CLI name, resolved absolute path, version string, and sha256 when available.
- PATH resolution is allowed only in record mode. Operators who want stronger
  integrity pin absolute paths in `harness.yaml` per ADR-0037.
- A pinned path wins over PATH. If the pinned path is absent or not executable,
  the wake fails closed with a typed configuration error.
- Hash pins are opt-in. A hash mismatch fails closed unless the operator passes
  an explicit one-shot override.

### 2. Execution policy

- Native vendor CLI auto-approval flags are **not default authority**.
- The default permission mode is `restricted`.
- `trusted` is explicit dogfooding authority and emits vendor auto-approval
  flags:
  - Claude: `--dangerously-skip-permissions`
  - Gemini: `--yolo`
  - Codex: `--dangerously-bypass-approvals-and-sandbox`
- `operator-approved` is reserved for the GitHub issue grant flow in ADR-0036.
  Until that grant store exists, it behaves as `restricted`.
- No subscription-cli wake may silently upgrade from `restricted` to `trusted`.

### 3. Prompt, cwd, and argv

- Prompt content MUST go through stdin only. `buildFlags()` never receives or
  serializes prompt text.
- CLI subprocesses MUST use argv array execution (`shell: false`), never shell
  interpolation.
- The working directory is an authority decision. The default cwd SHOULD be the
  murmuration root only when the agent is intended to inspect local files; pure
  LLM turns SHOULD run from a neutral cwd. Until cwd policy is configurable, the
  effective cwd MUST be recorded in wake artifacts.

### 4. Environment inheritance

- The subprocess environment is part of the trust boundary.
- The long-term policy is an explicit allowlist: `PATH`, terminal-neutral
  locale fields, vendor-required CLI config variables, and harness-specific
  variables required by the transport.
- ADR-0038's Spirit MCP server may receive `MURMURATION_ROOT`; it should not
  receive unrelated provider API keys.
- Until allowlist execution lands, env inheritance is accepted for dogfooding
  only and must not be promoted as a broad default.

### 5. Native tool surfaces and harness scopes

- Vendor-native tools do not inherit harness GitHub write scopes.
- GitHub mutations that represent harness work still flow through WakeAction
  and ADR-0017 write-scope enforcement.
- If a vendor CLI has its own file, shell, web, or MCP tools enabled, those
  tools are outside the harness approval gates unless the harness explicitly
  mediates them.
- Spirit's MCP bridge is allowed because it re-hosts `buildSpiritTools()` and
  routes through the daemon. It is a transport adapter, not a second tool
  implementation.
- Any future agent-side MCP bridge must reuse this policy and must not expose
  a broader tool surface than the agent's declared role permits.

### 6. Auditability and budget attribution

- Subscription-cli cost is `$0` marginal but not "free work." Wake artifacts
  MUST preserve provider id (`claude-cli`, `gemini-cli`, `codex-cli`), model,
  token counts, cache tokens when available, timeout, and shadow cost.
- Wake artifacts SHOULD include the effective permission mode, elevated flags,
  executable identity, cwd, and MCP config path/hash when present.
- Missing token counts are a parse error, never silent zero.
- Local CLI failures must surface as typed LLM errors; no silent fallback to API
  providers or between vendor CLIs.

### 7. Approval gates

- Enabling `provider: subscription-cli` is operator configuration.
- Enabling `permissionMode: trusted` is explicit local executable trust.
- Enabling broad native vendor tools or user-global MCP config mutation is a
  separate approval gate and requires Source consent before broad default.
- The harness may dogfood a trusted local mode on Source's machine; adopter
  defaults remain restricted.

## Consequences

**Easier:**

- The execution boundary is named. Security, DevOps, and Performance can review
  concrete surfaces instead of debating "the CLI path" as one blob.
- ADR-0036, ADR-0037, and ADR-0038 now compose under one policy.
- The adapter-level default can be restricted without blocking explicit local
  dogfooding.

**Harder:**

- Full compliance requires follow-up implementation: env allowlist, cwd
  recording, executable identity in wake artifacts, and permission metadata in
  cost records.
- Some vendor CLI workflows will feel slower or more constrained until
  operators opt into trusted mode.

## Alternatives considered

### A. Treat subscription CLIs like API providers

Rejected. API providers receive prompt payloads over HTTPS through typed client
code. Subscription CLIs execute local binaries with local auth and native tools.
The authority surface is different.

### B. Ban native CLI tools entirely

Rejected for v0.1. The cost economics of subscription auth matter, and Spirit's
tool-equipped path is useful. The right boundary is explicit authority, not a
blanket ban.

### C. Require full sandboxing before merge

Rejected for dogfooding. Full sandboxing is valuable but larger than the current
PR family. Restricted default + explicit trusted mode is enough to continue
controlled local validation.

## Follow-up implementation checklist

- Implement ADR-0037 Layer 1 executable identity recording.
- Persist `permissionMode`, elevated flags, cwd, and executable identity in wake
  artifacts.
- Add env allowlist execution to `SubprocessAdapter`.
- Add `murmuration doctor` checks for subscription-cli executable policy.
- Decide whether Gemini Phase B may mutate user-global settings or must use a
  harness-owned config file only.
