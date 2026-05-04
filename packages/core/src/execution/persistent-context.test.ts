import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ConversationStore, parsePersistentConfig } from "./persistent-context.js";

describe("ConversationStore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `murm-conv-test-${randomUUID().slice(0, 8)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  it("starts empty", () => {
    const store = new ConversationStore(tmpDir);
    expect(store.isEmpty).toBe(true);
    expect(store.messages).toHaveLength(0);
    expect(store.totalTokens).toBe(0);
  });

  it("load returns false when no file exists", async () => {
    const store = new ConversationStore(tmpDir);
    expect(await store.load()).toBe(false);
  });

  it("append persists messages to JSONL", async () => {
    const store = new ConversationStore(tmpDir);
    await store.append({
      role: "system",
      content: "You are a researcher.",
      ts: "2026-04-14T00:00:00Z",
      tokenCount: 10,
    });
    await store.append({
      role: "user",
      content: "What signals do you see?",
      ts: "2026-04-14T09:00:00Z",
      wakeId: "w1",
      tokenCount: 20,
    });

    expect(store.messages).toHaveLength(2);
    expect(store.totalTokens).toBe(30);

    // Verify file on disk
    const content = readFileSync(join(tmpDir, "conversation.jsonl"), "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("load restores messages from disk", async () => {
    const store1 = new ConversationStore(tmpDir);
    await store1.append({ role: "system", content: "soul", ts: "t1", tokenCount: 5 });
    await store1.append({
      role: "user",
      content: "signals",
      ts: "t2",
      wakeId: "w1",
      tokenCount: 15,
    });
    await store1.append({
      role: "assistant",
      content: "analysis",
      ts: "t3",
      wakeId: "w1",
      tokenCount: 25,
    });

    // Load in a new store instance
    const store2 = new ConversationStore(tmpDir);
    expect(await store2.load()).toBe(true);
    expect(store2.messages).toHaveLength(3);
    expect(store2.totalTokens).toBe(45);
    expect(store2.messages[2]?.content).toBe("analysis");
  });

  it("toLLMMessages excludes compaction markers", async () => {
    const store = new ConversationStore(tmpDir);
    await store.append({ role: "system", content: "soul", ts: "t1" });
    await store.append({ role: "compaction", content: "summary of old turns", ts: "t2" });
    await store.append({ role: "user", content: "new signals", ts: "t3" });
    await store.append({ role: "assistant", content: "response", ts: "t4" });

    const messages = store.toLLMMessages();
    expect(messages).toHaveLength(3); // system + user + assistant (compaction excluded)
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
  });

  it("compact replaces older messages with summary", async () => {
    const store = new ConversationStore(tmpDir);
    await store.append({ role: "system", content: "soul", ts: "t0", tokenCount: 10 });
    await store.append({
      role: "user",
      content: "wake 1 signals",
      ts: "t1",
      wakeId: "w1",
      tokenCount: 100,
    });
    await store.append({
      role: "assistant",
      content: "wake 1 response",
      ts: "t2",
      wakeId: "w1",
      tokenCount: 200,
    });
    await store.append({
      role: "user",
      content: "wake 2 signals",
      ts: "t3",
      wakeId: "w2",
      tokenCount: 100,
    });
    await store.append({
      role: "assistant",
      content: "wake 2 response",
      ts: "t4",
      wakeId: "w2",
      tokenCount: 200,
    });
    await store.append({
      role: "user",
      content: "wake 3 signals",
      ts: "t5",
      wakeId: "w3",
      tokenCount: 100,
    });
    await store.append({
      role: "assistant",
      content: "wake 3 response",
      ts: "t6",
      wakeId: "w3",
      tokenCount: 200,
    });

    expect(store.messages).toHaveLength(7);

    await store.compact("Summary of wakes 1-2: found 5 signals, filed 2 issues.", 2);

    // Should keep: system + compaction + last 2 messages
    expect(store.messages).toHaveLength(4);
    expect(store.messages[0]?.role).toBe("system");
    expect(store.messages[1]?.role).toBe("compaction");
    expect(store.messages[2]?.content).toBe("wake 3 signals");
    expect(store.messages[3]?.content).toBe("wake 3 response");

    // Token count should be recalculated
    expect(store.totalTokens).toBeLessThan(910); // less than original
  });

  it("compact is a no-op when fewer messages than keepLastN", async () => {
    const store = new ConversationStore(tmpDir);
    await store.append({ role: "system", content: "soul", ts: "t0" });
    await store.append({ role: "user", content: "signals", ts: "t1" });

    await store.compact("should not apply", 10);

    expect(store.messages).toHaveLength(2); // unchanged
  });

  it("load skips malformed JSONL lines", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    fs.writeFileSync(
      path.join(tmpDir, "conversation.jsonl"),
      '{"role":"system","content":"soul","ts":"t0"}\nNOT VALID JSON\n{"role":"user","content":"hello","ts":"t1"}\n',
      "utf8",
    );

    const store = new ConversationStore(tmpDir);
    expect(await store.load()).toBe(true);
    expect(store.messages).toHaveLength(2); // skipped the bad line
  });

  // -------------------------------------------------------------------
  // v0.7.0 (harness#293 J2) — session-id persistence across reloads
  // -------------------------------------------------------------------

  it("sessionId is undefined on a fresh store", () => {
    const store = new ConversationStore(tmpDir);
    expect(store.sessionId).toBeUndefined();
  });

  it("setSessionId persists to a sibling session.json", async () => {
    const store = new ConversationStore(tmpDir);
    await store.setSessionId("sess-123");
    expect(store.sessionId).toBe("sess-123");

    const raw = readFileSync(join(tmpDir, "session.json"), "utf8");
    expect(raw).toContain("sess-123");
  });

  it("load restores sessionId from disk", async () => {
    const store1 = new ConversationStore(tmpDir);
    await store1.setSessionId("sess-restore");
    await store1.append({ role: "user", content: "hi", ts: "t1" });

    const store2 = new ConversationStore(tmpDir);
    await store2.load();
    expect(store2.sessionId).toBe("sess-restore");
  });

  it("setSessionId(undefined) clears the captured id", async () => {
    const store = new ConversationStore(tmpDir);
    await store.setSessionId("sess-x");
    expect(store.sessionId).toBe("sess-x");
    await store.setSessionId(undefined);
    expect(store.sessionId).toBeUndefined();

    // File should reflect the cleared state.
    const raw = readFileSync(join(tmpDir, "session.json"), "utf8");
    const parsed = JSON.parse(raw) as { sessionId: unknown };
    expect(parsed.sessionId).toBeNull();
  });

  it("load tolerates missing session.json (pre-v0.7.0 conversations)", async () => {
    // Write only conversation.jsonl, no session.json — represents
    // a conversation persisted before v0.7.0 added the sibling file.
    const store1 = new ConversationStore(tmpDir);
    await store1.append({ role: "user", content: "old", ts: "t1" });

    const store2 = new ConversationStore(tmpDir);
    expect(await store2.load()).toBe(true);
    expect(store2.sessionId).toBeUndefined();
  });

  it("load tolerates malformed session.json", async () => {
    const fs = await import("node:fs");
    fs.writeFileSync(join(tmpDir, "session.json"), "not valid json", "utf8");

    const store = new ConversationStore(tmpDir);
    await store.load();
    expect(store.sessionId).toBeUndefined();
  });

  it("setSessionId is idempotent — repeated identical values are no-ops", async () => {
    const store = new ConversationStore(tmpDir);
    await store.setSessionId("same");
    await store.setSessionId("same");
    expect(store.sessionId).toBe("same");
  });

  it("token count recalculates exactly on compact", async () => {
    const store = new ConversationStore(tmpDir);
    await store.append({ role: "system", content: "soul", ts: "t0", tokenCount: 10 });
    await store.append({ role: "user", content: "old", ts: "t1", tokenCount: 100 });
    await store.append({ role: "assistant", content: "old reply", ts: "t2", tokenCount: 200 });
    await store.append({ role: "user", content: "new", ts: "t3", tokenCount: 50 });
    await store.append({ role: "assistant", content: "new reply", ts: "t4", tokenCount: 80 });

    await store.compact("summary", 2);

    // system(10) + compaction(~7/4≈2) + new(50) + new reply(80) = ~142
    const compactionTokens = store.messages.find((m) => m.role === "compaction")?.tokenCount ?? 0;
    expect(store.totalTokens).toBe(10 + compactionTokens + 50 + 80);
  });
});

describe("parsePersistentConfig", () => {
  it("returns null for stateless agents", () => {
    expect(parsePersistentConfig({})).toBeNull();
    expect(parsePersistentConfig({ executor: { mode: "stateless" } })).toBeNull();
  });

  it("returns config for persistent agents", () => {
    const config = parsePersistentConfig({
      executor: { mode: "persistent", max_context_tokens: 100000, summarize_at: 80000 },
    });
    expect(config).not.toBeNull();
    expect(config?.maxContextTokens).toBe(100000);
    expect(config?.summarizeAt).toBe(80000);
  });

  it("uses defaults when values not specified", () => {
    const config = parsePersistentConfig({ executor: { mode: "persistent" } });
    expect(config).not.toBeNull();
    expect(config?.maxContextTokens).toBe(200000);
    expect(config?.summarizeAt).toBe(150000);
  });
});
