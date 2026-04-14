# @murmurations-ai/secrets-dotenv

Default [`SecretsProvider`](../core/src/secrets/index.ts) implementation for
the Murmuration Harness. Reads secrets from a `.env` file at the murmuration
root. Closes Phase 1B step B1 (Security Agent #25).

## Trust model

- `.env` **must** be at mode `0600` or stricter on POSIX. Looser permissions
  cause boot to fail.
- `.env` **must** be gitignored. The provider emits a one-time warning if
  the file is not listed in `.gitignore`.
- Secrets are loaded **exactly once at boot**. No hot reload. Rotation =
  restart.
- Keys present in `.env` but not declared by the caller are ignored entirely
  (not loaded into memory) — least-privilege.
- Interpolation (`${OTHER_VAR}`) is **disabled**.

See [`docs/adr/0010-secrets-provider-interface.md`](../../docs/adr/0010-secrets-provider-interface.md)
for the full design.

## Usage

```ts
import { Daemon, makeSecretKey } from "@murmurations-ai/core";
import { DotenvSecretsProvider } from "@murmurations-ai/secrets-dotenv";

const GITHUB_TOKEN = makeSecretKey("GITHUB_TOKEN");

const provider = new DotenvSecretsProvider({
  envPath: "/path/to/murmuration/.env",
});

const daemon = new Daemon({
  executor,
  agents: [...],
  secrets: {
    provider,
    declaration: {
      required: [GITHUB_TOKEN],
      optional: [],
    },
  },
});

const loaded = await daemon.loadSecrets();
if (!loaded) process.exit(78);
daemon.start();

// Later, inside an executor or plugin:
const token = provider.get(GITHUB_TOKEN).reveal();
```

## Error taxonomy

| Class                        | `code`                  | Meaning                                                           |
| ---------------------------- | ----------------------- | ----------------------------------------------------------------- |
| `EnvFileMissingError`        | `file-missing`          | `.env` not found at `envPath`                                     |
| `EnvFilePermissionsError`    | `permissions-too-loose` | Mode includes group/world bits                                    |
| `EnvFileParseError`          | `parse-failed`          | `dotenv.parse` threw                                              |
| `RequiredSecretMissingError` | `required-missing`      | Declared required key absent                                      |
| `UnknownSecretKeyError`      | `unknown-key`           | Called `get()` with undeclared key (from `@murmurations-ai/core`) |
