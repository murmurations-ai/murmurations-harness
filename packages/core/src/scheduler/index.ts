/**
 * Scheduler — fires agent wakes on cron + event triggers.
 *
 * `TimerScheduler` supports four trigger kinds:
 *
 *   - `delay-once`  — one-shot setTimeout after N ms
 *   - `interval`    — setInterval repeating every N ms
 *   - `cron`        — compute the next fire time via cron-parser,
 *                     setTimeout to that delta, and re-arm on fire
 *   - `event`       — still a stub (Phase 3 event bus)
 *
 * Cron support landed in Phase 2D step 2D4. Expressions are parsed
 * with `tz: "UTC"` always — `0 18 * * 0` means Sunday 18:00 UTC
 * regardless of the operator's local timezone. This matches the
 * ADR-0016 role template convention and makes wake timings
 * deterministic across machines and CI. Per-role timezone overrides
 * Per-role timezone overrides are supported via the `tz` field on
 * the `cron` trigger (e.g. `tz: "America/Vancouver"`).
 *
 * Not pluggable — core component per spec §4.1.
 *
 * Reference: MURMURATION-HARNESS-SPEC.md §4.1, §7.1.
 */

import { randomUUID } from "node:crypto";

import cronParser from "cron-parser";

import type { AgentId, WakeId, WakeReason } from "../execution/index.js";
import { makeWakeId } from "../execution/index.js";

// ---------------------------------------------------------------------------
// Trigger types
// ---------------------------------------------------------------------------

/**
 * When and how a scheduled agent should wake.
 *
 * `delay-once`, `interval`, and `cron` are fully implemented. `event`
 * is still a stub pending the Phase 3 event bus.
 */
export type WakeTrigger =
  | { readonly kind: "delay-once"; readonly delayMs: number }
  | { readonly kind: "interval"; readonly intervalMs: number }
  | { readonly kind: "cron"; readonly expression: string; readonly tz?: string }
  // TODO(phase-3): event bus wiring
  | { readonly kind: "event"; readonly eventType: string };

// ---------------------------------------------------------------------------
// Scheduled event payload
// ---------------------------------------------------------------------------

/**
 * Event the scheduler emits when a wake should fire. The daemon consumes
 * this and turns it into an {@link AgentSpawnContext} via the signal
 * aggregator + identity loader before calling the executor.
 */
export interface ScheduledWakeEvent {
  readonly wakeId: WakeId;
  readonly agentId: AgentId;
  readonly wakeReason: WakeReason;
  readonly firedAt: Date;
}

/** Async listener for wake events. */
export type WakeListener = (event: ScheduledWakeEvent) => Promise<void> | void;

// ---------------------------------------------------------------------------
// Scheduler interface
// ---------------------------------------------------------------------------

export interface Scheduler {
  /** Register an agent for scheduled wakes. Idempotent on `agentId`. */
  schedule(agentId: AgentId, trigger: WakeTrigger): void;
  /** Cancel all scheduled wakes for an agent. Returns `true` if removed. */
  unschedule(agentId: AgentId): boolean;
  /** Attach a listener that fires every time a scheduled wake triggers. */
  onWake(listener: WakeListener): void;
  /** Begin firing scheduled wakes. Idempotent. */
  start(): void;
  /** Stop firing and clear all in-flight timers. Safe to re-start. */
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// TimerScheduler — the Phase 1A implementation
// ---------------------------------------------------------------------------

interface ScheduledEntry {
  readonly agentId: AgentId;
  readonly trigger: WakeTrigger;
  timerHandle: NodeJS.Timeout | undefined;
}

/**
 * In-memory scheduler using Node timers. Not persistent across restarts —
 * scheduled entries are re-registered by the daemon at boot from the
 * agent registry.
 */
export class TimerScheduler implements Scheduler {
  readonly #entries = new Map<string, ScheduledEntry>();
  readonly #listeners: WakeListener[] = [];
  #running = false;

  public schedule(agentId: AgentId, trigger: WakeTrigger): void {
    // Replace any existing entry for this agent (idempotent per spec).
    this.unschedule(agentId);
    const entry: ScheduledEntry = {
      agentId,
      trigger,
      timerHandle: undefined,
    };
    this.#entries.set(agentId.value, entry);
    if (this.#running) {
      this.#arm(entry);
    }
  }

  public unschedule(agentId: AgentId): boolean {
    const entry = this.#entries.get(agentId.value);
    if (!entry) return false;
    if (entry.timerHandle) {
      clearTimeout(entry.timerHandle);
      clearInterval(entry.timerHandle);
      entry.timerHandle = undefined;
    }
    this.#entries.delete(agentId.value);
    return true;
  }

  public onWake(listener: WakeListener): void {
    this.#listeners.push(listener);
  }

  public start(): void {
    if (this.#running) return;
    this.#running = true;
    for (const entry of this.#entries.values()) {
      this.#arm(entry);
    }
  }

  // The interface declares stop() async to keep the door open for
  // future schedulers that need to drain queued work. TimerScheduler
  // does its cleanup synchronously.
  // eslint-disable-next-line @typescript-eslint/require-await
  public async stop(): Promise<void> {
    this.#running = false;
    for (const entry of this.#entries.values()) {
      if (entry.timerHandle) {
        clearTimeout(entry.timerHandle);
        clearInterval(entry.timerHandle);
        entry.timerHandle = undefined;
      }
    }
  }

  #arm(entry: ScheduledEntry): void {
    switch (entry.trigger.kind) {
      case "delay-once": {
        const delay = entry.trigger.delayMs;
        entry.timerHandle = setTimeout(() => {
          entry.timerHandle = undefined;
          void this.#fire(entry, {
            kind: "manual",
            invokedBy: "scheduler:delay-once",
          });
        }, delay);
        break;
      }
      case "interval": {
        const intervalMs = entry.trigger.intervalMs;
        entry.timerHandle = setInterval(() => {
          void this.#fire(entry, {
            kind: "scheduled",
            cronExpression: `@interval ${String(intervalMs)}ms`,
          });
        }, intervalMs);
        break;
      }
      case "cron": {
        // Compute the next fire time from *now*, setTimeout to the
        // delta, then on fire re-arm recursively. Each re-arm is a
        // fresh setTimeout so the scheduler never accumulates drift
        // from accumulated setTimeout lateness — cron-parser always
        // recomputes from the current wall clock.
        this.#armCron(entry);
        break;
      }
      case "event": {
        // TODO(B3): event bus wiring. Phase 1A has no event source.
        console.warn(
          `[scheduler] event triggers not yet supported (agent=${entry.agentId.value}, eventType=${entry.trigger.eventType})`,
        );
        break;
      }
    }
  }

  /**
   * Arm (or re-arm) a cron-triggered entry. Computes the next fire
   * time from `new Date()` via cron-parser, setTimeout to the delta,
   * and on fire recursively re-arms itself. If the entry has been
   * unscheduled or the scheduler stopped between arm and fire, the
   * timeout callback exits without firing.
   *
   * Malformed expressions should have been caught at frontmatter
   * parse time (the identity loader validates cron strings via the
   * same cron-parser library), but if a caller bypasses the loader
   * and schedules a bad expression directly, the catch logs the
   * error and leaves the entry un-armed — the scheduler continues
   * running for other agents.
   */
  #armCron(entry: ScheduledEntry): void {
    if (entry.trigger.kind !== "cron") return;
    const expression = entry.trigger.expression;

    let delayMs: number;
    try {
      const tz = entry.trigger.tz ?? "UTC";
      const parsed = cronParser.parseExpression(expression, {
        currentDate: new Date(),
        tz,
      });
      const next = parsed.next();
      // cron-parser returns a CronDate whose `getTime()` is the next
      // fire epoch-ms.
      const nextMs = next.getTime();
      delayMs = Math.max(0, nextMs - Date.now());
    } catch (error) {
      console.error(
        `[scheduler] failed to compute next fire time for agent ${entry.agentId.value} (expr=${expression}):`,
        error,
      );
      return;
    }

    entry.timerHandle = setTimeout(() => {
      entry.timerHandle = undefined;
      // If the scheduler was stopped or this entry unscheduled during
      // the wait, #running/the entry map will catch it in #fire and
      // the re-arm below.
      void (async (): Promise<void> => {
        await this.#fire(entry, {
          kind: "scheduled",
          cronExpression: expression,
        });
        if (this.#running && this.#entries.get(entry.agentId.value) === entry) {
          this.#armCron(entry);
        }
      })();
    }, delayMs);
  }

  async #fire(entry: ScheduledEntry, wakeReason: WakeReason): Promise<void> {
    if (!this.#running) return;
    const event: ScheduledWakeEvent = {
      wakeId: makeWakeId(randomUUID()),
      agentId: entry.agentId,
      wakeReason,
      firedAt: new Date(),
    };
    for (const listener of this.#listeners) {
      try {
        await listener(event);
      } catch (error) {
        console.error(`[scheduler] listener threw for agent ${entry.agentId.value}:`, error);
      }
    }
  }
}
