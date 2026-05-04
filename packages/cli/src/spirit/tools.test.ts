/**
 * Spirit tools — unit tests for the pieces we can exercise without an
 * LLM: path-safety enforcement and skill loading.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildSpiritTools } from "./tools.js";

interface SocketResponse {
  readonly id: string;
  readonly result?: unknown;
  readonly error?: string;
}

const noopSend = (_method: string, _params?: Record<string, unknown>): Promise<SocketResponse> =>
  Promise.resolve({ id: "0", result: null });

describe("Spirit tools — read_file", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), `spirit-test-${randomUUID().slice(0, 8)}-`));
    writeFileSync(join(root, "hello.md"), "# hello\n", "utf8");
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "sub", "nested.md"), "nested\n", "utf8");
    writeFileSync(join(root, ".env"), "GITHUB_TOKEN=shh\n", "utf8");
    writeFileSync(join(root, ".env.local"), "X=1\n", "utf8");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const getTool = (name: string) => {
    const tools = buildSpiritTools({ rootDir: root, send: noopSend });
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`tool ${name} not found`);
    return tool;
  };

  it("reads files inside the murmuration root", async () => {
    const tool = getTool("read_file");
    const result = await tool.execute({ path: "hello.md" });
    expect(result).toBe("# hello\n");
  });

  it("reads nested files", async () => {
    const tool = getTool("read_file");
    const result = await tool.execute({ path: "sub/nested.md" });
    expect(result).toBe("nested\n");
  });

  it("refuses paths that escape the root", async () => {
    const tool = getTool("read_file");
    const result = await tool.execute({ path: "../outside.md" });
    expect(result).toMatch(/escapes the murmuration root/);
  });

  it("refuses to read .env files", async () => {
    const tool = getTool("read_file");
    const result = await tool.execute({ path: ".env" });
    expect(result).toMatch(/not allowed/);
  });

  it("refuses to read .env.local files", async () => {
    const tool = getTool("read_file");
    const result = await tool.execute({ path: ".env.local" });
    expect(result).toMatch(/not allowed/);
  });

  it("surfaces a clear error for a missing file", async () => {
    const tool = getTool("read_file");
    const result = await tool.execute({ path: "does-not-exist.md" });
    expect(result).toMatch(/read_file error/);
  });
});

describe("Spirit tools — list_dir", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), `spirit-test-${randomUUID().slice(0, 8)}-`));
    writeFileSync(join(root, "a.md"), "a\n", "utf8");
    mkdirSync(join(root, "dir"), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("lists entries with [dir]/[file] markers", async () => {
    const tools = buildSpiritTools({ rootDir: root, send: noopSend });
    const tool = tools.find((t) => t.name === "list_dir");
    expect(tool).toBeDefined();
    const result = (await tool!.execute({ path: "." })) as string;
    expect(result).toMatch(/\[file\] a\.md/);
    expect(result).toMatch(/\[dir\] dir/);
  });
});

describe("Spirit tools — load_skill", () => {
  it("loads a baseline skill by name", async () => {
    const tools = buildSpiritTools({ rootDir: "/", send: noopSend });
    const tool = tools.find((t) => t.name === "load_skill");
    expect(tool).toBeDefined();
    const result = (await tool!.execute({ name: "when-to-use-governance" })) as string;
    expect(result).toMatch(/When to use governance/);
  });

  it("rejects non-kebab-case skill names", async () => {
    const tools = buildSpiritTools({ rootDir: "/", send: noopSend });
    const tool = tools.find((t) => t.name === "load_skill");
    const result = (await tool!.execute({ name: "../etc/passwd" })) as string;
    expect(result).toMatch(/invalid skill name/);
  });

  it("reports unknown skills", async () => {
    const tools = buildSpiritTools({ rootDir: "/", send: noopSend });
    const tool = tools.find((t) => t.name === "load_skill");
    const result = (await tool!.execute({ name: "does-not-exist" })) as string;
    expect(result).toMatch(/not found/);
  });
});

describe("Spirit tools — socket RPC wrappers", () => {
  it("status calls send('status')", async () => {
    let called = "";
    const send: typeof noopSend = (method) => {
      called = method;
      return Promise.resolve({ id: "1", result: { ok: true } });
    };
    const tools = buildSpiritTools({ rootDir: "/", send });
    const tool = tools.find((t) => t.name === "status");
    const result = (await tool!.execute({})) as string;
    expect(called).toBe("status");
    expect(result).toMatch(/"ok": true/);
  });

  it("surfaces daemon errors verbatim", async () => {
    const send: typeof noopSend = () => Promise.resolve({ id: "1", error: "daemon not connected" });
    const tools = buildSpiritTools({ rootDir: "/", send });
    const tool = tools.find((t) => t.name === "agents");
    const result = (await tool!.execute({})) as string;
    expect(result).toMatch(/daemon not connected/);
  });

  it("wake passes agent_id as agentId in params", async () => {
    let capturedParams: Record<string, unknown> | undefined;
    const send: typeof noopSend = (_method, params) => {
      capturedParams = params;
      return Promise.resolve({ id: "1", result: "ok" });
    };
    const tools = buildSpiritTools({ rootDir: "/", send });
    const tool = tools.find((t) => t.name === "wake");
    await tool!.execute({ agent_id: "01-research" });
    expect(capturedParams).toEqual({ agentId: "01-research" });
  });
});

// ---------------------------------------------------------------------------
// Workstream K3 — facilitator-related tools
// ---------------------------------------------------------------------------

describe("Spirit tools — get_facilitator_log (K3)", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), `spirit-fac-${randomUUID().slice(0, 8)}-`));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const getTool = (name: string) => {
    const tools = buildSpiritTools({ rootDir: root, send: noopSend });
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`tool ${name} not found`);
    return tool;
  };

  it("returns a friendly message when there are no facilitator runs", async () => {
    const tool = getTool("get_facilitator_log");
    const result = (await tool.execute({})) as string;
    expect(result).toMatch(/no runs yet/);
  });

  it("reads the most recent digest when no date is given", async () => {
    const day = "2026-05-04";
    const dir = join(root, "runs", "facilitator-agent", day);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "digest-2026-05-04T10-00-00Z-aaaa.md"), "first\n", "utf8");
    writeFileSync(join(dir, "digest-2026-05-04T11-00-00Z-bbbb.md"), "LATEST DIGEST\n", "utf8");

    const tool = getTool("get_facilitator_log");
    const result = (await tool.execute({})) as string;
    expect(result).toContain("LATEST DIGEST");
  });

  it("honors an explicit date", async () => {
    const earlier = "2026-05-01";
    const later = "2026-05-04";
    const earlierDir = join(root, "runs", "facilitator-agent", earlier);
    const laterDir = join(root, "runs", "facilitator-agent", later);
    mkdirSync(earlierDir, { recursive: true });
    mkdirSync(laterDir, { recursive: true });
    writeFileSync(join(earlierDir, "digest-2026-05-01T10-00-00Z-aaaa.md"), "MAY ONE\n", "utf8");
    writeFileSync(join(laterDir, "digest-2026-05-04T10-00-00Z-bbbb.md"), "MAY FOUR\n", "utf8");

    const tool = getTool("get_facilitator_log");
    const result = (await tool.execute({ date: earlier })) as string;
    expect(result).toContain("MAY ONE");
    expect(result).not.toContain("MAY FOUR");
  });
});

describe("Spirit tools — get_agreement (K3)", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), `spirit-agreement-${randomUUID().slice(0, 8)}-`));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const getTool = (name: string) => {
    const tools = buildSpiritTools({ rootDir: root, send: noopSend });
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`tool ${name} not found`);
    return tool;
  };

  it("returns a not-found message when items.jsonl is missing", async () => {
    const tool = getTool("get_agreement");
    const result = (await tool.execute({ id: "anything" })) as string;
    expect(result).toMatch(/no item with id/);
  });

  it("finds and returns a governance item by id", async () => {
    const govDir = join(root, ".murmuration", "governance");
    mkdirSync(govDir, { recursive: true });
    const item = {
      id: "proposal-2026-05-04",
      kind: "proposal",
      currentState: "consented",
      createdBy: { kind: "agent-id", value: "facilitator-agent" },
      createdAt: "2026-05-04T10:00:00Z",
      reviewAt: null,
      history: [],
    };
    writeFileSync(join(govDir, "items.jsonl"), JSON.stringify(item) + "\n", "utf8");

    const tool = getTool("get_agreement");
    const result = (await tool.execute({ id: "proposal-2026-05-04" })) as string;
    expect(result).toContain("proposal-2026-05-04");
    expect(result).toContain("consented");
  });
});

describe("Spirit tools — list_awaiting_source_close (K3)", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), `spirit-awaiting-${randomUUID().slice(0, 8)}-`));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const getTool = (name: string) => {
    const tools = buildSpiritTools({ rootDir: root, send: noopSend });
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`tool ${name} not found`);
    return tool;
  };

  it("falls back to a hint when no facilitator digests exist", async () => {
    const tool = getTool("list_awaiting_source_close");
    const result = (await tool.execute({})) as string;
    expect(result).toMatch(/no runs yet|no 'awaiting source'|gh issue list/);
  });

  it("extracts the awaiting-source section when present", async () => {
    const day = "2026-05-04";
    const dir = join(root, "runs", "facilitator-agent", day);
    mkdirSync(dir, { recursive: true });
    const digest = `# Facilitator Log

## Closed today

- #100 closed by Facilitator

## Awaiting Source close

- #200 — escalated, second verification failure
- #201 — DIRECTIVE in terminal state

## Other notes
`;
    writeFileSync(join(dir, "digest-2026-05-04T10-00-00Z-aaaa.md"), digest, "utf8");

    const tool = getTool("list_awaiting_source_close");
    const result = (await tool.execute({})) as string;
    expect(result).toContain("#200");
    expect(result).toContain("#201");
    expect(result).not.toContain("Other notes");
  });
});

describe("Spirit tools — close_issue (K3)", () => {
  it("returns a gh issue close command for the operator to run", async () => {
    const tools = buildSpiritTools({ rootDir: "/", send: noopSend });
    const tool = tools.find((t) => t.name === "close_issue");
    const result = (await tool!.execute({
      number: 552,
      reason: "Decided: bundle pricing approved.",
      repo: "xeeban/emergent-praxis",
    })) as string;
    expect(result).toContain("gh issue close 552");
    expect(result).toContain("--repo xeeban/emergent-praxis");
    expect(result).toContain("Decided: bundle pricing approved.");
  });

  it("escapes single quotes in the reason", async () => {
    const tools = buildSpiritTools({ rootDir: "/", send: noopSend });
    const tool = tools.find((t) => t.name === "close_issue");
    const result = (await tool!.execute({ number: 1, reason: "it's fine" })) as string;
    expect(result).toContain("'it'\\''s fine'");
  });
});
