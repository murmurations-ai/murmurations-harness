/**
 * Structured daemon logger with level filtering and event bus integration.
 *
 * Engineering Standard #9: silent error swallowing is a bug.
 * Every log call writes JSON to stdout and optionally emits a
 * `log.entry` event to the DaemonEventBus for SSE dashboard clients.
 */

import { scrubLogRecord } from "../secrets/index.js";
import type { DaemonEventBus } from "./events.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface DaemonLogger {
  debug(event: string, data?: Record<string, unknown>): void;
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Level ordering for filtering
// ---------------------------------------------------------------------------

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export interface DaemonLoggerOptions {
  readonly level?: LogLevel | undefined;
  readonly eventBus?: DaemonEventBus | undefined;
}

export class DaemonLoggerImpl implements DaemonLogger {
  readonly #level: number;
  readonly #eventBus: DaemonEventBus | undefined;

  public constructor(options: DaemonLoggerOptions = {}) {
    this.#level = LEVEL_ORDER[options.level ?? "info"];
    this.#eventBus = options.eventBus;
  }

  public debug(event: string, data?: Record<string, unknown>): void {
    this.#write("debug", event, data);
  }

  public info(event: string, data?: Record<string, unknown>): void {
    this.#write("info", event, data);
  }

  public warn(event: string, data?: Record<string, unknown>): void {
    this.#write("warn", event, data);
  }

  public error(event: string, data?: Record<string, unknown>): void {
    this.#write("error", event, data);
  }

  #write(level: LogLevel, event: string, data?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < this.#level) return;

    const scrubbed = scrubLogRecord(data ?? {});
    const ts = new Date().toISOString();
    const record = { ts, level, event, ...scrubbed };
    process.stdout.write(`${JSON.stringify(record)}\n`);

    // Push to event bus for SSE dashboard clients
    if (this.#eventBus) {
      try {
        this.#eventBus.emit({
          kind: "log.entry",
          level,
          event,
          ts,
          data: scrubbed,
        });
      } catch {
        // Never let bus errors break logging
      }
    }
  }
}
