/**
 * @murmuration/secrets-dotenv
 *
 * Default {@link SecretsProvider} implementation. Reads secrets from a
 * `.env` file at the murmuration root, enforces POSIX file permission
 * hygiene, and refuses to expose any key that was not declared by the
 * caller at load time.
 *
 * Owned by Security Agent (#25). Ratified as part of Phase 1B-c
 * (commit `1B-c`). See `docs/adr/0010-secrets-provider-interface.md`
 * for rationale.
 */

import { readFile, stat } from "node:fs/promises";

import { parse as parseDotenv } from "dotenv";
import {
  makeSecretValue,
  SecretsProviderError,
  UnknownSecretKeyError,
  type SecretDeclaration,
  type SecretKey,
  type SecretsLoadResult,
  type SecretsProvider,
  type SecretsProviderCapabilities,
  type SecretValue,
} from "@murmuration/core";

// ---------------------------------------------------------------------------
// Error subclasses
// ---------------------------------------------------------------------------

/** `.env` file was not found at the configured path. */
export class EnvFileMissingError extends SecretsProviderError {
  public readonly code = "file-missing" as const;
  public readonly path: string;
  public constructor(path: string, options: { readonly cause?: unknown } = {}) {
    super(`.env file not found: ${path}`, options);
    this.path = path;
  }
}

/** `.env` file permissions are looser than the required `0600`. */
export class EnvFilePermissionsError extends SecretsProviderError {
  public readonly code = "permissions-too-loose" as const;
  public readonly path: string;
  public readonly mode: number;
  public constructor(path: string, mode: number, options: { readonly cause?: unknown } = {}) {
    super(`.env file ${path} has mode 0${mode.toString(8)}; required 0600 or stricter`, options);
    this.path = path;
    this.mode = mode;
  }
}

/** `dotenv.parse` could not parse the file. */
export class EnvFileParseError extends SecretsProviderError {
  public readonly code = "parse-failed" as const;
  public readonly path: string;
  public constructor(path: string, options: { readonly cause?: unknown } = {}) {
    super(`failed to parse .env at ${path}`, options);
    this.path = path;
  }
}

/** A secret declared as `required` was absent from the backing store. */
export class RequiredSecretMissingError extends SecretsProviderError {
  public readonly code = "required-missing" as const;
  public readonly key: SecretKey;
  public constructor(key: SecretKey, options: { readonly cause?: unknown } = {}) {
    super(`required secret missing: ${key.value}`, options);
    this.key = key;
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/** Constructor options for {@link DotenvSecretsProvider}. */
export interface DotenvSecretsProviderOptions {
  /** Absolute path to the `.env` file. */
  readonly envPath: string;
  /**
   * Skip the POSIX permission check. Off by default; only enable in
   * environments where file permissions are enforced out of band (e.g.
   * systemd units with `DynamicUser=yes`).
   */
  readonly skipPermissionCheck?: boolean;
}

const CAPABILITIES: SecretsProviderCapabilities = {
  id: "dotenv",
  displayName: "Dotenv Secrets Provider",
  version: "0.0.0-phase1b-c",
  supportsHotReload: false,
  stateful: false,
};

/**
 * Reads secrets from a `.env` file at `envPath`. See
 * `docs/adr/0010-secrets-provider-interface.md` for the full design.
 */
export class DotenvSecretsProvider implements SecretsProvider {
  readonly #envPath: string;
  readonly #skipPermissionCheck: boolean;
  readonly #values = new Map<string, SecretValue>();
  readonly #declared = new Set<string>();
  #loaded = false;

  public constructor(options: DotenvSecretsProviderOptions) {
    this.#envPath = options.envPath;
    this.#skipPermissionCheck = options.skipPermissionCheck ?? false;
  }

  public capabilities(): SecretsProviderCapabilities {
    return CAPABILITIES;
  }

  public async load(declaration: SecretDeclaration): Promise<SecretsLoadResult> {
    this.#declared.clear();
    for (const key of declaration.required) this.#declared.add(key.value);
    for (const key of declaration.optional) this.#declared.add(key.value);

    // Permission check (POSIX only).
    if (!this.#skipPermissionCheck && process.platform !== "win32") {
      try {
        const info = await stat(this.#envPath);
        const mode = info.mode & 0o777;
        if ((mode & 0o077) !== 0) {
          return {
            ok: false,
            error: new EnvFilePermissionsError(this.#envPath, mode),
          };
        }
      } catch (cause) {
        if (isEnoent(cause)) {
          return { ok: false, error: new EnvFileMissingError(this.#envPath, { cause }) };
        }
        return {
          ok: false,
          error: new EnvFileParseError(this.#envPath, { cause }),
        };
      }
    }

    // Read + parse.
    let raw: string;
    try {
      raw = await readFile(this.#envPath, "utf8");
    } catch (cause) {
      if (isEnoent(cause)) {
        return { ok: false, error: new EnvFileMissingError(this.#envPath, { cause }) };
      }
      return { ok: false, error: new EnvFileParseError(this.#envPath, { cause }) };
    }

    let parsed: Record<string, string>;
    try {
      parsed = parseDotenv(raw);
    } catch (cause) {
      return { ok: false, error: new EnvFileParseError(this.#envPath, { cause }) };
    }

    // Warn on lines that aren't blank, comments, or valid KEY=value
    // assignments. These are almost always typos (e.g. pasting a bare
    // token without the KEY= prefix) and cause silent degradation
    // when the provider skips them. Closes #26.
    for (const [idx, line] of raw.split(/\r?\n/).entries()) {
      if (line.trim().length === 0) continue; // blank
      if (/^\s*#/.test(line)) continue; // comment
      if (/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line)) continue; // valid
      // Warn without revealing the value — show first 20 chars max.
      const preview = line.length > 20 ? `${line.slice(0, 20)}...` : line;
      console.warn(
        `[secrets:dotenv] ${this.#envPath} line ${String(idx + 1)}: malformed — expected KEY=value, got "${preview}"`,
      );
    }

    // Only load declared keys. Undeclared keys are silently ignored
    // (least-privilege — we don't hold what we weren't asked for).
    this.#values.clear();
    for (const key of declaration.required) {
      const value = parsed[key.value];
      if (value === undefined) {
        return { ok: false, error: new RequiredSecretMissingError(key) };
      }
      this.#values.set(key.value, makeSecretValue(value));
    }
    const missingOptional: SecretKey[] = [];
    for (const key of declaration.optional) {
      const value = parsed[key.value];
      if (value === undefined) {
        missingOptional.push(key);
        continue;
      }
      this.#values.set(key.value, makeSecretValue(value));
    }

    this.#loaded = true;
    return {
      ok: true,
      loadedCount: this.#values.size,
      missingOptional,
    };
  }

  public get(key: SecretKey): SecretValue {
    if (!this.#loaded) {
      throw new Error("DotenvSecretsProvider: get() called before load()");
    }
    if (!this.#declared.has(key.value)) {
      throw new UnknownSecretKeyError(key);
    }
    const value = this.#values.get(key.value);
    if (!value) {
      throw new UnknownSecretKeyError(key);
    }
    return value;
  }

  public has(key: SecretKey): boolean {
    return this.#values.has(key.value);
  }

  public loadedKeys(): readonly SecretKey[] {
    return [...this.#values.keys()].map((value) => ({
      kind: "secret-key" as const,
      value,
    }));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isEnoent = (err: unknown): boolean => {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === "ENOENT";
};
