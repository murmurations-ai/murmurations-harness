/**
 * Spirit resume-session recovery (harness#424).
 *
 * When the claude CLI session that a persisted `sessionId` points at no
 * longer exists (daemon restart, session GC, different machine), `--resume`
 * fails hard. The Spirit must drop the stale id and retry once with a fresh
 * session instead of surfacing a raw internal error. These tests inject a
 * mock LLM client (via the `llmClient` test seam) so the full `turn()` flow
 * runs without spawning a real subprocess.
 */

import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LLMInternalError,
  type LLMClient,
  type LLMClientError,
  type LLMRequest,
  type LLMResponse,
  type Result,
} from "@murmurations-ai/llm";

import { initSpiritSession } from "./client.js";

const HARNESS_YAML = `governance:
  model: sociocracy-3.0
  plugin: "@murmurations-ai/governance-s3"
llm:
  provider: subscription-cli
  cli: claude
  model: claude-sonnet-4-6
`;

const noopSend = (): Promise<{ id: string; error: string }> =>
  Promise.resolve({ id: "0", error: "no daemon" });

const okResponse = (sessionId: string): Result<LLMResponse, LLMClientError> => ({
  ok: true,
  value: {
    content: "hi back",
    stopReason: "stop",
    inputTokens: 10,
    outputTokens: 5,
    modelUsed: "claude-sonnet-4-6",
    providerUsed: "claude-cli",
    sessionId,
    toolCalls: [],
  },
});

const resumeMissing = (): Result<LLMResponse, LLMClientError> => ({
  ok: false,
  error: new LLMInternalError("claude-cli", "No conversation found with session ID: stale-id", {
    requestUrl: "subprocess://claude",
  }),
});

const authFailure = (): Result<LLMResponse, LLMClientError> => ({
  ok: false,
  error: new LLMInternalError("claude-cli", "invalid api key", { requestUrl: "x" }),
});

/** Mock LLM client that returns scripted results and records each request. */
const mockClient = (
  results: readonly (() => Result<LLMResponse, LLMClientError>)[],
): { client: LLMClient; calls: LLMRequest[] } => {
  const calls: LLMRequest[] = [];
  const client: LLMClient = {
    capabilities: () => ({
      supportsStreaming: false,
      supportsToolUse: false,
      supportsJsonMode: false,
      maxContextTokens: 200_000,
    }),
    complete: (request) => {
      const idx = Math.min(calls.length, results.length - 1);
      calls.push(request);
      const fn = results[idx];
      return Promise.resolve(fn ? fn() : okResponse("fallback"));
    },
  };
  return { client, calls };
};

const readPersistedSessionId = async (root: string): Promise<string | null> => {
  const raw = await readFile(join(root, ".murmuration", "spirit", "session.json"), "utf8");
  return (JSON.parse(raw) as { sessionId?: string | null }).sessionId ?? null;
};

describe("Spirit resume-session recovery (harness#424)", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "spirit-resume-"));
    await mkdir(join(root, "murmuration"), { recursive: true });
    await writeFile(join(root, "murmuration", "harness.yaml"), HARNESS_YAML, "utf8");
    await writeFile(join(root, "murmuration", "soul.md"), "# Test murmuration\n", "utf8");
    // Seed a stale CLI session id, as a prior attach would have left.
    const spiritDir = join(root, ".murmuration", "spirit");
    await mkdir(spiritDir, { recursive: true });
    await writeFile(
      join(spiritDir, "session.json"),
      JSON.stringify({ sessionId: "stale-id" }),
      "utf8",
    );
  });

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("drops a stale session and retries once without --resume, then persists the fresh id", async () => {
    const { client, calls } = mockClient([resumeMissing, () => okResponse("fresh-id")]);
    const session = await initSpiritSession({ rootDir: root, send: noopSend, llmClient: client });

    await expect(session.turn("hi")).resolves.toBeDefined();

    // Exactly one retry — no loop.
    expect(calls).toHaveLength(2);
    // First attempt resumed the stale id; the retry omitted it (fresh session).
    expect(calls[0]?.sessionId).toBe("stale-id");
    expect(calls[1]?.sessionId).toBeUndefined();
    // The retry still carried the user's message.
    expect(calls[1]?.messages.some((m) => m.content === "hi")).toBe(true);
    // The fresh id surfaced by the retry is persisted for the next turn.
    expect(await readPersistedSessionId(root)).toBe("fresh-id");
  });

  it("does NOT retry or clear the session on a non-resume error", async () => {
    const { client, calls } = mockClient([authFailure]);
    const session = await initSpiritSession({ rootDir: root, send: noopSend, llmClient: client });

    await expect(session.turn("hi")).rejects.toThrow();

    expect(calls).toHaveLength(1); // no retry
    // The stale id is left untouched — only the resume-missing case clears it.
    expect(await readPersistedSessionId(root)).toBe("stale-id");
  });

  it("gives up after one retry if the fresh session also fails", async () => {
    const { client, calls } = mockClient([resumeMissing, authFailure]);
    const session = await initSpiritSession({ rootDir: root, send: noopSend, llmClient: client });

    await expect(session.turn("hi")).rejects.toThrow();

    expect(calls).toHaveLength(2); // one retry, then surface the error
    expect(calls[1]?.sessionId).toBeUndefined(); // retry was the fresh-session attempt
    // Session was cleared on the resume-missing detection and not re-set.
    expect(await readPersistedSessionId(root)).toBeNull();
  });
});
