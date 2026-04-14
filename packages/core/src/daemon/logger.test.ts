import { describe, it, expect, vi } from "vitest";
import { DaemonLoggerImpl } from "./logger.js";
import { DaemonEventBus, type DaemonEvent } from "./events.js";

describe("DaemonLoggerImpl", () => {
  it("writes JSON-lines to stdout", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logger = new DaemonLoggerImpl({ level: "info" });

    logger.info("daemon.boot", { agentCount: 5 });

    expect(spy).toHaveBeenCalledOnce();
    const line = spy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(line.trim()) as Record<string, unknown>;
    expect(parsed.level).toBe("info");
    expect(parsed.event).toBe("daemon.boot");
    expect(parsed.agentCount).toBe(5);
    expect(parsed.ts).toBeDefined();
    spy.mockRestore();
  });

  it("filters messages below configured level", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logger = new DaemonLoggerImpl({ level: "warn" });

    logger.debug("skip", {});
    logger.info("skip", {});
    logger.warn("show.warn", {});
    logger.error("show.error", {});

    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it("debug level shows all messages", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logger = new DaemonLoggerImpl({ level: "debug" });

    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");

    expect(spy).toHaveBeenCalledTimes(4);
    spy.mockRestore();
  });

  it("data parameter is optional", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logger = new DaemonLoggerImpl({ level: "info" });

    logger.info("no-data");

    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it("emits log.entry events to the bus", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const bus = new DaemonEventBus();
    const events: DaemonEvent[] = [];
    bus.subscribe((e) => events.push(e));

    const logger = new DaemonLoggerImpl({ level: "info", eventBus: bus });
    logger.info("test.event", { foo: "bar" });

    expect(events).toHaveLength(1);
    const evt = events[0];
    expect(evt?.kind).toBe("log.entry");
    if (evt?.kind === "log.entry") {
      expect(evt.level).toBe("info");
      expect(evt.event).toBe("test.event");
      expect(evt.data.foo).toBe("bar");
    }
    spy.mockRestore();
  });

  it("does not emit filtered messages to the bus", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const bus = new DaemonEventBus();
    const events: DaemonEvent[] = [];
    bus.subscribe((e) => events.push(e));

    const logger = new DaemonLoggerImpl({ level: "error", eventBus: bus });
    logger.debug("skip");
    logger.info("skip");
    logger.warn("skip");

    expect(events).toHaveLength(0);
    spy.mockRestore();
  });

  it("defaults to info level when no level specified", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logger = new DaemonLoggerImpl();

    logger.debug("skip");
    logger.info("show");

    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});
