import { describe, it, expect, vi } from "vitest";
import { DaemonEventBus, type DaemonEvent } from "./events.js";

describe("DaemonEventBus", () => {
  it("delivers events to subscribers", () => {
    const bus = new DaemonEventBus();
    const received: DaemonEvent[] = [];
    bus.subscribe((e) => received.push(e));

    bus.emit({ kind: "wake.started", agentId: "01-research", wakeId: "w1" });

    expect(received).toHaveLength(1);
    expect(received[0]?.kind).toBe("wake.started");
  });

  it("delivers to multiple subscribers", () => {
    const bus = new DaemonEventBus();
    const a: DaemonEvent[] = [];
    const b: DaemonEvent[] = [];
    bus.subscribe((e) => a.push(e));
    bus.subscribe((e) => b.push(e));

    bus.emit({ kind: "command.executed", method: "stop", ok: true });

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it("unsubscribe stops delivery", () => {
    const bus = new DaemonEventBus();
    const received: DaemonEvent[] = [];
    const unsub = bus.subscribe((e) => received.push(e));

    bus.emit({ kind: "wake.started", agentId: "a", wakeId: "w1" });
    expect(received).toHaveLength(1);

    unsub();
    bus.emit({ kind: "wake.started", agentId: "a", wakeId: "w2" });
    expect(received).toHaveLength(1); // no new events
  });

  it("tracks subscriber count", () => {
    const bus = new DaemonEventBus();
    expect(bus.size).toBe(0);

    const unsub1 = bus.subscribe(() => {
      /* noop */
    });
    const unsub2 = bus.subscribe(() => {
      /* noop */
    });
    expect(bus.size).toBe(2);

    unsub1();
    expect(bus.size).toBe(1);

    unsub2();
    expect(bus.size).toBe(0);
  });

  it("catches listener errors without breaking other listeners", () => {
    const bus = new DaemonEventBus();
    const received: DaemonEvent[] = [];

    // First listener throws
    bus.subscribe(() => {
      throw new Error("boom");
    });
    // Second listener should still receive
    bus.subscribe((e) => received.push(e));

    // Suppress stderr from the error log
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    bus.emit({
      kind: "wake.completed",
      agentId: "a",
      wakeId: "w1",
      outcome: "success",
      artifactCount: 1,
    });

    expect(received).toHaveLength(1);
    expect(stderrSpy).toHaveBeenCalledOnce();
    stderrSpy.mockRestore();
  });

  it("discriminates event kinds correctly", () => {
    const bus = new DaemonEventBus();
    const meetings: DaemonEvent[] = [];

    bus.subscribe((e) => {
      if (e.kind === "meeting.completed") meetings.push(e);
    });

    bus.emit({ kind: "wake.started", agentId: "a", wakeId: "w1" });
    bus.emit({
      kind: "meeting.completed",
      groupId: "content",
      meetingKind: "governance",
      transitions: [{ itemId: "x", to: "resolved" }],
    });
    bus.emit({ kind: "command.executed", method: "stop", ok: true });

    expect(meetings).toHaveLength(1);
    const evt = meetings[0];
    if (evt?.kind === "meeting.completed") {
      expect(evt.groupId).toBe("content");
      expect(evt.transitions).toHaveLength(1);
    }
  });

  it("handles governance.transitioned events", () => {
    const bus = new DaemonEventBus();
    const received: DaemonEvent[] = [];
    bus.subscribe((e) => received.push(e));

    bus.emit({
      kind: "governance.transitioned",
      itemId: "item-1",
      from: "open",
      to: "resolved",
      triggeredBy: "governance-meeting",
    });

    expect(received).toHaveLength(1);
    const evt = received[0];
    if (evt?.kind === "governance.transitioned") {
      expect(evt.itemId).toBe("item-1");
      expect(evt.from).toBe("open");
      expect(evt.to).toBe("resolved");
    }
  });
});
