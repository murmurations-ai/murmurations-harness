/**
 * Environment boundary — Proposal 07 Phase 0 (types only, no wiring).
 *
 * `EnvironmentSpec` makes the agent's runtime environment a first-class
 * declared object instead of ambient `process.env` inheritance. Phase 7
 * enforces these limits via `ContainerExecutor`; earlier phases declare
 * the spec so operators can write it and tooling can validate it.
 */

/** First-class declaration of what environment an agent wake may access. */
export interface EnvironmentSpec {
  /** Working directory for shell commands and file operations. */
  readonly cwd?: string;
  /** Explicit filesystem scope. Phase 7 enforces these limits. */
  readonly workspace?: {
    readonly root: string;
    readonly writablePaths: readonly string[];
    readonly readOnlyPaths: readonly string[];
  };
  /** Non-secret key/value pairs injected into the subprocess environment.
   *  Secret values MUST NOT appear here — use `secretGrants` instead. */
  readonly publicEnv: Readonly<Record<string, string>>;
  /** Scoped secret delivery: each grant names the secret, the env var
   *  it maps to, and which tool ids may receive it. Tools not in
   *  `allowedToolIds` never see the value. */
  readonly secretGrants: readonly {
    readonly name: string;
    readonly targetEnv: string;
    readonly allowedToolIds: readonly string[];
  }[];
  /** Network access declaration.
   *  `none` — no outbound network allowed (Phase 7 enforced).
   *  `declared` — only URLs listed in role.md tools.network.
   *  `ambient` — unrestricted (legacy default; emit a warning). */
  readonly network: "none" | "declared" | "ambient";
  /** Optional hard resource limits. Phase 7 enforces via container controls;
   *  earlier phases record them as declared policy. */
  readonly resourceLimits?: {
    readonly wallClockMs: number;
    readonly cpuMs?: number;
    readonly memoryMb?: number;
    readonly maxOutputBytes?: number;
  };
}
