/**
 * Secrets — pluggable boundary between the daemon and whatever backs the
 * secrets store (dotenv file, OS keychain, Vault, etc.).
 *
 * Closes the interface portion of Phase 1B step B1. The default provider
 * ({@link https://github.com/murmurations-ai/murmurations-harness/tree/main/packages/secrets-dotenv | `@murmuration/secrets-dotenv`})
 * reads from a `.env` file; alternate providers slot in by implementing
 * the {@link SecretsProvider} interface here.
 *
 * Owned by Security Agent (#25). Design doc ratified by the Engineering
 * Circle on 2026-04-09 as part of commit `1B-c`.
 *
 * ## Key design decisions (ADR-0010)
 *
 * 1. **Eager, read-once.** `load()` is called exactly once at daemon
 *    boot. A missing required secret halts the daemon immediately rather
 *    than failing at first use.
 * 2. **`SecretValue` uses a method accessor, not a property.** This is
 *    a deliberate deviation from ADR-0006 (branded primitives usually
 *    expose `.value`): property access is enumerable and would leak the
 *    raw secret through structured logging. A `reveal()` method is
 *    grep-able, non-enumerable, and `toJSON`/`toString` return a
 *    redaction sentinel.
 * 3. **Three layers of redaction.** Type-level (no enumerable `.value`);
 *    runtime serialization (`toJSON` sentinel); and a name-based
 *    scrubber applied by the default daemon logger.
 *
 * @packageDocumentation
 */

// ---------------------------------------------------------------------------
// Error taxonomy
// ---------------------------------------------------------------------------

/** Discriminant for the secrets-provider error taxonomy. */
export type SecretsProviderErrorCode =
  | "file-missing"
  | "permissions-too-loose"
  | "parse-failed"
  | "required-missing"
  | "unknown-key"
  | "internal";

/**
 * Base class for all {@link SecretsProvider} errors. Follows the same
 * pattern as {@link import("../execution/index.js").ExecutorError} and
 * {@link import("../identity/index.js").IdentityLoaderError}: a stable
 * `code` discriminant, `cause` support, and subclass names preserved
 * via `new.target.name`.
 */
export abstract class SecretsProviderError extends Error {
  public abstract readonly code: SecretsProviderErrorCode;
  public override readonly cause: unknown;
  protected constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message);
    this.name = new.target.name;
    this.cause = options.cause;
  }
}

// ---------------------------------------------------------------------------
// Branded primitives
// ---------------------------------------------------------------------------

/**
 * A secret key name (e.g. `"GITHUB_TOKEN"`). Not sensitive; safe to log.
 *
 * Validated on construction to match `/^[A-Z][A-Z0-9_]*$/` — the
 * conventional shape for environment-variable-style secrets.
 */
export interface SecretKey {
  readonly kind: "secret-key";
  readonly value: string;
}

const SECRET_KEY_RE = /^[A-Z][A-Z0-9_]*$/;

/** Construct a {@link SecretKey}, throwing on invalid format. */
export const makeSecretKey = (value: string): SecretKey => {
  if (!SECRET_KEY_RE.test(value)) {
    throw new Error(`invalid secret key: "${value}" (must match /^[A-Z][A-Z0-9_]*$/)`);
  }
  return { kind: "secret-key", value };
};

/**
 * A secret value. **Deliberately not a plain string.**
 *
 * Access the raw bytes via `reveal()`. Structured logging that
 * accidentally includes a {@link SecretValue} emits the redaction
 * sentinel, not the raw bytes, because `toJSON` and `toString` both
 * return `"[REDACTED:length=N]"`.
 *
 * See ADR-0010 for the rationale for deviating from the ADR-0006
 * wrapped-object pattern (which would have exposed `.value`).
 */
export interface SecretValue {
  readonly kind: "secret-value";
  readonly length: number;
  reveal(): string;
  toJSON(): string;
  toString(): string;
}

/**
 * Construct a {@link SecretValue}. The raw bytes live inside a closure,
 * not a property, so they cannot be enumerated by `JSON.stringify`.
 */
export const makeSecretValue = (raw: string): SecretValue => {
  const length = raw.length;
  const sentinel = `[REDACTED:length=${String(length)}]`;
  return {
    kind: "secret-value",
    length,
    reveal: () => raw,
    toJSON: () => sentinel,
    toString: () => sentinel,
  };
};

// ---------------------------------------------------------------------------
// Declaration + result
// ---------------------------------------------------------------------------

/**
 * Declaration of which secrets the daemon expects at boot. The provider
 * uses this to:
 *
 *   1. Reject boot if any `required` key is missing from the backing store.
 *   2. Refuse to expose any key that wasn't declared (least-privilege).
 */
export interface SecretDeclaration {
  readonly required: readonly SecretKey[];
  readonly optional: readonly SecretKey[];
}

/**
 * Result of {@link SecretsProvider.load}. Errors-as-values per ADR-0005.
 */
export type SecretsLoadResult =
  | {
      readonly ok: true;
      readonly loadedCount: number;
      readonly missingOptional: readonly SecretKey[];
    }
  | {
      readonly ok: false;
      readonly error: SecretsProviderError;
    };

/** Declarative description of a secrets provider implementation. */
export interface SecretsProviderCapabilities {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly supportsHotReload: boolean;
  readonly stateful: boolean;
}

// ---------------------------------------------------------------------------
// The SecretsProvider interface
// ---------------------------------------------------------------------------

/**
 * Pluggable secrets backend. Long-lived, owned by the daemon, and
 * populated exactly once via {@link SecretsProvider.load} at boot.
 */
export interface SecretsProvider {
  /**
   * Load secrets from the backing store and validate required keys.
   * Called exactly once at daemon boot. Subsequent `get` calls return
   * from the in-memory map populated here.
   */
  load(declaration: SecretDeclaration): Promise<SecretsLoadResult>;

  /**
   * Retrieve a declared secret. Throws {@link UnknownSecretKeyError} if
   * the key was not in the declaration passed to `load()` — that is a
   * programmer error, not a runtime condition.
   */
  get(key: SecretKey): SecretValue;

  /** True if a declared secret was actually present in the backing store. */
  has(key: SecretKey): boolean;

  /** Names of all successfully loaded secrets. Safe to log. */
  loadedKeys(): readonly SecretKey[];

  /** Describe this provider implementation. */
  capabilities(): SecretsProviderCapabilities;
}

/**
 * Programmer error: called `get()` with a key that wasn't declared.
 *
 * This class lives in `@murmuration/core` so it can be raised by both
 * the core interface contract and concrete providers without each
 * provider defining its own.
 */
export class UnknownSecretKeyError extends SecretsProviderError {
  public readonly code = "unknown-key" as const;
  public readonly key: SecretKey;
  public constructor(key: SecretKey) {
    super(`secret key not declared: ${key.value}`);
    this.key = key;
  }
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Symbol-keyed bucket on log records that the default logger strips
 * before serialization. Plugins opt into redaction of their own
 * sensitive fields by placing them under this symbol:
 *
 * ```ts
 * logger.info("plugin.channel.send", {
 *   destination: "#ops",
 *   [REDACT]: { webhookSignature: sig },
 * });
 * ```
 */
export const REDACT: unique symbol = Symbol.for("@murmuration/core/secrets/redact");

/**
 * Field names whose values look sensitive-by-name. Used by the default
 * daemon logger's scrubber as a belt-and-suspenders safeguard against
 * accidental plain-text leaks.
 *
 * The regex matches the most common sensitive name fragments; callers
 * that want to log a field whose name happens to match must either
 * rename the field or move it under the {@link REDACT} symbol (which is
 * stripped entirely).
 */
export const SENSITIVE_FIELD_NAME_RE =
  /token|secret|password|credential|auth|apikey|api_key|privatekey|private_key/i;

/** Threshold in characters above which a sensitive-named string is scrubbed. */
export const SCRUB_MIN_LENGTH = 8;

/**
 * Walk a logger record and return a shallow copy with sensitive values
 * replaced by redaction sentinels. The walker is intentionally
 * non-recursive on arrays/objects to keep logger overhead low; nested
 * sensitive data should go under the {@link REDACT} symbol.
 *
 * Rules:
 *
 *  1. Any field under the {@link REDACT} symbol is removed entirely.
 *  2. Any string-valued field whose **key name** matches
 *     {@link SENSITIVE_FIELD_NAME_RE} and whose value length is at least
 *     {@link SCRUB_MIN_LENGTH} is replaced with
 *     `"[REDACTED:scrubbed-by-name]"`.
 *  3. Any {@link SecretValue} already serializes to its own sentinel
 *     via `toJSON`, so the scrubber need not special-case it.
 */
export const scrubLogRecord = (data: Record<string, unknown>): Record<string, unknown> => {
  const scrub = (obj: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (
        typeof value === "string" &&
        SENSITIVE_FIELD_NAME_RE.test(key) &&
        value.length >= SCRUB_MIN_LENGTH
      ) {
        out[key] = "[REDACTED:scrubbed-by-name]";
        continue;
      }
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        out[key] = scrub(value as Record<string, unknown>);
        continue;
      }
      out[key] = value;
    }
    return out;
  };
  return scrub(data);
};
