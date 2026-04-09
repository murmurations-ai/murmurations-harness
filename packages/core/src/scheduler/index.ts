/**
 * Scheduler — fires agent wakes on cron + event triggers.
 *
 * Phase 1A scope: a single `TimerScheduler` that supports one-shot
 * delayed wakes (hello-world fires after N milliseconds) plus repeated
 * interval wakes. Real cron parsing and event triggers land in Phase 1B
 * per PHASE-1-PLAN.md step B3.
 *
 * Not pluggable — core component per spec §4.1.
 *
 * Reference: MURMURATION-HARNESS-SPEC.md §4.1, §7.1.
 */

import { randomUUID } from "node:crypto";

import type { AgentId, WakeId, WakeReason } from "../execution/index.js";
import { makeWakeId } from "../execution/index.js";

// ---------------------------------------------------------------------------
// Trigger types
// ---------------------------------------------------------------------------

/**
 * When and how a scheduled agent should wake.
 *
 * Phase 1A supports `delay-once` and `interval`. `cron` and
 * `event` are placeholders that will be filled out in Phase 1B (B3).
 */
export type WakeTrigger =
  | { readonly kind: "delay-once"; readonly delayMs: number }
  | { readonly kind: "interval"; readonly intervalMs: number }
  // TODO(B3): real cron parser
  | { readonly kind: "cron"; readonly expression: string }
  // TODO(B3): event bus wiring
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
            cronExpression: `@interval ${intervalMs}ms`,
          });
        }, intervalMs);
        break;
      }
      case "cron": {
        // TODO(B3): real cron parser. For Phase 1A, log and skip.
        // eslint-disable-next-line no-console
        console.warn(
          `[scheduler] cron triggers not yet supported (agent=${entry.agentId.value}, expr=${entry.trigger.expression})`,
        );
        break;
      }
      case "event": {
        // TODO(B3): event bus wiring. Phase 1A has no event source.
        // eslint-disable-next-line no-console
        console.warn(
          `[scheduler] event triggers not yet supported (agent=${entry.agentId.value}, eventType=${entry.trigger.eventType})`,
        );
        break;
      }
    }
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
        // eslint-disable-next-line no-console
        console.error(
          `[scheduler] listener threw for agent ${entry.agentId.value}:`,
          error,
        );
      }
    }
  }
}
