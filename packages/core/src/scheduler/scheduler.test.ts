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

  // -------------------------------------------------------------------
  // Cron (2D4)
  // -------------------------------------------------------------------

  it("cron — fires at the next matching minute, then re-arms", async () => {
    // Anchor the test clock at 2026-04-09 12:00:00 UTC so the cron
    // deltas are deterministic and don't depend on whatever day the
    // CI machine is on.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-09T12:00:00.000Z"));

    const scheduler = new TimerScheduler();
    const agentId = makeAgentId("cron-every-minute");

    const fired: ScheduledWakeEvent[] = [];
    scheduler.onWake((event) => {
      fired.push(event);
    });

    // `* * * * *` — every minute, at second 0.
    scheduler.schedule(agentId, { kind: "cron", expression: "* * * * *" });
    scheduler.start();

    // Before the next minute rolls, nothing should have fired.
    expect(fired).toHaveLength(0);

    // Advance to the first minute boundary (60s from now).
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fired).toHaveLength(1);
    expect(fired[0]?.wakeReason).toEqual({
      kind: "scheduled",
      cronExpression: "* * * * *",
    });

    // Re-arm kicks the next timeout. Advance another full minute.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fired).toHaveLength(2);

    // And a third, to prove the re-arm loop keeps going.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fired).toHaveLength(3);

    await scheduler.stop();
  });

  it("cron — respects the parsed next-fire time when expression has larger cadence", async () => {
    // Anchor at 2026-04-09 17:45:00 UTC (a Thursday). The research-agent
    // example uses `0 18 * * 0` (Sunday 18:00 UTC). Next fire after
    // Thursday 17:45 is Sunday 2026-04-12 18:00 — that's 3 days + 15m:
    //   72h * 3600s * 1000ms + 15m * 60s * 1000ms = 260_100_000 ms.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-09T17:45:00.000Z"));

    const scheduler = new TimerScheduler();
    const agentId = makeAgentId("cron-weekly");

    const fired: ScheduledWakeEvent[] = [];
    scheduler.onWake((event) => {
      fired.push(event);
    });

    scheduler.schedule(agentId, { kind: "cron", expression: "0 18 * * 0" });
    scheduler.start();

    // Nothing fires in the first hour.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(fired).toHaveLength(0);

    // Advance to just before Sunday 18:00 UTC — one ms shy of the
    // 260_100_000 ms delta, minus the hour we already advanced.
    const TOTAL_DELTA_MS = 260_100_000;
    await vi.advanceTimersByTimeAsync(TOTAL_DELTA_MS - 60 * 60 * 1000 - 1);
    expect(fired).toHaveLength(0);

    // One more ms lands us on the boundary.
    await vi.advanceTimersByTimeAsync(1);
    expect(fired).toHaveLength(1);

    await scheduler.stop();
  });

  it("cron — stop clears the pending timer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-09T12:00:00.000Z"));

    const scheduler = new TimerScheduler();
    const agentId = makeAgentId("cron-stop");

    const fired: ScheduledWakeEvent[] = [];
    scheduler.onWake((event) => {
      fired.push(event);
    });

    scheduler.schedule(agentId, { kind: "cron", expression: "* * * * *" });
    scheduler.start();
    await scheduler.stop();

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fired).toHaveLength(0);
  });

  it("cron — unschedule prevents the re-arm loop from continuing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-09T12:00:00.000Z"));

    const scheduler = new TimerScheduler();
    const agentId = makeAgentId("cron-unsub");

    const fired: ScheduledWakeEvent[] = [];
    scheduler.onWake((event) => {
      fired.push(event);
    });

    scheduler.schedule(agentId, { kind: "cron", expression: "* * * * *" });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fired).toHaveLength(1);

    scheduler.unschedule(agentId);

    // Nothing fires in the next 5 minutes because the entry is gone.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fired).toHaveLength(1);

    await scheduler.stop();
  });

  it("cron — tz option shifts the fire time to the named timezone", async () => {
    // "30 0 * * *" = daily at 00:30. With tz=America/Vancouver (PDT
    // = UTC-7), 00:30 PDT = 07:30 UTC.
    //
    // Anchor at 2026-04-10 07:29:00 UTC = 00:29 PDT. Next fire at
    // 00:30 PDT = 07:30 UTC — exactly 1 minute away.
    //
    // Without tz (defaulting to UTC), next 00:30 UTC is ~17h away.
    // By advancing only 60s, we prove the tz=Vancouver path fires
    // at the Vancouver time, not UTC.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T07:29:00.000Z"));

    const scheduler = new TimerScheduler();
    const agentId = makeAgentId("cron-tz");

    const fired: ScheduledWakeEvent[] = [];
    scheduler.onWake((event) => {
      fired.push(event);
    });

    scheduler.schedule(agentId, {
      kind: "cron",
      expression: "30 0 * * *",
      tz: "America/Vancouver",
    });
    scheduler.start();

    // 59s — not yet at 00:30 PDT.
    await vi.advanceTimersByTimeAsync(59_000);
    expect(fired).toHaveLength(0);

    // 1 more second — 07:30:00 UTC = 00:30:00 PDT. Fire.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fired).toHaveLength(1);

    await scheduler.stop();
  });
});
