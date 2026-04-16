/**
 * CollaborationProvider tests — interface contract + LocalCollaborationProvider.
 *
 * Tests the Local provider end-to-end against the CollaborationProvider
 * interface contract. These tests also serve as the generic contract
 * that any provider implementation must satisfy.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { LocalCollaborationProvider } from "./local-provider.js";
import { CollaborationError } from "./types.js";
import type { CollaborationProvider, ItemRef } from "./types.js";

// ---------------------------------------------------------------------------
// Setup — fresh temp directory per test
// ---------------------------------------------------------------------------

let rootDir: string;
let provider: CollaborationProvider;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "collab-test-"));
  provider = new LocalCollaborationProvider({
    itemsDir: join(rootDir, "items"),
    artifactsDir: join(rootDir, "artifacts"),
  });
});

afterEach(async () => {
  if (rootDir) await rm(rootDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Interface contract tests (any provider must pass these)
// ---------------------------------------------------------------------------

describe("CollaborationProvider contract (Local)", () => {
  it("has an id and displayName", () => {
    expect(provider.id).toBeTruthy();
    expect(provider.displayName).toBeTruthy();
  });

  it("createItem returns an ItemRef with id", async () => {
    const result = await provider.createItem({
      title: "Test item",
      body: "Test body",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBeTruthy();
    }
  });

  it("createItem with labels", async () => {
    const result = await provider.createItem({
      title: "Labelled item",
      body: "Has labels",
      labels: ["priority:high", "action-item"],
    });
    expect(result.ok).toBe(true);
  });

  it("listItems returns created items", async () => {
    await provider.createItem({ title: "Item A", body: "Body A" });
    await provider.createItem({ title: "Item B", body: "Body B" });

    const result = await provider.listItems();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(2);
      expect(result.value.map((i) => i.title)).toContain("Item A");
      expect(result.value.map((i) => i.title)).toContain("Item B");
    }
  });

  it("listItems filters by state", async () => {
    const created = await provider.createItem({ title: "Open", body: "" });
    expect(created.ok).toBe(true);
    if (created.ok) {
      await provider.updateItemState(created.value, "closed");
    }
    await provider.createItem({ title: "Still open", body: "" });

    const openOnly = await provider.listItems({ state: "open" });
    expect(openOnly.ok).toBe(true);
    if (openOnly.ok) {
      expect(openOnly.value.length).toBe(1);
      expect(openOnly.value[0]!.title).toBe("Still open");
    }
  });

  it("listItems filters by labels", async () => {
    await provider.createItem({ title: "Tagged", body: "", labels: ["bug"] });
    await provider.createItem({ title: "Not tagged", body: "" });

    const result = await provider.listItems({ labels: ["bug"] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(1);
      expect(result.value[0]!.title).toBe("Tagged");
    }
  });

  it("listItems respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      await provider.createItem({ title: `Item ${String(i)}`, body: "" });
    }
    const result = await provider.listItems({ limit: 3 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(3);
    }
  });

  it("postComment on existing item", async () => {
    const created = await provider.createItem({ title: "Commentable", body: "" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const comment = await provider.postComment(created.value, "A comment");
    expect(comment.ok).toBe(true);
    if (comment.ok) {
      expect(comment.value.id).toBeTruthy();
    }
  });

  it("postComment on nonexistent item returns NOT_FOUND", async () => {
    const result = await provider.postComment({ id: "nonexistent" }, "Nope");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(CollaborationError);
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  it("updateItemState changes state", async () => {
    const created = await provider.createItem({ title: "Closeable", body: "" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await provider.updateItemState(created.value, "closed");

    const items = await provider.listItems({ state: "closed" });
    expect(items.ok).toBe(true);
    if (items.ok) {
      expect(items.value.length).toBe(1);
      expect(items.value[0]!.state).toBe("closed");
    }
  });

  it("addLabels adds labels to item", async () => {
    const created = await provider.createItem({ title: "Label me", body: "" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await provider.addLabels(created.value, ["new-label"]);

    const items = await provider.listItems({ labels: ["new-label"] });
    expect(items.ok).toBe(true);
    if (items.ok) {
      expect(items.value.length).toBe(1);
    }
  });

  it("addLabels is idempotent", async () => {
    const created = await provider.createItem({
      title: "Dupe labels",
      body: "",
      labels: ["existing"],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await provider.addLabels(created.value, ["existing", "new"]);

    const items = await provider.listItems();
    expect(items.ok).toBe(true);
    if (items.ok) {
      const item = items.value.find((i) => i.ref.id === created.value.id);
      expect(item?.labels).toContain("existing");
      expect(item?.labels).toContain("new");
      // "existing" should appear only once
      expect(item?.labels.filter((l) => l === "existing").length).toBe(1);
    }
  });

  it("removeLabel removes a label", async () => {
    const created = await provider.createItem({
      title: "Unlabel me",
      body: "",
      labels: ["remove-me", "keep"],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await provider.removeLabel(created.value, "remove-me");

    const items = await provider.listItems();
    expect(items.ok).toBe(true);
    if (items.ok) {
      const item = items.value.find((i) => i.ref.id === created.value.id);
      expect(item?.labels).not.toContain("remove-me");
      expect(item?.labels).toContain("keep");
    }
  });

  it("commitArtifact writes a file and returns ref", async () => {
    const result = await provider.commitArtifact({
      path: "notes/test.md",
      content: "# Test\n\nHello world.\n",
      message: "test: commit a note",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.path).toBe("notes/test.md");
      expect(result.value.id).toBeTruthy();
    }
  });

  it("collectSignals returns signals from items", async () => {
    await provider.createItem({ title: "Signal item", body: "Signal body", labels: ["important"] });

    const signals = await provider.collectSignals();
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals[0]!.kind).toBeTruthy();
    expect(signals[0]!.id).toBeTruthy();
    expect(signals[0]!.trust).toBeTruthy();
  });

  it("collectSignals returns empty for no items", async () => {
    const signals = await provider.collectSignals();
    expect(signals).toEqual([]);
  });

  it("operations on nonexistent items return NOT_FOUND", async () => {
    const badRef: ItemRef = { id: "does-not-exist" };

    const stateResult = await provider.updateItemState(badRef, "closed");
    expect(stateResult.ok).toBe(false);
    if (!stateResult.ok) expect(stateResult.error.code).toBe("NOT_FOUND");

    const labelResult = await provider.addLabels(badRef, ["x"]);
    expect(labelResult.ok).toBe(false);
    if (!labelResult.ok) expect(labelResult.error.code).toBe("NOT_FOUND");

    const removeResult = await provider.removeLabel(badRef, "x");
    expect(removeResult.ok).toBe(false);
    if (!removeResult.ok) expect(removeResult.error.code).toBe("NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// LocalCollaborationProvider specifics
// ---------------------------------------------------------------------------

describe("LocalCollaborationProvider", () => {
  it("id is 'local'", () => {
    expect(provider.id).toBe("local");
  });

  it("works with empty items directory", async () => {
    const result = await provider.listItems();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  it("items persist across list calls", async () => {
    await provider.createItem({ title: "Persistent", body: "Yes" });

    const first = await provider.listItems();
    const second = await provider.listItems();

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.value.length).toBe(second.value.length);
    }
  });
});

// ---------------------------------------------------------------------------
// CollaborationError
// ---------------------------------------------------------------------------

describe("CollaborationError", () => {
  it("has code, provider, and message", () => {
    const err = new CollaborationError("test", "NOT_FOUND", "Item not found");
    expect(err.code).toBe("NOT_FOUND");
    expect(err.provider).toBe("test");
    expect(err.message).toBe("Item not found");
    expect(err).toBeInstanceOf(Error);
  });

  it("supports cause", () => {
    const cause = new Error("underlying");
    const err = new CollaborationError("test", "UNKNOWN", "Wrapped", { cause });
    expect(err.cause).toBe(cause);
  });
});
