import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

const __dirname_compat = dirname(fileURLToPath(import.meta.url));

describe("dashboard.html", () => {
  const html = readFileSync(resolve(__dirname_compat, "dashboard.html"), "utf8");

  it("is valid HTML with opening and closing tags", () => {
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("</html>");
    expect(html).toContain("<script>");
    expect(html).toContain("</script>");
  });

  it("contains no template literal escape artifacts", () => {
    // These patterns indicate the HTML was extracted from a JS template
    // literal but the escapes weren't cleaned up
    const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(html);
    expect(scriptMatch).toBeTruthy();
    const script = scriptMatch?.[1] ?? "";

    // \\/ is a template literal escape for / — in raw JS it should be \/
    expect(script).not.toContain("\\\\/");
    // \\s is a template literal escape for \s — in raw JS it should be \s
    expect(script).not.toMatch(/\\\\s(?![a-z])/);
    // \\n in a regex context (not in a string) is a template literal artifact
    expect(script).not.toMatch(/\\\\n(?![a-z])/);
  });

  it("JavaScript parses without syntax errors", () => {
    const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(html);
    expect(scriptMatch).toBeTruthy();
    const script = scriptMatch?.[1] ?? "";

    // node:vm Script constructor throws SyntaxError if the JS is invalid
    expect(() => new Script(script, { filename: "dashboard.html" })).not.toThrow();
  });

  it("declares required functions", () => {
    expect(html).toContain("function refresh()");
    expect(html).toContain("function sendCmd(");
    expect(html).toContain("function wakeNow(");
    expect(html).toContain("function showAgent(");
    expect(html).toContain("function showGroup(");
    expect(html).toContain("function linkify(");
    expect(html).toContain("function conveneGovernance(");
  });

  it("registers SSE event listeners", () => {
    expect(html).toContain("addEventListener('wake.completed'");
    expect(html).toContain("addEventListener('meeting.started'");
    expect(html).toContain("addEventListener('meeting.completed'");
    expect(html).toContain("addEventListener('governance.transitioned'");
    expect(html).toContain("addEventListener('log.entry'");
  });

  it("has agent sort and filter controls", () => {
    expect(html).toContain('id="agent-sort"');
    expect(html).toContain('id="agent-filter"');
    expect(html).toContain("sessionStorage.setItem('agentSort'");
    expect(html).toContain("sessionStorage.setItem('agentFilter'");
  });

  it("has log viewer with level filter buttons", () => {
    expect(html).toContain('id="log-viewer"');
    expect(html).toContain('id="log-level-btns"');
    expect(html).toContain("function setLogFilter(");
    expect(html).toContain("function renderLog(");
  });

  it("has convene governance modal with group picker", () => {
    expect(html).toContain('id="convene-gov-modal"');
    expect(html).toContain('id="convene-gov-group"');
    expect(html).toContain("function confirmConveneGovernance(");
  });

  it("linkify regex is valid (no template literal artifacts)", () => {
    const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(html);
    const script = scriptMatch?.[1] ?? "";
    // Extract the regex from the linkify function
    const linkifyMatch = /function linkify\(text\)\s*\{[^}]*replace\(([^,]+),/.exec(script);
    expect(linkifyMatch).toBeTruthy();
    // The regex should compile without errors
    const regexStr = linkifyMatch?.[1]?.trim() ?? "";
    expect(regexStr).toContain("https?");
    expect(regexStr).not.toContain("\\\\"); // no double-backslash artifacts
  });
});
