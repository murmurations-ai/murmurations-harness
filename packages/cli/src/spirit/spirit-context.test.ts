/**
 * Spirit cross-attach conversation context — Workstream N.
 *
 * Verifies the on-disk surface that backs Spirit's persistence:
 * `<root>/.murmuration/spirit/conversation.jsonl` +
 * `<root>/.murmuration/spirit/session.json`.
 *
 * The full `initSpiritSession` flow drags in LLM clients + harness
 * config + secrets resolution. These tests exercise the storage
 * boundary directly (ConversationStore at the Spirit dir) — the LLM
 * wiring lives in the smoke test guarded by RUN_SUBSCRIPTION_CLI_SMOKE.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConversationStore } from "@murmurations-ai/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const spiritDirOf = (root: string): string => join(root, ".murmuration", "spirit");

describe("Spirit cross-attach context (Workstream N)", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "spirit-ctx-"));
  });

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("first attach has no prior context", async () => {
    const store = new ConversationStore(spiritDirOf(root));
    const resumed = await store.load();
    expect(resumed).toBe(false);
    expect(store.isEmpty).toBe(true);
    expect(store.sessionId).toBeUndefined();
  });

  it("conversation persists across simulated detach + re-attach", async () => {
    const dir = spiritDirOf(root);

    // First attach: write a couple of turns.
    const a1 = new ConversationStore(dir);
    await a1.append({ role: "user", content: "what's the wake schedule?", ts: "t1" });
    await a1.append({ role: "assistant", content: "Daily at 07:00 UTC.", ts: "t2" });

    // Detach (Ctrl-C / terminal close): no flush needed; appends are
    // immediately durable.

    // Re-attach: a fresh store at the same dir hydrates.
    const a2 = new ConversationStore(dir);
    const resumed = await a2.load();
    expect(resumed).toBe(true);
    expect(a2.messages).toHaveLength(2);
    expect(a2.messages[0]?.content).toBe("what's the wake schedule?");
    expect(a2.messages[1]?.content).toBe("Daily at 07:00 UTC.");
  });

  it("session.json sessionId survives detach + re-attach", async () => {
    const dir = spiritDirOf(root);
    const a1 = new ConversationStore(dir);
    await a1.setSessionId("subscription-cli-session-abc");

    const a2 = new ConversationStore(dir);
    await a2.load();
    expect(a2.sessionId).toBe("subscription-cli-session-abc");
  });

  it(":reset clears both files; next attach is fresh", async () => {
    const dir = spiritDirOf(root);
    const a1 = new ConversationStore(dir);
    await a1.append({ role: "user", content: "hi", ts: "t1" });
    await a1.setSessionId("sess-x");
    await a1.reset();

    const a2 = new ConversationStore(dir);
    expect(await a2.load()).toBe(false);
    expect(a2.isEmpty).toBe(true);
    expect(a2.sessionId).toBeUndefined();
  });

  it("popLast rolls back an orphan user message after an LLM failure", async () => {
    // Reproduces the Spirit error path: user message persisted, LLM
    // call fails, we must drop the orphan so re-attach doesn't see it.
    const dir = spiritDirOf(root);
    const turn1 = new ConversationStore(dir);
    await turn1.append({ role: "user", content: "first", ts: "t1" });
    await turn1.append({ role: "assistant", content: "ok", ts: "t2" });

    // Mid-turn failure: user persisted, no assistant follows.
    await turn1.append({ role: "user", content: "doomed", ts: "t3" });
    const popped = await turn1.popLast();
    expect(popped?.content).toBe("doomed");

    const next = new ConversationStore(dir);
    await next.load();
    expect(next.messages).toHaveLength(2);
    expect(next.messages[next.messages.length - 1]?.role).toBe("assistant");
  });

  it("creates the .murmuration/spirit/ directory on first append", async () => {
    const dir = spiritDirOf(root);
    const store = new ConversationStore(dir);
    await store.append({ role: "user", content: "hello", ts: "t1" });
    // Directory should exist now (the store mkdirs lazily).
    const a2 = new ConversationStore(dir);
    expect(await a2.load()).toBe(true);
  });
});
