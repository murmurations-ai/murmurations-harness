import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CollaborationError } from "@murmurations-ai/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { formatCollaborationError, GroupWakeError, resolveLLMConfig } from "./group-wake.js";

describe("GroupWakeError", () => {
  it("has correct name property", () => {
    const err = new GroupWakeError("MISSING_GROUP_ID", "test");
    expect(err.name).toBe("GroupWakeError");
  });

  it("preserves error code", () => {
    const err = new GroupWakeError("GROUP_NOT_FOUND", "not found");
    expect(err.code).toBe("GROUP_NOT_FOUND");
    expect(err.message).toBe("not found");
  });

  it("is instanceof Error", () => {
    const err = new GroupWakeError("LLM_CONFIG_FAILED", "bad config");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(GroupWakeError);
  });

  it("supports all error codes", () => {
    const codes = [
      "GROUP_NOT_FOUND",
      "LLM_CONFIG_FAILED",
      "MISSING_GROUP_ID",
      "MISSING_LLM_TOKEN",
    ] as const;
    for (const code of codes) {
      const err = new GroupWakeError(code, `test ${code}`);
      expect(err.code).toBe(code);
    }
  });
});

describe("formatCollaborationError (v0.5.0 Milestone 1)", () => {
  it("includes the message alongside the code", () => {
    const err = new CollaborationError("github", "PERMISSION_DENIED", "token missing repo scope");
    expect(formatCollaborationError(err)).toBe("PERMISSION_DENIED: token missing repo scope");
  });

  it("falls back to just the code when the message is the generic fallback", () => {
    const err = new CollaborationError("github", "UNKNOWN", "Unknown error");
    expect(formatCollaborationError(err)).toBe("UNKNOWN");
  });

  it("falls back to just the code when the message is empty", () => {
    const err = new CollaborationError("github", "NOT_FOUND", "");
    expect(formatCollaborationError(err)).toBe("NOT_FOUND");
  });

  it("trims whitespace from the message", () => {
    const err = new CollaborationError("github", "RATE_LIMITED", "  slow down please  ");
    expect(formatCollaborationError(err)).toBe("RATE_LIMITED: slow down please");
  });
});

describe("resolveLLMConfig (v0.5.0 Milestone 1)", () => {
  let rootDir = "";

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "group-wake-resolve-"));
    await mkdir(join(rootDir, "murmuration"), { recursive: true });
    await writeFile(join(rootDir, "murmuration", "soul.md"), "# soul\n", "utf8");
  });

  afterEach(async () => {
    if (rootDir) await rm(rootDir, { recursive: true, force: true });
  });

  const writeAgent = async (slug: string, roleContent: string): Promise<void> => {
    const dir = join(rootDir, "agents", slug);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "soul.md"), "# soul\n", "utf8");
    await writeFile(join(dir, "role.md"), roleContent, "utf8");
  };

  it("returns ok=true with config when role.md has a valid llm block", async () => {
    await writeAgent(
      "facilitator",
      `---
agent_id: "facilitator"
name: "Facilitator"
model_tier: balanced
llm:
  provider: "gemini"
  model: "gemini-2.5-pro"
---
body
`,
    );
    const result = await resolveLLMConfig(rootDir, "facilitator");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.provider).toBe("gemini");
      expect(result.config.model).toBe("gemini-2.5-pro");
    }
  });

  it("returns ok=false reason=no-llm-block when role.md is missing the llm: key", async () => {
    await writeAgent(
      "facilitator",
      `---
agent_id: "facilitator"
name: "Facilitator"
model_tier: balanced
---
body
`,
    );
    const result = await resolveLLMConfig(rootDir, "facilitator");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("no-llm-block");
      if (result.reason === "no-llm-block") {
        expect(result.rolePath).toContain("agents/facilitator/role.md");
      }
    }
  });

  it("returns ok=false reason=file-not-found when agents/<id>/ is missing", async () => {
    const result = await resolveLLMConfig(rootDir, "no-such-agent");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("file-not-found");
      if (result.reason === "file-not-found") {
        expect(result.path).toContain("agents/no-such-agent");
      }
    }
  });

  it("returns ok=false reason=frontmatter-invalid with the Zod issues when schema fails", async () => {
    await writeAgent(
      "facilitator",
      `---
agent_id: 22
name: "Facilitator"
model_tier: balanced
---
body
`,
    );
    const result = await resolveLLMConfig(rootDir, "facilitator");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("frontmatter-invalid");
      if (result.reason === "frontmatter-invalid") {
        expect(result.path).toContain("agents/facilitator/role.md");
        // Issue list carries both the Zod message and the v0.5.0 remediation hint
        const joined = result.issues.join("\n");
        expect(joined).toContain("agent_id");
        expect(joined).toContain('"facilitator"');
      }
    }
  });
});
