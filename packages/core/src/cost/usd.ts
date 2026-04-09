/**
 * USD micros — the monetary unit used for all cost accounting in the
 * harness. One USD = 1,000,000 micros. Integer-only to avoid
 * floating-point drift when summing many small amounts.
 *
 * Owned by Performance / Observability Agent (#27). Closes part of
 * Phase 1B step B5 (cost instrumentation plumbing, carry-forward #5).
 */

/**
 * A monetary amount in USD micros. Wrapped-object brand per ADR-0006.
 *
 * Construct via {@link makeUSDMicros}. The stored `value` is always a
 * non-negative integer.
 */
export interface USDMicros {
  readonly kind: "usd-micros";
  readonly value: number;
}

/** Construct a {@link USDMicros} amount from an integer micros count. */
export const makeUSDMicros = (value: number): USDMicros => {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`USDMicros must be a non-negative integer, got ${String(value)}`);
  }
  return { kind: "usd-micros", value };
};

/** The constant zero amount, handy as a default. */
export const ZERO_USD_MICROS: USDMicros = { kind: "usd-micros", value: 0 };

/** Sum two amounts, returning a new {@link USDMicros}. */
export const addUSDMicros = (a: USDMicros, b: USDMicros): USDMicros =>
  makeUSDMicros(a.value + b.value);

/**
 * Human-readable 4-digit USD string, for log fields that want a
 * formatted sibling to the integer micros count. Consumers computing
 * aggregates must use the integer `.value`, not this string.
 */
export const formatUSDMicros = (m: USDMicros): string => (m.value / 1_000_000).toFixed(4);
