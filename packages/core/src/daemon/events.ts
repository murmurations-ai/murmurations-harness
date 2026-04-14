/**
 * Daemon Event Bus — typed event system for the harness daemon.
 *
 * The bus is a synchronous pub-sub: emit() calls all listeners inline.
 * This is intentional — events are lightweight notifications, not queued
 * work items. The daemon, HTTP server, and socket server subscribe to
 * receive events and forward them to their respective clients.
 *
 * Design principle: Events over polling. When state changes, emit an
 * event. Don't make consumers poll to discover it.
 */

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export interface WakeStartedEvent {
  readonly kind: "wake.started";
  readonly agentId: string;
  readonly wakeId: string;
}

export interface WakeCompletedEvent {
  readonly kind: "wake.completed";
  readonly agentId: string;
  readonly wakeId: string;
  readonly outcome: string;
  readonly artifactCount: number;
}

export interface MeetingStartedEvent {
  readonly kind: "meeting.started";
  readonly groupId: string;
  readonly meetingKind: string;
}

export interface MeetingCompletedEvent {
  readonly kind: "meeting.completed";
  readonly groupId: string;
  readonly meetingKind: string;
  readonly minutesUrl?: string | undefined;
  readonly transitions: readonly { readonly itemId: string; readonly to: string }[];
}

export interface GovernanceTransitionedEvent {
  readonly kind: "governance.transitioned";
  readonly itemId: string;
  readonly from: string;
  readonly to: string;
  readonly triggeredBy: string;
}

export interface CommandExecutedEvent {
  readonly kind: "command.executed";
  readonly method: string;
  readonly ok: boolean;
}

/** All daemon event types as a discriminated union. */
export type DaemonEvent =
  | WakeStartedEvent
  | WakeCompletedEvent
  | MeetingStartedEvent
  | MeetingCompletedEvent
  | GovernanceTransitionedEvent
  | CommandExecutedEvent;

// ---------------------------------------------------------------------------
// Listener type
// ---------------------------------------------------------------------------

export type DaemonEventListener = (event: DaemonEvent) => void;

// ---------------------------------------------------------------------------
// Event Bus
// ---------------------------------------------------------------------------

/**
 * Simple synchronous pub-sub event bus.
 *
 * - `subscribe()` returns an unsubscribe function (RAII-style cleanup).
 * - `emit()` delivers the event to all current subscribers synchronously.
 * - Listeners that throw are caught and logged — one bad listener doesn't
 *   break the bus.
 */
export class DaemonEventBus {
  readonly #listeners = new Set<DaemonEventListener>();

  /** Subscribe to all daemon events. Returns an unsubscribe function. */
  public subscribe(listener: DaemonEventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Emit an event to all subscribers. */
  public emit(event: DaemonEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (err: unknown) {
        // A listener must never crash the bus. Log and continue.
        process.stderr.write(
          `[DaemonEventBus] listener threw on ${event.kind}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }

  /** Number of active subscribers (useful for tests). */
  public get size(): number {
    return this.#listeners.size;
  }
}
