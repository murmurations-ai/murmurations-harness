import { describe, it, expect } from "vitest";
import { DaemonSocket } from "./socket.js";
import { createConnection } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const makeSocketPath = (): string =>
  join(tmpdir(), `murmuration-test-${randomUUID().slice(0, 8)}.sock`);

const connectAndRead = (
  socketPath: string,
): Promise<{ lines: string[]; write: (data: string) => void; close: () => void }> =>
  new Promise((resolve) => {
    const lines: string[] = [];
    let buffer = "";
    const conn = createConnection(socketPath, () => {
      resolve({
        lines,
        write: (data: string) => conn.write(data),
        close: () => conn.destroy(),
      });
    });
    conn.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        if (part.trim()) lines.push(part);
      }
    });
  });

describe("DaemonSocket", () => {
  it("handles request/response", async () => {
    const socketPath = makeSocketPath();
    const socket = new DaemonSocket(socketPath, (method) => {
      if (method === "ping") return Promise.resolve({ pong: true });
      return Promise.reject(new Error("unknown"));
    });
    socket.start();

    try {
      const client = await connectAndRead(socketPath);
      client.write('{"id":"1","method":"ping"}\n');
      await new Promise((r) => setTimeout(r, 50));

      expect(client.lines.length).toBeGreaterThanOrEqual(1);
      const resp = JSON.parse(client.lines[client.lines.length - 1] ?? "{}") as {
        id: string;
        result?: unknown;
      };
      expect(resp.id).toBe("1");
      expect(resp.result).toEqual({ pong: true });

      client.close();
    } finally {
      socket.stop();
    }
  });

  it("returns error for invalid JSON", async () => {
    const socketPath = makeSocketPath();
    const socket = new DaemonSocket(socketPath, () => Promise.resolve({}));
    socket.start();

    try {
      const client = await connectAndRead(socketPath);
      client.write("not json\n");
      await new Promise((r) => setTimeout(r, 50));

      const resp = JSON.parse(client.lines[client.lines.length - 1] ?? "{}") as {
        error?: string;
      };
      expect(resp.error).toBe("invalid JSON");

      client.close();
    } finally {
      socket.stop();
    }
  });

  it("broadcasts events to connected clients", async () => {
    const socketPath = makeSocketPath();
    const socket = new DaemonSocket(socketPath, () => Promise.resolve({}));
    socket.start();

    try {
      const client = await connectAndRead(socketPath);
      await new Promise((r) => setTimeout(r, 20));

      socket.broadcast("test.event", { value: 42 });
      await new Promise((r) => setTimeout(r, 50));

      const evt = JSON.parse(client.lines[client.lines.length - 1] ?? "{}") as {
        event?: string;
        data?: { value?: number };
      };
      expect(evt.event).toBe("test.event");
      expect(evt.data?.value).toBe(42);

      client.close();
    } finally {
      socket.stop();
    }
  });

  it("replays ring buffer to new clients", async () => {
    const socketPath = makeSocketPath();
    const socket = new DaemonSocket(socketPath, () => Promise.resolve({}));
    socket.start();

    try {
      // Broadcast events before any client connects
      socket.broadcast("event.one", { n: 1 });
      socket.broadcast("event.two", { n: 2 });

      // Now connect — should receive replayed events
      const client = await connectAndRead(socketPath);
      await new Promise((r) => setTimeout(r, 50));

      expect(client.lines.length).toBeGreaterThanOrEqual(2);
      const events = client.lines.map((l) => (JSON.parse(l) as { event?: string }).event);
      expect(events).toContain("event.one");
      expect(events).toContain("event.two");

      client.close();
    } finally {
      socket.stop();
    }
  });

  it("ring buffer caps at 50 events", async () => {
    const socketPath = makeSocketPath();
    const socket = new DaemonSocket(socketPath, () => Promise.resolve({}));
    socket.start();

    try {
      // Broadcast 60 events
      for (let i = 0; i < 60; i++) {
        socket.broadcast("bulk", { i });
      }

      // Connect — should receive only last 50
      const client = await connectAndRead(socketPath);
      await new Promise((r) => setTimeout(r, 100));

      // Should have exactly 50 replayed events
      expect(client.lines.length).toBe(50);

      // First replayed should be event #10 (first 10 dropped)
      const first = JSON.parse(client.lines[0] ?? "{}") as { data?: { i?: number } };
      expect(first.data?.i).toBe(10);

      client.close();
    } finally {
      socket.stop();
    }
  });
});
