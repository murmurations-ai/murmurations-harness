import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AccountabilityObservationStore } from "./observations.js";
import type { AccountabilityObservation } from "./effectiveness.js";

let dir = "";
let storePath = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "obs-store-"));
  storePath = join(dir, "accountability-observations.jsonl");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const obs = (overrides: Partial<AccountabilityObservation> = {}): AccountabilityObservation => ({
  accountabilityId: "weekly-digest",
  agentId: "test-agent",
  observedAt: new Date("2026-05-04T12:00:00Z"),
  met: true,
  ...overrides,
});

describe("AccountabilityObservationStore.append", () => {
  it("appends one observation as one JSONL line", async () => {
    const store = new AccountabilityObservationStore({ path: storePath });
    await store.append(obs());
    const content = await readFile(storePath, "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(parsed.accountabilityId).toBe("weekly-digest");
    expect(parsed.met).toBe(true);
  });

  it("multiple appends accumulate", async () => {
    const store = new AccountabilityObservationStore({ path: storePath });
    await store.append(obs({ accountabilityId: "a" }));
    await store.append(obs({ accountabilityId: "b" }));
    await store.append(obs({ accountabilityId: "c" }));
    const all = await store.readAll();
    expect(all.map((o) => o.accountabilityId)).toEqual(["a", "b", "c"]);
  });

  it("creates the parent directory when missing", async () => {
    const nested = join(dir, "nested", "deep", "obs.jsonl");
    const store = new AccountabilityObservationStore({ path: nested });
    await store.append(obs());
    const all = await store.readAll();
    expect(all).toHaveLength(1);
  });
});

describe("AccountabilityObservationStore.appendAll", () => {
  it("appends a batch in one shot", async () => {
    const store = new AccountabilityObservationStore({ path: storePath });
    await store.appendAll([
      obs({ accountabilityId: "a" }),
      obs({ accountabilityId: "b", met: false }),
      obs({ accountabilityId: "c" }),
    ]);
    const all = await store.readAll();
    expect(all).toHaveLength(3);
    expect(all[1]?.met).toBe(false);
  });

  it("is a no-op for empty batch", async () => {
    const store = new AccountabilityObservationStore({ path: storePath });
    await store.appendAll([]);
    const all = await store.readAll();
    expect(all).toHaveLength(0);
  });
});

describe("AccountabilityObservationStore.readAll", () => {
  it("returns empty array when file does not exist", async () => {
    const store = new AccountabilityObservationStore({ path: storePath });
    expect(await store.readAll()).toEqual([]);
  });

  it("round-trips Date through ISO string", async () => {
    const store = new AccountabilityObservationStore({ path: storePath });
    const at = new Date("2026-05-04T18:30:00Z");
    await store.append(obs({ observedAt: at }));
    const all = await store.readAll();
    expect(all[0]?.observedAt.toISOString()).toBe(at.toISOString());
  });

  it("skips malformed lines", async () => {
    await writeFile(
      storePath,
      [
        JSON.stringify({
          accountabilityId: "good",
          agentId: "a",
          observedAt: "2026-05-04T00:00:00Z",
          met: true,
        }),
        "garbage line not json",
        JSON.stringify({ accountabilityId: "good2", agentId: "a", met: false }), // missing observedAt
        "",
        JSON.stringify({
          accountabilityId: "good3",
          agentId: "a",
          observedAt: "2026-05-05T00:00:00Z",
          met: false,
        }),
      ].join("\n"),
    );
    const store = new AccountabilityObservationStore({ path: storePath });
    const all = await store.readAll();
    expect(all.map((o) => o.accountabilityId)).toEqual(["good", "good3"]);
  });

  it("rejects observation entries with non-Date observedAt strings", async () => {
    await writeFile(
      storePath,
      JSON.stringify({
        accountabilityId: "bad",
        agentId: "a",
        observedAt: "not-a-date",
        met: true,
      }) + "\n",
    );
    const store = new AccountabilityObservationStore({ path: storePath });
    expect(await store.readAll()).toEqual([]);
  });
});

describe("AccountabilityObservationStore.readWindow", () => {
  it("filters by [since, until] inclusive", async () => {
    const store = new AccountabilityObservationStore({ path: storePath });
    await store.appendAll([
      obs({ accountabilityId: "old", observedAt: new Date("2026-04-01T00:00:00Z") }),
      obs({ accountabilityId: "in", observedAt: new Date("2026-05-04T00:00:00Z") }),
      obs({ accountabilityId: "future", observedAt: new Date("2026-06-01T00:00:00Z") }),
    ]);
    const window = await store.readWindow({
      since: new Date("2026-05-01T00:00:00Z"),
      until: new Date("2026-05-31T00:00:00Z"),
    });
    expect(window.map((o) => o.accountabilityId)).toEqual(["in"]);
  });
});

describe("AccountabilityObservationStore.prune", () => {
  it("drops observations older than the cutoff", async () => {
    const store = new AccountabilityObservationStore({ path: storePath });
    await store.appendAll([
      obs({ accountabilityId: "old", observedAt: new Date("2026-01-01T00:00:00Z") }),
      obs({ accountabilityId: "old2", observedAt: new Date("2026-02-01T00:00:00Z") }),
      obs({ accountabilityId: "keep", observedAt: new Date("2026-05-01T00:00:00Z") }),
    ]);
    const result = await store.prune(new Date("2026-04-01T00:00:00Z"));
    expect(result.droppedCount).toBe(2);
    const remaining = await store.readAll();
    expect(remaining.map((o) => o.accountabilityId)).toEqual(["keep"]);
  });

  it("is a no-op when nothing to drop", async () => {
    const store = new AccountabilityObservationStore({ path: storePath });
    await store.append(obs({ observedAt: new Date("2026-05-01T00:00:00Z") }));
    const result = await store.prune(new Date("2026-01-01T00:00:00Z"));
    expect(result.droppedCount).toBe(0);
  });

  it("handles complete clearout (every entry beyond cutoff)", async () => {
    const store = new AccountabilityObservationStore({ path: storePath });
    await store.appendAll([
      obs({ accountabilityId: "a", observedAt: new Date("2026-01-01T00:00:00Z") }),
      obs({ accountabilityId: "b", observedAt: new Date("2026-02-01T00:00:00Z") }),
    ]);
    const result = await store.prune(new Date("2026-12-01T00:00:00Z"));
    expect(result.droppedCount).toBe(2);
    expect(await store.readAll()).toEqual([]);
  });
});
