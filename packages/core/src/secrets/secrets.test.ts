import { describe, expect, it } from "vitest";

import {
  makeSecretKey,
  makeSecretValue,
  REDACT,
  scrubLogRecord,
  SENSITIVE_FIELD_NAME_RE,
} from "./index.js";

describe("makeSecretKey", () => {
  it("accepts conventional environment-variable-style names", () => {
    expect(makeSecretKey("GITHUB_TOKEN").value).toBe("GITHUB_TOKEN");
    expect(makeSecretKey("ANTHROPIC_API_KEY").value).toBe("ANTHROPIC_API_KEY");
    expect(makeSecretKey("A").value).toBe("A");
  });

  it("rejects lowercase, spaces, leading digits", () => {
    expect(() => makeSecretKey("lowercase")).toThrow(/invalid secret key/);
    expect(() => makeSecretKey("HAS SPACE")).toThrow(/invalid secret key/);
    expect(() => makeSecretKey("1_LEADING_DIGIT")).toThrow(/invalid secret key/);
    expect(() => makeSecretKey("")).toThrow(/invalid secret key/);
  });
});

describe("makeSecretValue", () => {
  it("reveals the raw value via reveal()", () => {
    const secret = makeSecretValue("supersecret");
    expect(secret.reveal()).toBe("supersecret");
    expect(secret.length).toBe(11);
  });

  it("redacts via toJSON so JSON.stringify never leaks the value", () => {
    const secret = makeSecretValue("supersecret");
    expect(JSON.stringify(secret)).toBe('"[REDACTED:length=11]"');
    expect(JSON.stringify({ wrapped: secret })).toBe('{"wrapped":"[REDACTED:length=11]"}');
  });

  it("redacts via toString so template literals never leak the value", () => {
    const secret = makeSecretValue("supersecret");
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- deliberate: verifying toString()
    expect(`${secret}`).toBe("[REDACTED:length=11]");
  });

  it("does not expose the raw value via enumerable properties", () => {
    const secret = makeSecretValue("supersecret");
    const keys = Object.keys(secret);
    // `kind`, `length`, `reveal`, `toJSON`, `toString` are fine; no `value`.
    expect(keys).not.toContain("value");
    expect(keys).not.toContain("_value");
    // The raw string must not be visible anywhere structurally.
    for (const key of keys) {
      const v = (secret as unknown as Record<string, unknown>)[key];
      if (typeof v === "string") {
        expect(v).not.toBe("supersecret");
      }
    }
  });
});

describe("scrubLogRecord", () => {
  it("passes through innocuous fields untouched", () => {
    const out = scrubLogRecord({
      wakeId: "abc",
      agentId: "07-wren",
      durationMs: 123,
      apiCalls: 0,
    });
    expect(out).toEqual({
      wakeId: "abc",
      agentId: "07-wren",
      durationMs: 123,
      apiCalls: 0,
    });
  });

  it("scrubs long string values whose field name matches sensitive pattern", () => {
    const out = scrubLogRecord({
      apiKey: "supersecretvalue12345",
      password: "hunter2hunter2",
      credential: "abcdef1234",
      authToken: "tok_abcdefghij",
    });
    expect(out.apiKey).toBe("[REDACTED:scrubbed-by-name]");
    expect(out.password).toBe("[REDACTED:scrubbed-by-name]");
    expect(out.credential).toBe("[REDACTED:scrubbed-by-name]");
    expect(out.authToken).toBe("[REDACTED:scrubbed-by-name]");
  });

  it("leaves short sensitive-named values alone (below threshold)", () => {
    const out = scrubLogRecord({ token: "abc" });
    // Length 3 < SCRUB_MIN_LENGTH (8): keep as-is.
    expect(out.token).toBe("abc");
  });

  it("leaves compound numeric field names like `inputTokens` alone", () => {
    // The sensitive-field regex matches `token` inside `inputTokens` by name,
    // BUT the value is a number so the string-only scrubber skips it.
    const out = scrubLogRecord({ inputTokens: 1200, outputTokens: 340 });
    expect(out.inputTokens).toBe(1200);
    expect(out.outputTokens).toBe(340);
  });

  it("drops the REDACT symbol bucket entirely", () => {
    const input: Record<string, unknown> = {
      visible: "ok",
      [REDACT]: { hiddenField: "shouldNeverAppear" },
    };
    const out = scrubLogRecord(input);
    expect(out.visible).toBe("ok");
    // Symbol-keyed entries are not enumerable via Object.entries so they
    // are effectively dropped by the scrubber's shallow copy.
    expect(Object.getOwnPropertySymbols(out)).toHaveLength(0);
    // And the JSON round-trip must not contain the hidden string anywhere.
    expect(JSON.stringify(out)).not.toContain("shouldNeverAppear");
  });

  it("scrubs sensitive fields in nested objects", () => {
    const out = scrubLogRecord({
      agentId: "01-research",
      payload: {
        apiKey: "supersecretvalue12345",
        nested: { password: "hunter2hunter2" },
        safe: "visible",
      },
    });
    const payload = out.payload as Record<string, unknown>;
    expect(payload.apiKey).toBe("[REDACTED:scrubbed-by-name]");
    expect(payload.safe).toBe("visible");
    const nested = payload.nested as Record<string, unknown>;
    expect(nested.password).toBe("[REDACTED:scrubbed-by-name]");
  });

  it("SecretValue objects passed as fields already serialize to redacted form", () => {
    const secret = makeSecretValue("rawbytes-12345");
    const out = scrubLogRecord({ token: secret });
    expect(JSON.stringify(out.token)).toBe('"[REDACTED:length=14]"');
  });

  it("scrubs value-pattern secrets regardless of key name (H1)", () => {
    // Each bucket is a real incident class: keys echoed in error messages,
    // stderr tails, or agent-authored strings. Every one must be caught
    // even when the enclosing key is benign (error, message, output, stderr).
    const inputs = [
      { key: "error", value: "401: AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8", pat: "gemini" },
      {
        key: "message",
        value: "invalid api key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
        pat: "anthropic",
      },
      {
        key: "stderr",
        value: "git failed with token ghp_abcdefghijklmnopqrstuvwxyz0123456",
        pat: "github-pat",
      },
      {
        key: "output",
        value: "OpenAI: sk-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF",
        pat: "openai",
      },
      {
        key: "body",
        value: "github_pat_11ABCDEFG0abcdefghijkl_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ",
        pat: "github-fg-pat",
      },
    ];
    for (const { key, value, pat } of inputs) {
      const out = scrubLogRecord({ [key]: value });
      expect(out[key]).toContain(`[REDACTED:${pat}]`);
      expect(out[key]).not.toContain(value);
    }
  });

  it("scrubs value-pattern secrets inside nested objects and arrays", () => {
    const out = scrubLogRecord({
      stderrChunks: [
        "first line ok",
        "found AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8 in response",
      ],
      nested: {
        detail: { cause: "ghp_abcdefghijklmnopqrstuvwxyz0123456" },
      },
    });
    const chunks = out.stderrChunks as string[];
    expect(chunks[0]).toBe("first line ok");
    expect(chunks[1]).toContain("[REDACTED:gemini]");
    const nested = out.nested as { detail: { cause: string } };
    expect(nested.detail.cause).toContain("[REDACTED:github-pat]");
  });

  it("passes through strings that happen to look key-ish but do not match any pattern", () => {
    const out = scrubLogRecord({
      message: "wake completed in 1234ms across 5 agents",
    });
    expect(out.message).toBe("wake completed in 1234ms across 5 agents");
  });
});

describe("SENSITIVE_FIELD_NAME_RE", () => {
  it("matches the intended vocabulary", () => {
    for (const name of [
      "token",
      "TOKEN",
      "apiKey",
      "api_key",
      "secret",
      "password",
      "credential",
      "authToken",
      "private_key",
      "privateKey",
    ]) {
      expect(SENSITIVE_FIELD_NAME_RE.test(name)).toBe(true);
    }
  });

  it("does not match innocuous field names", () => {
    for (const name of [
      "wakeId",
      "agentId",
      "durationMs",
      "apiCalls",
      "wallClockMs",
      "restCalls",
    ]) {
      expect(SENSITIVE_FIELD_NAME_RE.test(name)).toBe(false);
    }
  });
});
