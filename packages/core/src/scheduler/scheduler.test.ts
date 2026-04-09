import { afterEach, describe, expect, it, vi } from "vitest";

import { makeAgentId } from "../execution/index.js";
import { TimerScheduler, type ScheduledWakeEvent } from "./index.js";

describe("TimerScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires a delay-once trigger after the configured delay", async () => {
    vi.useFakeTimers();
    const scheduler = new TimerScheduler();
    const agentId = makeAgentId("hello-world");

    const fired: ScheduledWakeEvent[] = [];
    scheduler.onWake((event) => {
      fired.push(event);
    });

    scheduler.schedule(agentId, { kind: "delay-once", delayMs: 2000 });
    scheduler.start();

    // Before the delay — nothing should have fired.
    expect(fired).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1999);
    expect(fired).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(fired).toHaveLength(1);
    expect(fired[0]?.agentId.value).toBe("hello-world");
    expect(fired[0]?.wakeReason.kind).toBe("manual");

    await scheduler.stop();
  });

  it("fires an interval trigger repeatedly", async () => {
    vi.useFakeTimers();
    const scheduler = new TimerScheduler();
    const agentId = makeAgentId("heartbeat");

    const fired: ScheduledWakeEvent[] = [];
    scheduler.onWake((event) => {
      fired.push(event);
    });

    scheduler.schedule(agentId, { kind: "interval", intervalMs: 100 });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(350);
    expect(fired).toHaveLength(3);
    expect(fired.every((e) => e.wakeReason.kind === "scheduled")).toBe(true);

    await scheduler.stop();
  });

  it("unschedule removes the agent and prevents further firing", async () => {
    vi.useFakeTimers();
    const scheduler = new TimerScheduler();
    const agentId = makeAgentId("test-agent");

    const fired: ScheduledWakeEvent[] = [];
    scheduler.onWake((event) => {
      fired.push(event);
    });

    scheduler.schedule(agentId, { kind: "interval", intervalMs: 50 });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(120);
    expect(fired.length).toBeGreaterThanOrEqual(2);

    const removed = scheduler.unschedule(agentId);
    expect(removed).toBe(true);

    const countAtUnschedule = fired.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(fired.length).toBe(countAtUnschedule);

    await scheduler.stop();
  });

  it("unschedule returns false for an unknown agent", () => {
    const scheduler = new TimerScheduler();
    expect(scheduler.unschedule(makeAgentId("nobody"))).toBe(false);
  });

  it("schedule replaces an existing entry (idempotent per agent)", async () => {
    vi.useFakeTimers();
    const scheduler = new TimerScheduler();
    const agentId = makeAgentId("replaceable");

    const fired: ScheduledWakeEvent[] = [];
    scheduler.onWake((event) => {
      fired.push(event);
    });

    scheduler.schedule(agentId, { kind: "interval", intervalMs: 100 });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(250);
    const firstPhaseCount = fired.length;
    expect(firstPhaseCount).toBeGreaterThan(0);

    // Replace with a longer interval; old timer must be cleared.
    scheduler.schedule(agentId, { kind: "interval", intervalMs: 10_000 });

    await vi.advanceTimersByTimeAsync(500);
    // No new fires in the next 500ms because the new interval is 10s.
    expect(fired.length).toBe(firstPhaseCount);

    await scheduler.stop();
  });

  it("stop clears all timers and prevents firing", async () => {
    vi.useFakeTimers();
    const scheduler = new TimerScheduler();
    const agentId = makeAgentId("stoppable");

    const fired: ScheduledWakeEvent[] = [];
    scheduler.onWake((event) => {
      fired.push(event);
    });

    scheduler.schedule(agentId, { kind: "interval", intervalMs: 50 });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(120);
    expect(fired.length).toBeGreaterThan(0);

    await scheduler.stop();

    const beforeAdvance = fired.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(fired.length).toBe(beforeAdvance);
  });

  it("start is idempotent (double-start does not double-fire)", async () => {
    vi.useFakeTimers();
    const scheduler = new TimerScheduler();
    const agentId = makeAgentId("double-started");

    const fired: ScheduledWakeEvent[] = [];
    scheduler.onWake((event) => {
      fired.push(event);
    });

    scheduler.schedule(agentId, { kind: "interval", intervalMs: 100 });
    scheduler.start();
    scheduler.start();
    scheduler.start();

    await vi.advanceTimersByTimeAsync(250);
    // Should be exactly 2 fires (at 100 and 200), not 6.
    expect(fired.length).toBe(2);

    await scheduler.stop();
  });

  it("each fire mints a unique WakeId", async () => {
    vi.useFakeTimers();
    const scheduler = new TimerScheduler();
    const agentId = makeAgentId("unique-wakes");

    const fired: ScheduledWakeEvent[] = [];
    scheduler.onWake((event) => {
      fired.push(event);
    });

    scheduler.schedule(agentId, { kind: "interval", intervalMs: 100 });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(350);
    const wakeIds = fired.map((e) => e.wakeId.value);
    expect(new Set(wakeIds).size).toBe(wakeIds.length);

    await scheduler.stop();
  });
});
