/**
 * Secrets — pluggable boundary between the daemon and whatever backs the
 * secrets store (dotenv file, OS keychain, Vault, etc.).
 *
 * Closes the interface portion of Phase 1B step B1. The default provider
 * ({@link https://github.com/murmurations-ai/murmurations-harness/tree/main/packages/secrets-dotenv | `@murmurations-ai/secrets-dotenv`})
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
 * This class lives in `@murmurations-ai/core` so it can be raised by both
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
export const REDACT: unique symbol = Symbol.for("@murmurations-ai/core/secrets/redact");

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
 * Value-level secret patterns. Match known vendor key formats in any
 * string value regardless of the enclosing field name. This catches
 * leaks that bypass the name-based scrub — most commonly: keys
 * embedded in provider error messages, HTTP response bodies echoed
 * into stack traces, subprocess stderr tails, and agent-authored
 * strings that inadvertently quote tool output.
 *
 * Named groups so the replacement can identify which pattern hit,
 * which helps operators tell whether a leak is from a human-visible
 * identifier (harmless false positive) or an actual credential.
 *
 * Priority order: longer/more-specific patterns first so overlapping
 * matches resolve to the most informative label.
 */
export const VALUE_SECRET_PATTERNS: readonly { readonly name: string; readonly re: RegExp }[] = [
  // PEM keys
  { name: "pem", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  // Google (Gemini) API keys
  { name: "gemini", re: /AIza[0-9A-Za-z_-]{30,}/g },
  // Anthropic API keys
  { name: "anthropic", re: /sk-ant-[a-zA-Z0-9_-]{30,}/g },
  // GitHub Personal Access Tokens (classic)
  { name: "github-pat", re: /ghp_[A-Za-z0-9]{30,}/g },
  // GitHub OAuth tokens
  { name: "github-oauth", re: /gho_[A-Za-z0-9]{30,}/g },
  // GitHub fine-grained PATs
  { name: "github-fg-pat", re: /github_pat_[A-Za-z0-9_]{30,}/g },
  // GitHub server-to-server
  { name: "github-s2s", re: /ghs_[A-Za-z0-9]{30,}/g },
  // GitHub refresh + user tokens
  { name: "github-refresh", re: /ghr_[A-Za-z0-9]{30,}/g },
  { name: "github-user", re: /ghu_[A-Za-z0-9]{30,}/g },
  // Slack bot/app/user/refresh tokens
  { name: "slack", re: /xox[baprs]-[A-Za-z0-9-]{20,}/g },
  // OpenAI-style "sk-" keys (kept last; least specific — 'sk-ant-' already handled above)
  { name: "openai", re: /sk-[a-zA-Z0-9]{30,}/g },
];

/**
 * Apply every {@link VALUE_SECRET_PATTERNS} entry to a string and
 * replace each match with `[REDACTED:<name>]`. Non-destructive if the
 * string has no matches.
 */
export const scrubValuePatterns = (value: string): string => {
  let out = value;
  for (const { name, re } of VALUE_SECRET_PATTERNS) {
    out = out.replace(re, `[REDACTED:${name}]`);
  }
  return out;
};

/**
 * Walk a logger record and return a deep copy with sensitive values
 * replaced by redaction sentinels.
 *
 * Rules:
 *
 *  1. Any field under the {@link REDACT} symbol is removed entirely.
 *  2. Any string whose **key name** matches {@link SENSITIVE_FIELD_NAME_RE}
 *     and whose length is at least {@link SCRUB_MIN_LENGTH} is replaced
 *     with `"[REDACTED:scrubbed-by-name]"`.
 *  3. Any remaining string is passed through {@link scrubValuePatterns}
 *     so vendor-format secrets embedded in error messages, stderr
 *     tails, or agent output are caught even when the enclosing key
 *     is benign (`error`, `message`, `stderr`, `output`).
 *  4. Arrays are walked; each element is scrubbed in place.
 *  5. {@link SecretValue} already serializes to its own sentinel via
 *     `toJSON`, so the scrubber need not special-case it.
 */
export const scrubLogRecord = (data: Record<string, unknown>): Record<string, unknown> => {
  const scrubValue = (value: unknown, keyForNameMatch?: string): unknown => {
    if (typeof value === "string") {
      if (
        keyForNameMatch !== undefined &&
        SENSITIVE_FIELD_NAME_RE.test(keyForNameMatch) &&
        value.length >= SCRUB_MIN_LENGTH
      ) {
        return "[REDACTED:scrubbed-by-name]";
      }
      return scrubValuePatterns(value);
    }
    if (Array.isArray(value)) {
      return value.map((v) => scrubValue(v));
    }
    if (value !== null && typeof value === "object") {
      return scrubObject(value as Record<string, unknown>);
    }
    return value;
  };

  const scrubObject = (obj: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      out[key] = scrubValue(value, key);
    }
    return out;
  };

  return scrubObject(data);
};
