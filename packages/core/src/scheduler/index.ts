/**
 * Scheduler — fires agent wakes on cron + event triggers.
 *
 * STUB: Phase 1 scaffold only. The scheduler will be implemented in
 * Phase 1 build work with cron-style triggers + event triggers, reading
 * wake schedules from agent role frontmatter (per spec §5.3 and §7.1).
 *
 * Not pluggable — core component per spec §4.1.
 */

export interface WakeTrigger {
  readonly kind: "cron" | "event";
}

export interface Scheduler {
  readonly name: string;
  // TODO: schedule(agent, trigger), unschedule(agent), tick(), etc.
}

export const SCHEDULER_STUB_VERSION = "0.0.0-stub" as const;
