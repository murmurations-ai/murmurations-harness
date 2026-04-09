import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeSecretKey, UnknownSecretKeyError } from "@murmuration/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DotenvSecretsProvider,
  EnvFileMissingError,
  EnvFilePermissionsError,
  RequiredSecretMissingError,
} from "./index.js";

const GITHUB_TOKEN = makeSecretKey("GITHUB_TOKEN");
const SLACK_WEBHOOK = makeSecretKey("SLACK_WEBHOOK");
const ANTHROPIC_API_KEY = makeSecretKey("ANTHROPIC_API_KEY");

const IS_POSIX = process.platform !== "win32";

describe("DotenvSecretsProvider", () => {
  let dir = "";
  let envPath = "";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "murmuration-dotenv-"));
    envPath = join(dir, ".env");
  });

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const write = async (content: string, mode = 0o600): Promise<void> => {
    await writeFile(envPath, content, "utf8");
    await chmod(envPath, mode);
  };

  it("happy path — loads a required secret at mode 0600", async () => {
    await write("GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n");
    const provider = new DotenvSecretsProvider({ envPath });
    const result = await provider.load({
      required: [GITHUB_TOKEN],
      optional: [],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.loadedCount).toBe(1);
      expect(result.missingOptional).toEqual([]);
    }
    const secret = provider.get(GITHUB_TOKEN);
    expect(secret.reveal()).toBe("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(secret.length).toBe(40);
    expect(provider.has(GITHUB_TOKEN)).toBe(true);
    expect(provider.loadedKeys().map((k) => k.value)).toEqual(["GITHUB_TOKEN"]);
  });

  it("returns EnvFileMissingError when .env is absent", async () => {
    const provider = new DotenvSecretsProvider({ envPath });
    const result = await provider.load({ required: [], optional: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(EnvFileMissingError);
      expect(result.error.code).toBe("file-missing");
    }
  });

  it.skipIf(!IS_POSIX)(
    "returns EnvFilePermissionsError on world-readable .env (0644)",
    async () => {
      await write("GITHUB_TOKEN=tok\n", 0o644);
      const provider = new DotenvSecretsProvider({ envPath });
      const result = await provider.load({
        required: [GITHUB_TOKEN],
        optional: [],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(EnvFilePermissionsError);
        expect(result.error.code).toBe("permissions-too-loose");
      }
    },
  );

  it.skipIf(!IS_POSIX)(
    "returns EnvFilePermissionsError on group-readable .env (0640)",
    async () => {
      await write("GITHUB_TOKEN=tok\n", 0o640);
      const provider = new DotenvSecretsProvider({ envPath });
      const result = await provider.load({
        required: [GITHUB_TOKEN],
        optional: [],
      });
      expect(result.ok).toBe(false);
    },
  );

  it.skipIf(!IS_POSIX)("accepts stricter-than-required modes (0400)", async () => {
    await write("GITHUB_TOKEN=tok12345\n", 0o400);
    const provider = new DotenvSecretsProvider({ envPath });
    const result = await provider.load({
      required: [GITHUB_TOKEN],
      optional: [],
    });
    expect(result.ok).toBe(true);
  });

  it("skipPermissionCheck bypasses the permission gate", async () => {
    await write("GITHUB_TOKEN=tok12345\n", 0o644);
    const provider = new DotenvSecretsProvider({
      envPath,
      skipPermissionCheck: true,
    });
    const result = await provider.load({
      required: [GITHUB_TOKEN],
      optional: [],
    });
    expect(result.ok).toBe(true);
  });

  it("returns RequiredSecretMissingError when a required key is absent", async () => {
    await write("OTHER=value\n");
    const provider = new DotenvSecretsProvider({ envPath });
    const result = await provider.load({
      required: [GITHUB_TOKEN],
      optional: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(RequiredSecretMissingError);
      expect(result.error.code).toBe("required-missing");
    }
  });

  it("missing optional secrets surface in missingOptional", async () => {
    await write("GITHUB_TOKEN=tok12345\n");
    const provider = new DotenvSecretsProvider({ envPath });
    const result = await provider.load({
      required: [GITHUB_TOKEN],
      optional: [SLACK_WEBHOOK, ANTHROPIC_API_KEY],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.missingOptional.map((k) => k.value).sort()).toEqual([
        "ANTHROPIC_API_KEY",
        "SLACK_WEBHOOK",
      ]);
    }
  });

  it("undeclared keys in .env are ignored (least-privilege)", async () => {
    await write("GITHUB_TOKEN=tok12345\nRANDOM_KEY=foo\n");
    const provider = new DotenvSecretsProvider({ envPath });
    await provider.load({ required: [GITHUB_TOKEN], optional: [] });
    expect(provider.loadedKeys().map((k) => k.value)).toEqual(["GITHUB_TOKEN"]);
    expect(() => provider.get(makeSecretKey("RANDOM_KEY"))).toThrow(UnknownSecretKeyError);
  });

  it("get() before load() throws", () => {
    const provider = new DotenvSecretsProvider({ envPath });
    expect(() => provider.get(GITHUB_TOKEN)).toThrow(/called before load/);
  });

  it("SecretValue.toJSON round-trips via JSON.stringify safely", async () => {
    await write("GITHUB_TOKEN=ghp_0123456789abcdef0123456789abcdef01234567\n");
    const provider = new DotenvSecretsProvider({ envPath });
    await provider.load({ required: [GITHUB_TOKEN], optional: [] });
    const secret = provider.get(GITHUB_TOKEN);
    expect(JSON.stringify(secret)).toBe('"[REDACTED:length=44]"');
  });

  it("capabilities reports dotenv / no-hot-reload", () => {
    const provider = new DotenvSecretsProvider({ envPath });
    const caps = provider.capabilities();
    expect(caps.id).toBe("dotenv");
    expect(caps.supportsHotReload).toBe(false);
    expect(caps.stateful).toBe(false);
  });
});
