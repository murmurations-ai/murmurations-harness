/**
 * Done-criteria — machine-checkable completion conditions for an
 * agent's accountabilities. Per ADR-0042 / docs/specs/0001-agent-effectiveness.md.
 *
 * `role.md` frontmatter declares an `accountabilities` block; each
 * accountability lists `done_when` conditions. The harness validates
 * those conditions against current state at wake-end (replacing the
 * agent's self-reported `EFFECTIVENESS:` field as the authoritative
 * completion signal) and at wake-start (so completed items fall out
 * of the next bundle automatically).
 *
 * This module exports:
 *
 *   1. The Zod schema for `accountabilities` (consumed by the identity
 *      loader) — kept in core so role.md schemas across operator repos
 *      can validate against a single source of truth.
 *   2. Variable interpolation (`${self.X}`, `${this.X}`, `{period}`).
 *   3. The `StateProbe` interface — the read-only surface validators
 *      use to query git/GitHub/filesystem state. Production wires this
 *      to real adapters; tests inject fakes.
 *   4. Per-kind validators that consume a resolved condition + a
 *      probe and return `{ met, reason }`.
 *
 * Wake-end integration (the `wake.done_check.discrepancy` event,
 * priority bundle filter) lives in subsequent workstreams (E + the
 * runner). This module is the foundational schema + validators.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Condition union — Zod schema and TS type
// ---------------------------------------------------------------------------

/**
 * `file-committed` — a git ref exists with the named path AND the
 * commit timestamp is at or after `wakeStartedAt`. Path may include
 * `{period}` interpolation.
 */
const fileCommittedSchema = z.object({
  kind: z.literal("file-committed"),
  path: z.string().min(1),
});

/**
 * `issue-closed` — a GitHub issue is in `state: CLOSED`. The optional
 * filter narrows by author/type/label; if `number` is set it pins to
 * a specific issue.
 */
const issueClosedSchema = z.object({
  kind: z.literal("issue-closed"),
  number: z.number().int().positive().optional(),
  filter: z
    .object({
      author: z.string().optional(),
      type: z.string().optional(),
      label: z.string().optional(),
      state: z.string().optional(),
    })
    .optional(),
});

/**
 * `issue-closed-or-blocker-filed` — the triggering issue is closed,
 * OR a successor `[TENSION]` issue exists naming the blocker.
 * Captures the "either I finished it or I named what's stopping me"
 * pattern that lets agents stay honest about partial completion.
 */
const issueClosedOrBlockerFiledSchema = z.object({
  kind: z.literal("issue-closed-or-blocker-filed"),
  triggering_issue: z.string().min(1),
});

/**
 * `comment-posted` — a comment exists on the named issue, optionally
 * containing a link/regex. Used for "I posted my position on #N" type
 * accountabilities.
 */
const commentPostedSchema = z.object({
  kind: z.literal("comment-posted"),
  on_issue: z.string().min(1),
  contains_link_to: z.string().optional(),
  contains_regex: z.string().optional(),
});

/**
 * `label-applied` — the named label is currently on the issue.
 * Lightweight check for state machine progress that doesn't require
 * issue closure.
 */
const labelAppliedSchema = z.object({
  kind: z.literal("label-applied"),
  on_issue: z.string().min(1),
  label: z.string().min(1),
});

/**
 * `agreement-registered` — `governance/agreements/<slug>.md` exists
 * with non-empty content. Per ADR-0041 §Part 1, every consented
 * agreement must land in the addressable registry — this condition
 * encodes "I wrote the durable record."
 */
const agreementRegisteredSchema = z.object({
  kind: z.literal("agreement-registered"),
  slug: z.string().min(1),
});

/** Discriminated union of all done conditions. */
export const doneConditionSchema = z.discriminatedUnion("kind", [
  fileCommittedSchema,
  issueClosedSchema,
  issueClosedOrBlockerFiledSchema,
  commentPostedSchema,
  labelAppliedSchema,
  agreementRegisteredSchema,
]);

export type DoneCondition = z.infer<typeof doneConditionSchema>;

// ---------------------------------------------------------------------------
// Accountability — Zod schema and TS type
// ---------------------------------------------------------------------------

const cadenceSchema = z.union([
  z.literal("continuous"),
  z.literal("daily"),
  z.literal("weekly"),
  z.literal("biweekly"),
  z.literal("monthly"),
  z.literal("quarterly"),
  z.literal("adhoc"),
  // Allow free-form so plugins can extend; validators only special-case
  // the cadences they use for {period} interpolation.
  z.string().min(1),
]);

export const accountabilitySchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9-]*$/, {
      message:
        "accountability id must be lowercase alphanumeric with hyphens (used as telemetry slug)",
    }),
  cadence: cadenceSchema,
  description: z.string().min(1),
  done_when: z.array(doneConditionSchema).min(1),
});

export type Accountability = z.infer<typeof accountabilitySchema>;

/** Schema fragment for `role.md` frontmatter — the identity loader splices this in. */
export const accountabilitiesSchema = z.array(accountabilitySchema).optional();

// ---------------------------------------------------------------------------
// Variable interpolation
// ---------------------------------------------------------------------------

/**
 * Context provided to validators when checking conditions. The
 * `${self.X}` and `${this.X}` interpolation resolves against this.
 */
export interface DoneConditionContext {
  /** The agent running the check. `${self.agent_id}` resolves here. */
  readonly self: { readonly agentId: string };
  /**
   * Per-accountability fields propagated from the runtime (e.g. the
   * issue an agent is currently addressing). `${this.X}` resolves here.
   * Free-form to let runtimes pass any metadata; missing keys
   * interpolate to the empty string.
   */
  readonly this: Readonly<Record<string, string>>;
  /**
   * Cadence-derived period token. Substituted for `{period}` literally.
   * For weekly cadence this is typically `2026-W18`; for monthly,
   * `2026-05`. Operators decide the exact format via `derivePeriod()`
   * at the daemon boundary; this module just substitutes.
   */
  readonly period: string;
  /**
   * Wake start time. `file-committed` requires the matching commit's
   * timestamp to be ≥ this so the validator only credits work done
   * during *this* wake (not stale prior work).
   */
  readonly wakeStartedAt: Date;
}

/**
 * Interpolate `${self.X}`, `${this.X}`, and `{period}` placeholders in
 * a string against a {@link DoneConditionContext}. Unknown variables
 * resolve to the empty string — fail-loose so role.md typos don't
 * crash the daemon. Validators are then responsible for treating an
 * empty interpolated value as "condition unmet" if appropriate.
 */
export const interpolate = (template: string, ctx: DoneConditionContext): string => {
  return template
    .replaceAll("{period}", ctx.period)
    .replaceAll(/\$\{self\.([a-z_][a-z0-9_-]*)\}/gi, (_, key: string) => {
      if (key === "agent_id" || key === "agentId") return ctx.self.agentId;
      return "";
    })
    .replaceAll(/\$\{this\.([a-z_][a-z0-9_-]*)\}/gi, (_, key: string) => {
      return ctx.this[key] ?? "";
    });
};

// ---------------------------------------------------------------------------
// State probe — the read-only surface validators query
// ---------------------------------------------------------------------------

/**
 * Read-only abstraction over git, GitHub, and filesystem state.
 * Validators receive a probe instead of doing I/O directly so:
 *
 *   1. Tests inject fakes without spinning up real git/GitHub/fs.
 *   2. The daemon can cache probe responses across validator calls
 *      within one wake (avoid redundant API calls).
 *   3. Future state sources (e.g. external KV stores) can plug in.
 */
export interface StateProbe {
  /** Returns true when a commit reaching `path` exists with timestamp ≥ `since`. */
  fileCommitted(path: string, since: Date): Promise<boolean>;
  /** Returns true when an issue matching the filter is in `state: CLOSED`. */
  issueClosed(filter: IssueClosedFilter): Promise<boolean>;
  /** Returns true when at least one issue matches the filter (used by `issue-closed-or-blocker-filed` for the successor-tension path). */
  issueExists(filter: IssueExistsFilter): Promise<boolean>;
  /** Returns true when a comment matching the filter exists. */
  commentExists(filter: CommentFilter): Promise<boolean>;
  /** Returns true when the named label is currently applied to the issue. */
  labelApplied(issueRef: IssueRef, label: string): Promise<boolean>;
  /** Returns true when `governance/agreements/<slug>.md` exists with non-empty content. */
  agreementExists(slug: string): Promise<boolean>;
}

export interface IssueRef {
  readonly number: number;
}

export interface IssueClosedFilter {
  readonly number?: number;
  readonly author?: string;
  readonly type?: string;
  readonly label?: string;
  readonly state?: string;
}

export interface IssueExistsFilter {
  readonly type?: string;
  readonly label?: string;
  readonly references?: string;
  readonly state?: "OPEN" | "CLOSED" | "all";
}

export interface CommentFilter {
  readonly issueRef: IssueRef;
  readonly authorAgentId?: string;
  readonly containsLinkTo?: string;
  readonly containsRegex?: RegExp;
}

// ---------------------------------------------------------------------------
// Validator dispatch
// ---------------------------------------------------------------------------

/** Result of validating one condition. */
export interface DoneConditionResult {
  readonly met: boolean;
  /** Human-readable explanation — used in wake-end discrepancy reports. */
  readonly reason: string;
}

/**
 * Validate a single done condition. Dispatches on `kind` to the
 * appropriate per-kind validator.
 */
export const validateCondition = async (
  condition: DoneCondition,
  ctx: DoneConditionContext,
  probe: StateProbe,
): Promise<DoneConditionResult> => {
  switch (condition.kind) {
    case "file-committed": {
      const path = interpolate(condition.path, ctx);
      const ok = await probe.fileCommitted(path, ctx.wakeStartedAt);
      return ok
        ? { met: true, reason: `file-committed: ${path}` }
        : {
            met: false,
            reason: `file-committed condition unmet — no commit reaching "${path}" since wake start`,
          };
    }
    case "issue-closed": {
      const filter: IssueClosedFilter = {
        ...(condition.number !== undefined ? { number: condition.number } : {}),
        ...(condition.filter?.author !== undefined
          ? { author: interpolate(condition.filter.author, ctx) }
          : {}),
        ...(condition.filter?.type !== undefined ? { type: condition.filter.type } : {}),
        ...(condition.filter?.label !== undefined
          ? { label: interpolate(condition.filter.label, ctx) }
          : {}),
        ...(condition.filter?.state !== undefined ? { state: condition.filter.state } : {}),
      };
      const ok = await probe.issueClosed(filter);
      return ok
        ? { met: true, reason: `issue-closed: ${describeIssueFilter(filter)}` }
        : {
            met: false,
            reason: `issue-closed condition unmet — no closed issue matches ${describeIssueFilter(filter)}`,
          };
    }
    case "issue-closed-or-blocker-filed": {
      const triggering = interpolate(condition.triggering_issue, ctx);
      const num = parseIssueNumber(triggering);
      if (num !== null) {
        const closed = await probe.issueClosed({ number: num });
        if (closed) {
          return { met: true, reason: `issue-closed: #${String(num)}` };
        }
      }
      // Fallback path: a successor `[TENSION]` exists referencing the triggering issue.
      const blockerFiled = await probe.issueExists({
        type: "[TENSION]",
        references: triggering,
        state: "OPEN",
      });
      return blockerFiled
        ? { met: true, reason: `blocker filed: TENSION referencing ${triggering}` }
        : {
            met: false,
            reason: `unmet — ${triggering} not closed and no [TENSION] references it`,
          };
    }
    case "comment-posted": {
      const onIssue = interpolate(condition.on_issue, ctx);
      const num = parseIssueNumber(onIssue);
      if (num === null) {
        return {
          met: false,
          reason: `comment-posted condition unmet — could not resolve issue ref "${onIssue}"`,
        };
      }
      const filter: CommentFilter = {
        issueRef: { number: num },
        authorAgentId: ctx.self.agentId,
        ...(condition.contains_link_to !== undefined
          ? { containsLinkTo: interpolate(condition.contains_link_to, ctx) }
          : {}),
        ...(condition.contains_regex !== undefined
          ? { containsRegex: new RegExp(condition.contains_regex) }
          : {}),
      };
      const ok = await probe.commentExists(filter);
      return ok
        ? { met: true, reason: `comment-posted on #${String(num)} by ${ctx.self.agentId}` }
        : {
            met: false,
            reason: `comment-posted condition unmet — no comment by ${ctx.self.agentId} on #${String(num)}${condition.contains_link_to !== undefined ? ` linking to ${condition.contains_link_to}` : ""}`,
          };
    }
    case "label-applied": {
      const onIssue = interpolate(condition.on_issue, ctx);
      const num = parseIssueNumber(onIssue);
      if (num === null) {
        return {
          met: false,
          reason: `label-applied condition unmet — could not resolve issue ref "${onIssue}"`,
        };
      }
      const label = interpolate(condition.label, ctx);
      const ok = await probe.labelApplied({ number: num }, label);
      return ok
        ? { met: true, reason: `label-applied: "${label}" on #${String(num)}` }
        : {
            met: false,
            reason: `label-applied condition unmet — "${label}" not on #${String(num)}`,
          };
    }
    case "agreement-registered": {
      const slug = interpolate(condition.slug, ctx);
      const ok = await probe.agreementExists(slug);
      return ok
        ? { met: true, reason: `agreement-registered: ${slug}` }
        : {
            met: false,
            reason: `agreement-registered condition unmet — governance/agreements/${slug}.md absent or empty`,
          };
    }
  }
};

/**
 * Validate every condition on an accountability. Met = ALL conditions
 * met (AND-semantics per ADR-0042). Returns per-condition results so
 * the wake-end summary can render which conditions are unmet.
 */
export interface AccountabilityValidationResult {
  readonly accountabilityId: string;
  readonly met: boolean;
  readonly conditions: readonly DoneConditionResult[];
}

export const validateAccountability = async (
  accountability: Accountability,
  ctx: DoneConditionContext,
  probe: StateProbe,
): Promise<AccountabilityValidationResult> => {
  const conditions: DoneConditionResult[] = [];
  for (const cond of accountability.done_when) {
    conditions.push(await validateCondition(cond, ctx, probe));
  }
  return {
    accountabilityId: accountability.id,
    met: conditions.every((c) => c.met),
    conditions,
  };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ISSUE_REF_PATTERN = /#?(\d+)$/;

const parseIssueNumber = (ref: string): number | null => {
  const match = ISSUE_REF_PATTERN.exec(ref);
  if (!match?.[1]) return null;
  const n = Number.parseInt(match[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const describeIssueFilter = (filter: IssueClosedFilter): string => {
  const parts: string[] = [];
  if (filter.number !== undefined) parts.push(`#${String(filter.number)}`);
  if (filter.author !== undefined) parts.push(`author=${filter.author}`);
  if (filter.type !== undefined) parts.push(`type=${filter.type}`);
  if (filter.label !== undefined) parts.push(`label=${filter.label}`);
  if (filter.state !== undefined) parts.push(`state=${filter.state}`);
  return parts.length > 0 ? `{${parts.join(", ")}}` : "<no filter>";
};

/**
 * Derive the period token for a given cadence + reference date. The
 * daemon calls this once per wake to populate
 * {@link DoneConditionContext.period}. Format follows ISO conventions
 * so role.md authors can predict the substitution:
 *
 *   - `weekly` → `YYYY-Www` (e.g. `2026-W18`)
 *   - `monthly` → `YYYY-MM`
 *   - `quarterly` → `YYYY-Qq`
 *   - `daily` → `YYYY-MM-DD`
 *   - other → ISO date (no narrower meaningful default)
 */
export const derivePeriod = (cadence: string, ref: Date): string => {
  const yyyy = String(ref.getUTCFullYear());
  const mm = String(ref.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(ref.getUTCDate()).padStart(2, "0");
  if (cadence === "monthly" || cadence === "quarterly") {
    if (cadence === "monthly") return `${yyyy}-${mm}`;
    const q = Math.floor(ref.getUTCMonth() / 3) + 1;
    return `${yyyy}-Q${String(q)}`;
  }
  if (cadence === "weekly" || cadence === "biweekly") {
    // ISO week: Thursday of the same ISO week determines the year.
    const target = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate()));
    const dayNr = (target.getUTCDay() + 6) % 7;
    target.setUTCDate(target.getUTCDate() - dayNr + 3);
    const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
    const week =
      1 +
      Math.round(
        ((target.getTime() - firstThursday.getTime()) / 86_400_000 -
          3 +
          ((firstThursday.getUTCDay() + 6) % 7)) /
          7,
      );
    return `${String(target.getUTCFullYear())}-W${String(week).padStart(2, "0")}`;
  }
  return `${yyyy}-${mm}-${dd}`;
};
