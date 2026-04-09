/**
 * @murmuration/cli — public entry point.
 *
 * The CLI proper lives in bin.ts. This module re-exports the small amount
 * of surface the CLI is willing to expose for programmatic use (e.g. in
 * tests).
 */

export { bootHelloWorldDaemon } from "./boot.js";
