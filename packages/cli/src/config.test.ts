import { describe, it, expect } from "vitest";
import { loadConfig } from "./config.js";

describe("config.ts", () => {
  it("returns defaults when no config file exists", () => {
    const config = loadConfig();

    expect(config.ui.leader).toBe("C-a");
    expect(config.ui.prompt).toBe("{name}> ");
    expect(config.ui.color).toBe("auto");
  });

  it("defaults include standard key bindings", () => {
    const config = loadConfig();

    expect(config.keys["C-a d"]).toBe(":detach");
    expect(config.keys["C-a s"]).toBe(":switch");
    expect(config.keys["C-a ?"]).toBe(":help");
    expect(config.keys["C-a q"]).toBe(":quit");
  });

  it("defaults have empty aliases and pinned sessions", () => {
    const config = loadConfig();

    expect(Object.keys(config.aliases)).toHaveLength(0);
    expect(config.sessions.pinned).toHaveLength(0);
  });
});
