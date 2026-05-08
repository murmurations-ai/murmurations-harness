/**
 * Tool registry types — Proposal 07 Phase 0 (types only, no wiring).
 *
 * Defines the vocabulary for describing tools across all delivery
 * mechanisms (MCP, extension, CLI, collaboration, internal). The
 * ToolRegistry itself is a Phase 3 deliverable; these types establish
 * the contracts it will enforce.
 */

// ---------------------------------------------------------------------------
// Permissions and policies
// ---------------------------------------------------------------------------

/** Coarse capability class a tool requires. Used in grant checks and
 *  `ExecutionContract.allowedSideEffects`. */
export type ToolPermission = "read" | "write" | "execute" | "network" | "admin";

/** Pre-action approval requirement for a tool or tool class. */
export interface ApprovalPolicy {
  /** `none` — no approval needed (default for read-only tools).
   *  `required` — wake pauses and creates a Source approval issue before
   *               executing (INTERRUPT/RESUME, Phase 7).
   *  `conditional` — approval only when specified permissions are invoked. */
  readonly mode: "none" | "required" | "conditional";
  /** Human-readable reason shown in the approval issue. */
  readonly reason?: string;
  /** Which permissions trigger approval when mode is `conditional`. */
  readonly requiredFor?: readonly ToolPermission[];
}

// ---------------------------------------------------------------------------
// Tool descriptor
// ---------------------------------------------------------------------------

/** Full descriptor for one tool, normalized across all providers. */
export interface ToolDescriptor {
  /** Stable, unique tool id (e.g. `"mcp__playwright__browser_navigate"`). */
  readonly id: string;
  /** Display name used in prompts and receipts. */
  readonly name: string;
  /** Which delivery mechanism provides this tool. */
  readonly provider: "mcp" | "extension" | "cli" | "collaboration" | "internal";
  readonly description: string;
  /** JSON Schema for the tool's input parameters (opaque at this layer). */
  readonly inputSchema: unknown;
  /** Permissions this tool requires at runtime. */
  readonly permissions: readonly ToolPermission[];
  /** Whether calling this tool mutates external state. */
  readonly mutability: "read-only" | "mutating";
  /** Trust level of the tool's implementation. MCP tools from unvetted
   *  servers are `untrusted`; harness built-ins are `trusted`. */
  readonly trust: "trusted" | "semi-trusted" | "untrusted";
  /** Wall-clock timeout for one tool invocation in milliseconds. */
  readonly timeoutMs: number;
  /** Whether a successful call requires a post-call verification step. */
  readonly requiresVerification: boolean;
  /** Approval policy for this specific tool (overrides role-level policy). */
  readonly approval: ApprovalPolicy;
}

// ---------------------------------------------------------------------------
// Tool grant
// ---------------------------------------------------------------------------

/** Per-agent access grant for a specific tool. Deny-by-default:
 *  a tool not covered by any grant is unavailable to the agent. */
export interface ToolGrant {
  /** References `ToolDescriptor.id`. */
  readonly toolId: string;
  /** Agent ids allowed to use this tool. Empty = no agents. */
  readonly allowedAgentIds: readonly string[];
  /** Names of secrets the tool may receive via `EnvironmentSpec.secretGrants`. */
  readonly allowedSecretGrantNames: readonly string[];
  /** Optional cap on how many times this tool may be called in a single wake. */
  readonly maxCallsPerWake?: number;
}
