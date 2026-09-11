import { describe, expect, test, mock } from "bun:test";
import { EventPipeline, shouldStream, isImmediate } from "../../src/events.ts";
import type { AlmadelClient } from "../../src/http.ts";

function fakeClient(onPush?: (ticket: string, body: unknown) => Promise<unknown>): AlmadelClient {
  return {
    pushEvents: onPush ?? (async () => {}),
  } as unknown as AlmadelClient;
}

describe("event filter", () => {
  test("streams only the allowed kinds", () => {
    expect(shouldStream("message.updated")).toBe(true);
    expect(shouldStream("tool.execute.before")).toBe(true);
    expect(shouldStream("session.idle")).toBe(true);
    expect(shouldStream("session.created")).toBe(false);
    expect(shouldStream("random")).toBe(false);
  });

  test("permission/error/idle flush immediately", () => {
    expect(isImmediate("permission.asked")).toBe(true);
    expect(isImmediate("session.error")).toBe(true);
    expect(isImmediate("session.idle")).toBe(true);
    expect(isImmediate("message.updated")).toBe(false);
  });
});

describe("EventPipeline", () => {
  test("batches non-immediate events and flushes via timer", async () => {
    const pushed: unknown[] = [];
    const client = fakeClient(async (_t, body) => {
      pushed.push(body);
    });
    const p = new EventPipeline(client, "t1");

    p.enqueue("message.updated", { text: "a" });
    p.enqueue("message.updated", { text: "b" });

    expect(pushed.length).toBe(0);

    await new Promise((r) => setTimeout(r, 400));
    expect(pushed.length).toBe(1);
  });

  test("immediate events flush right away", async () => {
    const pushed: unknown[] = [];
    const client = fakeClient(async (_t, body) => {
      pushed.push(body);
    });
    const p = new EventPipeline(client, "t1");

    p.enqueue("session.error", { error: "boom" });
    await new Promise((r) => setTimeout(r, 10));
    expect(pushed.length).toBe(1);
  });

  test("never throws into the session on push failure", async () => {
    let calls = 0;
    const client = fakeClient(async () => {
      calls += 1;
      throw new Error("down");
    });
    const p = new EventPipeline(client, "t1");

    expect(() => p.enqueue("session.error", { error: "x" })).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBeGreaterThan(0);
  });
});
