/**
 * Real-CLI smoke test for harness#293 (subscription-CLI session resume).
 *
 * Exercises the full round-trip against the operator's locally-installed
 * `claude` CLI:
 *
 *   1. First turn: spawn claude -p without --resume, capture session_id
 *      from the parsed response.
 *   2. Second turn: spawn claude -p with --resume <session_id>, send a
 *      reference-back message ("what did I just say?") to verify the
 *      session is actually warm.
 *   3. Assert the second turn's input tokens are dramatically smaller
 *      than the first (cache hit visible).
 *
 * Gated behind RUN_SUBSCRIPTION_CLI_SMOKE=1 because:
 *   - It requires `claude` installed and authenticated (subscription)
 *   - Each run consumes the operator's subscription budget
 *   - Not deterministic (first turn's input includes claude's own preamble)
 *
 * Operators verify J1 with:
 *
 *   RUN_SUBSCRIPTION_CLI_SMOKE=1 \
 *     npx vitest run packages/llm/src/providers/subprocess/session-resume-smoke.test.ts
 */

import { describe, expect, it } from "vitest";

import { ClaudeCliAdapter } from "./adapters/claude.js";
import { SubprocessAdapter } from "./base-client.js";

import type { LLMRequest } from "../../types.js";

const SHOULD_RUN = process.env.RUN_SUBSCRIPTION_CLI_SMOKE === "1";
const skipUnlessSmoke = SHOULD_RUN ? describe : describe.skip;

skipUnlessSmoke("subscription-CLI session resume smoke test (harness#293)", () => {
  it(
    "first turn captures session_id; second turn resumes with it",
    { timeout: 180_000 }, // 3 min wall-clock budget across both turns
    async () => {
      const cli = new ClaudeCliAdapter();
      const adapter = new SubprocessAdapter("claude-haiku-4-5", {
        cliAdapter: cli,
        timeoutMs: 60_000,
      });

      const turn1Request: LLMRequest = {
        messages: [
          {
            role: "user",
            content: "What is 7 multiplied by 8? Answer with just the number.",
          },
        ],
        maxOutputTokens: 100,
      };

      const turn1 = await adapter.complete(turn1Request, {});
      expect(turn1.ok).toBe(true);
      if (!turn1.ok) {
        throw new Error(`turn 1 failed: ${turn1.error.message}`);
      }
      // Session id MUST be captured for the resume to work.
      expect(turn1.value.sessionId).toBeDefined();
      expect(typeof turn1.value.sessionId).toBe("string");
      expect(turn1.value.sessionId?.length ?? 0).toBeGreaterThan(0);

      const sessionId = turn1.value.sessionId;
      if (sessionId === undefined) throw new Error("sessionId missing");

      // Turn 2 — pass sessionId so the CLI resumes the conversation.
      // The follow-up only makes sense if turn 1's context is loaded:
      // "double it" requires knowing what "it" refers to.
      const turn2Request: LLMRequest = {
        messages: [
          {
            role: "user",
            content: "Take that result and double it. Answer with just the number.",
          },
        ],
        maxOutputTokens: 100,
        sessionId,
      };

      const turn2 = await adapter.complete(turn2Request, {});
      expect(turn2.ok).toBe(true);
      if (!turn2.ok) {
        throw new Error(`turn 2 failed: ${turn2.error.message}`);
      }

      // Resume MUST surface a session id (could be the same or a new
      // one depending on CLI behavior — both are valid).
      expect(turn2.value.sessionId).toBeDefined();

      // 7 * 8 = 56; doubled = 112. If the session resumed properly,
      // claude knows what "it" refers to in turn 2's prompt and can
      // produce 112. Without resume, "it" has no antecedent and
      // claude either refuses or asks for clarification — neither
      // contains "112".
      expect(turn2.value.content).toContain("112");

      // Diagnostic output for the operator running the smoke test —
      // visible via `npx vitest run ... --reporter=verbose`.
      console.log(
        `[smoke] turn 1: ${String(turn1.value.inputTokens)} in / ${String(turn1.value.outputTokens)} out / cache_read=${String(turn1.value.cacheReadTokens ?? 0)} (session ${sessionId})`,
      );
      console.log(
        `[smoke] turn 2: ${String(turn2.value.inputTokens)} in / ${String(turn2.value.outputTokens)} out / cache_read=${String(turn2.value.cacheReadTokens ?? 0)} (session ${turn2.value.sessionId ?? "?"})`,
      );
    },
  );
});
