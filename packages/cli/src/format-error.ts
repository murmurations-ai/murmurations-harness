/**
 * Operator-visible fatal-error formatting (harness#360).
 *
 * Lives in its own file because `bin.ts` runs the CLI on import (it
 * calls `main()` at top level), so anything that wants to unit-test
 * this helper would otherwise trigger the entire daemon command loop.
 */

/**
 * Format an unknown error for the operator's stderr.
 *
 * Preserves the typed-error discriminator (`error.name`) when it carries
 * useful information beyond the generic `"Error"`, so plugin-error
 * classes (`PluginInitError`, `PluginEventError`, `PluginTimeoutError`,
 * and any future typed daemon errors) remain greppable in operator logs
 * and telemetry pipelines instead of being flattened to plain
 * `"fatal: <message>"`.
 *
 * Format:
 *   - Generic Error → `murmuration: fatal: <message>`
 *   - Typed Error   → `murmuration: fatal: [<ErrorName>] <message>`
 *   - non-Error     → `murmuration: fatal: <String(error)>`
 */
export const formatFatalError = (error: unknown): string => {
  if (error instanceof Error) {
    const prefix = error.name && error.name !== "Error" ? `[${error.name}] ` : "";
    return `murmuration: fatal: ${prefix}${error.message}`;
  }
  return `murmuration: fatal: ${String(error)}`;
};
