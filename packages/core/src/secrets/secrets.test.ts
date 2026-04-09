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

  it("SecretValue objects passed as fields already serialize to redacted form", () => {
    const secret = makeSecretValue("rawbytes-12345");
    const out = scrubLogRecord({ token: secret });
    expect(JSON.stringify(out.token)).toBe('"[REDACTED:length=14]"');
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
