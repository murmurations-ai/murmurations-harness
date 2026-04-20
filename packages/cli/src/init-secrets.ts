/**
 * Interactive secret capture for `murmuration init` — v0.5.0 Milestone 2.
 *
 * Prompts with stdin in raw mode so characters aren't echoed to the
 * terminal. Provides a provider-specific shape-validation heuristic
 * (catches paste-from-wrong-clipboard; not cryptographic). Shows a
 * masked last-4 confirmation so the operator can verify the paste
 * landed. ENTER-to-skip returns an empty string and the caller writes
 * a placeholder to .env.
 *
 * Exported helpers are pure (no side effects beyond stdio) so init.ts
 * composes them and tests exercise each piece in isolation.
 */

// ---------------------------------------------------------------------------
// Known LLM providers
// ---------------------------------------------------------------------------

export type KnownProvider = "gemini" | "anthropic" | "openai" | "ollama";

/** What env var name each provider's key lives under, and how to shape-check a paste. */
export interface ProviderKeySpec {
  readonly envVar: string;
  readonly displayName: string;
  /** Human phrase describing the expected prefix ("starts with `AIza`"). */
  readonly prefixHint: string;
  /** Returns null if the value is shape-valid; otherwise a remediation string. */
  validate(value: string): string | null;
}

const buildSpec = (
  envVar: string,
  displayName: string,
  prefixes: readonly string[],
  minLength: number,
): ProviderKeySpec => ({
  envVar,
  displayName,
  prefixHint:
    prefixes.length === 1
      ? `starts with \`${prefixes[0]!}\``
      : `starts with one of ${prefixes.map((p) => `\`${p}\``).join(", ")}`,
  validate(value) {
    const v = value.trim();
    if (v.length === 0) return null; // empty = caller treats as skip
    if (!prefixes.some((p) => v.startsWith(p))) {
      return `expected to ${
        prefixes.length === 1
          ? `start with \`${prefixes[0]!}\``
          : `start with one of ${prefixes.map((p) => `\`${p}\``).join(", ")}`
      }`;
    }
    if (v.length < minLength) {
      return `looks too short (got ${String(v.length)} chars, expected ≥${String(minLength)})`;
    }
    return null;
  },
});

export const LLM_KEY_SPECS: Readonly<Record<Exclude<KnownProvider, "ollama">, ProviderKeySpec>> = {
  gemini: buildSpec("GEMINI_API_KEY", "Gemini", ["AIza"], 35),
  anthropic: buildSpec("ANTHROPIC_API_KEY", "Anthropic", ["sk-ant-"], 40),
  openai: buildSpec("OPENAI_API_KEY", "OpenAI", ["sk-"], 40),
};

export const GITHUB_TOKEN_SPEC: ProviderKeySpec = buildSpec(
  "GITHUB_TOKEN",
  "GitHub",
  ["ghp_", "gho_", "github_pat_"],
  20,
);

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

/**
 * Return a masked representation of a secret: the last 4 characters
 * prefixed with an ellipsis, plus the length. Returns "<empty>" if
 * the secret is empty — never returns anything that leaks the key.
 */
export const maskSecret = (secret: string): string => {
  const s = secret.trim();
  if (s.length === 0) return "<empty>";
  if (s.length <= 4) return `…${s} (length ${String(s.length)})`;
  const last4 = s.slice(-4);
  return `…${last4} (length ${String(s.length)})`;
};

// ---------------------------------------------------------------------------
// Echo-off input
// ---------------------------------------------------------------------------

export interface SecretPromptOptions {
  /** The prompt shown before raw-mode capture begins. */
  readonly question: string;
  /** Abort signal (Ctrl+C). Caller decides what to do with it. */
  readonly onAbort?: () => void;
  /**
   * Input/output streams — override for tests. Defaults to
   * `process.stdin` / `process.stdout`.
   */
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
}

/**
 * Prompt for a secret with stdin in raw mode (no echo). Returns the
 * captured string with the trailing newline stripped. Empty return
 * value means the operator pressed ENTER to skip.
 *
 * Composes cleanly with readline by asking callers to pause() their
 * readline interface before calling this, then resume() afterwards.
 * The function takes over stdin for the duration of the prompt and
 * restores raw mode + listeners to their prior state on exit.
 */
export const promptSecret = async (options: SecretPromptOptions): Promise<string> => {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;

  // Non-TTY fallback: read one line of input without raw-mode games.
  // Used by CI and tests.
  if (!stdin.isTTY) {
    stdout.write(options.question);
    return readOneLineFromStream(stdin);
  }

  stdout.write(options.question);

  return new Promise((resolveFn, rejectFn) => {
    const chars: string[] = [];
    const previousRaw = stdin.isRaw;
    let settled = false;

    const cleanup = (): void => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(previousRaw);
      stdin.pause();
    };

    const settleResolve = (value: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      stdout.write("\n");
      resolveFn(value);
    };

    const settleReject = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      stdout.write("\n");
      rejectFn(err);
    };

    const onData = (data: Buffer | string): void => {
      const str = typeof data === "string" ? data : data.toString("utf8");
      for (const ch of str) {
        const code = ch.charCodeAt(0);
        if (code === 13 || code === 10) {
          settleResolve(chars.join(""));
          return;
        }
        if (code === 3) {
          options.onAbort?.();
          settleReject(new Error("aborted by Ctrl+C"));
          return;
        }
        if (code === 8 || code === 127) {
          // backspace / delete — pop one character silently
          if (chars.length > 0) chars.pop();
          continue;
        }
        if (code < 32) {
          // swallow other control chars
          continue;
        }
        chars.push(ch);
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
};

/** Non-TTY fallback: read one newline-terminated line from stdin. */
const readOneLineFromStream = (stdin: NodeJS.ReadStream): Promise<string> =>
  new Promise((resolveFn) => {
    let buffer = "";
    const onData = (chunk: Buffer | string): void => {
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      buffer += s;
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx >= 0) {
        stdin.removeListener("data", onData);
        stdin.pause();
        resolveFn(buffer.slice(0, newlineIdx).replace(/\r$/, ""));
      }
    };
    stdin.on("data", onData);
    stdin.resume();
  });

// ---------------------------------------------------------------------------
// Capture-loop with shape validation + masked confirmation
// ---------------------------------------------------------------------------

export interface CaptureSecretOptions {
  readonly spec: ProviderKeySpec;
  /** Write function for user-visible messages (log/err). Defaults to stdout.write. */
  readonly log?: (message: string) => void;
  /** ask(...) style prompt, for Y/n confirmation. */
  readonly askYN: (question: string) => Promise<string>;
  /**
   * If set, used instead of {@link promptSecret}. Tests inject this
   * to drive the capture loop deterministically.
   */
  readonly promptSecretFn?: (options: SecretPromptOptions) => Promise<string>;
  readonly maxAttempts?: number;
}

/**
 * Full capture cycle: echo-off prompt → shape validation → masked
 * confirmation → optional re-prompt. Returns the validated secret, or
 * an empty string if the operator pressed ENTER to skip.
 *
 * Never echoes the secret. Never logs the secret. Only masked output
 * reaches stdout.
 */
export const captureSecret = async (options: CaptureSecretOptions): Promise<string> => {
  const log = options.log ?? ((msg) => process.stdout.write(msg));
  const doPrompt = options.promptSecretFn ?? promptSecret;
  const maxAttempts = options.maxAttempts ?? 3;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const value = await doPrompt({
      question: `Enter your ${options.spec.envVar} (input hidden, press ENTER to skip): `,
    });

    const trimmed = value.trim();
    if (trimmed.length === 0) {
      log(`  (skipped — you can add ${options.spec.envVar} to .env later)\n`);
      return "";
    }

    const validationError = options.spec.validate(trimmed);
    if (validationError !== null) {
      log(`  That doesn't look like a ${options.spec.displayName} key — ${validationError}.\n`);
      log(
        `  Expected: ${options.spec.prefixHint}. Paste again, or press ENTER to skip and add it manually later.\n`,
      );
      continue;
    }

    log(`  Captured ${options.spec.envVar} ending in ${maskSecret(trimmed)}.\n`);
    const confirmation = await options.askYN(`  Looks right? (Y/n): `);
    const normalized = confirmation.trim().toLowerCase();
    if (normalized === "" || normalized === "y" || normalized === "yes") {
      return trimmed;
    }
    log(`  OK — let's try again.\n`);
  }

  log(`  Skipping ${options.spec.envVar} after ${String(maxAttempts)} attempts.\n`);
  return "";
};
