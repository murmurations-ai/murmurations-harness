/**
 * `murmuration directive` — CLI-verb tests.
 *
 * Covers the close / delete / edit manage subcommands that were
 * silently dropped in PR #104 and restored in PR #111. These tests
 * lock the dispatch shape so a future refactor can't lose them again.
 *
 * The tests exercise the full `runDirective` entry point against a
 * fresh tmp murmuration — no daemon, no network. Local collaboration
 * provider only.
 */

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runDirective } from "./directive.js";

let root = "";

const writeLocalItem = (id: string, state: "open" | "closed" = "open"): void => {
  writeFileSync(
    join(root, ".murmuration", "items", `${id}.json`),
    JSON.stringify(
      {
        id,
        title: `[DIRECTIVE] test ${id}`,
        state,
        labels: ["source-directive", "scope:all"],
        createdAt: "2026-04-19T00:00:00.000Z",
        updatedAt: "2026-04-19T00:00:00.000Z",
        comments: [],
        body: "test body",
      },
      null,
      2,
    ),
    "utf8",
  );
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), `directive-test-${randomUUID().slice(0, 8)}-`));
  mkdirSync(join(root, "murmuration"), { recursive: true });
  mkdirSync(join(root, ".murmuration", "items"), { recursive: true });
  // Minimal harness.yaml — local provider so no GitHub setup needed
  writeFileSync(
    join(root, "murmuration", "harness.yaml"),
    `collaboration:\n  provider: "local"\n`,
    "utf8",
  );
});

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("runDirective — manage subcommands (restoration of regression fixed by #111)", () => {
  it("close flips the item state to closed via the local provider", async () => {
    writeLocalItem("abc12345");
    await runDirective(["close", "abc12345"], root);

    const raw = JSON.parse(
      readFileSync(join(root, ".murmuration", "items", "abc12345.json"), "utf8"),
    ) as { state: string };
    expect(raw.state).toBe("closed");
  });

  it("close finds the subcommand even when --root/--name flags precede it", async () => {
    writeLocalItem("def67890");
    // args: --root <path> close <id>  — the verb is not at position 0
    await runDirective(["--root", root, "close", "def67890"], root);

    const raw = JSON.parse(
      readFileSync(join(root, ".murmuration", "items", "def67890.json"), "utf8"),
    ) as { state: string };
    expect(raw.state).toBe("closed");
  });

  it("delete removes the local item file", async () => {
    writeLocalItem("ff000001");
    const itemPath = join(root, ".murmuration", "items", "ff000001.json");
    expect(existsSync(itemPath)).toBe(true);

    await runDirective(["delete", "ff000001"], root);
    expect(existsSync(itemPath)).toBe(false);
  });

  it("close / delete / edit require an <id> argument", async () => {
    for (const verb of ["close", "delete", "edit"] as const) {
      await expect(runDirective([verb], root)).rejects.toThrow(/<id> is required/);
    }
  });

  it("delete refuses when the directive file does not exist", async () => {
    await expect(runDirective(["delete", "nonexistent"], root)).rejects.toThrow(/not found/);
  });

  it("create path still requires a scope (regression guard against the fix)", async () => {
    // A bare positional arg that is NOT a manage subcommand should still
    // fall through to the scope-required create path.
    await expect(runDirective(["hello"], root)).rejects.toThrow(/specify --agent|scope/);
  });

  it("edit opens $EDITOR on the local item file", async () => {
    writeLocalItem("aaaa1234");
    const originalEditor = process.env.EDITOR;
    process.env.EDITOR = "true"; // `true` is a POSIX command that exits 0; doesn't edit anything

    try {
      await runDirective(["edit", "aaaa1234"], root);
    } finally {
      if (originalEditor === undefined) delete process.env.EDITOR;
      else process.env.EDITOR = originalEditor;
    }
    // If we got here without throwing, the edit dispatcher ran `$EDITOR <path>` successfully.
    expect(true).toBe(true);
  });
});

describe("runDirective — existing create path stays intact", () => {
  it("creates an item when given --all + body", async () => {
    await runDirective(["--all", "propose a weekly wake cadence"], root);

    // Read back the created item — id is random so just find the first file
    const files = readdirSync(join(root, ".murmuration", "items"));
    const created = files.find((f) => f.endsWith(".json"));
    expect(created).toBeDefined();
    const item = JSON.parse(
      readFileSync(join(root, ".murmuration", "items", created ?? ""), "utf8"),
    ) as { title: string; labels: string[]; state: string };
    expect(item.title).toMatch(/propose a weekly wake cadence/);
    expect(item.labels).toContain("scope:all");
    expect(item.state).toBe("open");
  });
});

describe("runDirective — flag parsing and body sources", () => {
  it("rejects unrecognized flags rather than silently ignoring them", async () => {
    // Regression: previously `--body-file <path>` was accepted silently and
    // its value (the path) was treated as a positional. Real bodies were
    // dropped. Now unknown flags throw a helpful error.
    await expect(
      runDirective(
        ["--group", "engineering", "--body-file", "/tmp/x.md", "--tier", "consent"],
        root,
      ),
    ).rejects.toThrow(/unrecognized flag/);
  });

  it("does not treat a flag value as a positional body candidate", async () => {
    // Regression: `--group engineering "real body"` previously worked, but
    // `--group engineering --deadline 2026-05-07` produced a directive whose
    // body was "2026-05-07" because the flag-value-tracking was naive. After
    // the fix, --deadline is rejected as unknown rather than its value
    // becoming the body.
    await expect(runDirective(["--group", "x", "--deadline", "2026-05-07"], root)).rejects.toThrow(
      /unrecognized flag/,
    );
  });

  it("requires a body via positional or --body-file", async () => {
    await expect(runDirective(["--all"], root)).rejects.toThrow(/provide a message body/);
  });

  it("reads body from --body-file when provided", async () => {
    const bodyPath = join(root, "directive-body.md");
    writeFileSync(bodyPath, "## Investigate hypothesis 1\n\nLong multi-line body content.", "utf8");
    await runDirective(["--group", "engineering", "--body-file", bodyPath], root);

    const files = readdirSync(join(root, ".murmuration", "items"));
    const created = files.find((f) => f.endsWith(".json"));
    expect(created).toBeDefined();
    const item = JSON.parse(
      readFileSync(join(root, ".murmuration", "items", created ?? ""), "utf8"),
    ) as { title: string; body: string; labels: string[] };
    // Title is the first non-empty line (no embedded newlines).
    expect(item.title).toBe("[DIRECTIVE] ## Investigate hypothesis 1");
    // Body contains the full file content.
    expect(item.body).toContain("Long multi-line body content");
    expect(item.labels).toContain("scope:group:engineering");
  });

  it("--body-file fails loudly when the path does not exist", async () => {
    await expect(
      runDirective(["--all", "--body-file", join(root, "missing.md")], root),
    ).rejects.toThrow(/failed to read --body-file/);
  });

  it("--body-file requires a path argument", async () => {
    await expect(runDirective(["--all", "--body-file"], root)).rejects.toThrow(
      /--body-file requires a path/,
    );
  });

  it("title from a multi-line positional body uses the first non-empty line", async () => {
    await runDirective(["--all", "First line\n\nSecond paragraph here."], root);
    const files = readdirSync(join(root, ".murmuration", "items"));
    const created = files.find((f) => f.endsWith(".json"));
    const item = JSON.parse(
      readFileSync(join(root, ".murmuration", "items", created ?? ""), "utf8"),
    ) as { title: string; body: string };
    expect(item.title).toBe("[DIRECTIVE] First line");
    expect(item.body).toContain("Second paragraph here");
  });
});

// Silence the console output the create path emits.
const noop = (): void => {
  /* swallow log output during tests */
};
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(noop);
});
afterEach(() => {
  vi.restoreAllMocks();
});
