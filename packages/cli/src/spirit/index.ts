/**
 * Spirit of the Murmuration — Phase 1 (ADR-0024).
 *
 * Public entry points for the REPL dispatcher. Phase 1 ships auto-allow
 * tools only (reads + daemon RPCs); mutations land in Phase 2.
 */

export {
  initSpiritSession,
  SpiritUnavailableError,
  type SpiritSession,
  type SpiritTurnResult,
  type SpiritInitOptions,
} from "./client.js";
