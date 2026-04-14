import { describe, it, expect } from "vitest";
import {
  PROTOCOL_METHODS,
  PROTOCOL_SCHEMA_VERSION,
  getMethod,
  shippedBatchMethods,
  shippedReplMethods,
} from "./protocol.js";

describe("protocol.ts", () => {
  it("schema version is a positive integer", () => {
    expect(PROTOCOL_SCHEMA_VERSION).toBeGreaterThan(0);
    expect(Number.isInteger(PROTOCOL_SCHEMA_VERSION)).toBe(true);
  });

  it("every method has a name, summary, mutating flag, and surfaces", () => {
    for (const m of PROTOCOL_METHODS) {
      expect(m.name).toBeTruthy();
      expect(m.summary).toBeTruthy();
      expect(typeof m.mutating).toBe("boolean");
      expect(m.surfaces).toBeDefined();
      expect(m.surfaces.cliBatch).toBeTruthy();
      expect(m.surfaces.cliRepl).toBeTruthy();
      expect(m.surfaces.tuiDash).toBeTruthy();
      expect(m.surfaces.webDash).toBeTruthy();
    }
  });

  it("method names are unique", () => {
    const names = PROTOCOL_METHODS.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("CLI batch never has out-of-scope (ADR-0018 §3 parity rule)", () => {
    for (const m of PROTOCOL_METHODS) {
      expect(
        m.surfaces.cliBatch,
        `method "${m.name}" has cliBatch=out-of-scope — violates parity rule`,
      ).not.toBe("out-of-scope");
    }
  });

  it("getMethod finds existing methods", () => {
    const status = getMethod("status");
    expect(status).toBeDefined();
    expect(status?.name).toBe("status");
    expect(status?.mutating).toBe(false);
  });

  it("getMethod returns undefined for unknown methods", () => {
    expect(getMethod("nonexistent")).toBeUndefined();
  });

  it("shipped batch methods include status, directive, stop", () => {
    const names = shippedBatchMethods().map((m) => m.name);
    expect(names).toContain("status");
    expect(names).toContain("directive");
    expect(names).toContain("stop");
    expect(names).toContain("wake-now");
    expect(names).toContain("group-wake");
  });

  it("shipped REPL methods include status, directive", () => {
    const names = shippedReplMethods().map((m) => m.name);
    expect(names).toContain("status");
    expect(names).toContain("directive");
  });

  it("read-only methods are not marked mutating", () => {
    const readMethods = [
      "status",
      "agents.list",
      "agents.get",
      "groups.list",
      "groups.get",
      "events.history",
      "cost.summary",
    ];
    for (const name of readMethods) {
      const m = getMethod(name);
      if (m) {
        expect(m.mutating, `${name} should be read-only`).toBe(false);
      }
    }
  });

  it("mutating methods include directive, wake-now, stop", () => {
    const mutating = PROTOCOL_METHODS.filter((m) => m.mutating).map((m) => m.name);
    expect(mutating).toContain("directive");
    expect(mutating).toContain("wake-now");
    expect(mutating).toContain("stop");
    expect(mutating).toContain("group-wake");
  });
});
