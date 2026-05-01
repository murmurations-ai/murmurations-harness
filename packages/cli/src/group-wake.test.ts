import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CollaborationError } from "@murmurations-ai/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  formatCollaborationError,
  GITHUB_BODY_LIMIT,
  GroupWakeError,
  resolveLLMConfig,
  truncateMinutesForGithub,
} from "./group-wake.js";

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

describe("truncateMinutesForGithub (harness#267)", () => {
  const fallbackPath = "/tmp/runs/group-engineering/2026-05-01/meeting-abcd1234.md";

  it("returns body unchanged when under the limit", () => {
    const body = "x".repeat(GITHUB_BODY_LIMIT - 100);
    const result = truncateMinutesForGithub(body, fallbackPath);
    expect(result.truncated).toBe(false);
    expect(result.body).toBe(body);
  });

  it("returns body unchanged when exactly at the limit", () => {
    const body = "x".repeat(GITHUB_BODY_LIMIT);
    const result = truncateMinutesForGithub(body, fallbackPath);
    expect(result.truncated).toBe(false);
    expect(result.body).toBe(body);
  });

  it("truncates and appends a marker when over the limit", () => {
    const body = "x".repeat(GITHUB_BODY_LIMIT + 50_000);
    const result = truncateMinutesForGithub(body, fallbackPath);
    expect(result.truncated).toBe(true);
    expect(result.body.length).toBeLessThanOrEqual(GITHUB_BODY_LIMIT);
    expect(result.body).toContain("Minutes truncated for GitHub issue body limit");
    expect(result.body).toContain(fallbackPath);
    expect(result.body).toContain(String(body.length)); // original length surfaced
  });

  it("preserves the head of the body when truncating", () => {
    const head = "## Important first decision\n\nSome content here.\n";
    const body = head + "x".repeat(GITHUB_BODY_LIMIT);
    const result = truncateMinutesForGithub(body, fallbackPath);
    expect(result.truncated).toBe(true);
    expect(result.body.startsWith(head)).toBe(true);
  });

  it("includes the fallback path so operators can find the full record", () => {
    const body = "x".repeat(GITHUB_BODY_LIMIT + 1);
    const result = truncateMinutesForGithub(body, fallbackPath);
    expect(result.truncated).toBe(true);
    expect(result.body).toContain(fallbackPath);
  });

  it("real-world case: 110k char minutes from a Sonnet-with-tools convene", () => {
    // Reproduces today's failure: GITHUB_BODY_LIMIT=65536, body=113992
    const body = "real-meeting-content-".repeat(5_500); // ~110k chars
    const result = truncateMinutesForGithub(body, fallbackPath);
    expect(result.truncated).toBe(true);
    expect(result.body.length).toBeLessThanOrEqual(GITHUB_BODY_LIMIT);
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
    // v0.5.0 Engineering Standard #11: when role.md has no llm: block,
    // the loader cascades from harness.yaml. If harness.yaml is present
    // with an llm: block, the cascade fills in the agent. If neither
    // role.md nor harness.yaml set llm, and loadHarnessConfig returns
    // its built-in default (gemini), cascade still succeeds — so
    // `no-llm-block` is now a degenerate case that requires explicit
    // setup to produce.
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
    // With harness.yaml built-in defaults cascading in, the facilitator
    // inherits gemini and resolveLLMConfig succeeds.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.provider).toBe("gemini");
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
    // Numeric agent_id used to trigger schema failure. v0.5.0 coerces
    // numerics to strings (Engineering Standard #11). To exercise the
    // frontmatter-invalid path today, use an actually-invalid enum.
    await writeAgent(
      "facilitator",
      `---
model_tier: galactic
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
        const joined = result.issues.join("\n");
        expect(joined).toContain("model_tier");
        expect(joined).toContain("balanced");
      }
    }
  });
});
