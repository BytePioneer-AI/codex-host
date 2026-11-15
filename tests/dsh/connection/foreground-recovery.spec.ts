// @vitest-environment jsdom
import type { Context } from "@deepseek-ai/cordis";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  installConnection,
  type ConnectionHandle,
} from "../../../apps/web-ui/packages/client/connection/src/client/index.ts";

let visibility: DocumentVisibilityState;
let online: boolean;
let stop: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  online = true;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
});
afterEach(async () => {
  stop?.();
  stop = undefined;
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
}
function start() {
  let connection!: ConnectionHandle;
  installConnection({
    provide: (_name: string, value: ConnectionHandle) => {
      connection = value;
    },
  } as unknown as Context);
  const attempts: Array<{ signal: AbortSignal; ready(): void; fail(): void }> = [];
  connection.registerGenerationSource(async (signal, ready) => {
    const ended = Promise.withResolvers<void>();
    attempts.push({
      signal,
      ready: () => ready({ home: "/test" }),
      fail: () => ended.reject(new Error("socket closed")),
    });
    signal.addEventListener("abort", () => ended.resolve(), { once: true });
    await ended.promise;
  });
  const probe = vi.fn(() => true);
  const reconnect = vi.fn();
  stop = connection.start({ onProbeRequested: probe, onReconnectRequested: reconnect }).stop;
  return { connection, attempts, probe, reconnect };
}

it("keeps a healthy background generation and probes it on return without reopening", async () => {
  const { connection, attempts, probe, reconnect } = start();
  await vi.advanceTimersByTimeAsync(0);
  attempts[0]!.ready();
  await vi.advanceTimersByTimeAsync(0);
  const generation = connection.generation.getSnapshot();
  setVisibility("hidden");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(attempts[0]!.signal.aborted).toBe(false);
  expect(connection.generation.getSnapshot()).toBe(generation);
  setVisibility("visible");
  window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  await vi.advanceTimersByTimeAsync(0);
  expect(probe).toHaveBeenCalledOnce();
  expect(reconnect).not.toHaveBeenCalled();
  expect(attempts).toHaveLength(1);
  expect(connection.generation.getSnapshot()).toBe(generation);
});

it("parks a lost background connection until foreground, then retries once immediately", async () => {
  const { connection, attempts, reconnect } = start();
  await vi.advanceTimersByTimeAsync(0);
  attempts[0]!.ready();
  await vi.advanceTimersByTimeAsync(0);
  setVisibility("hidden");
  attempts[0]!.fail();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(attempts).toHaveLength(1);
  expect(reconnect).not.toHaveBeenCalled();
  expect(connection.generation.getSnapshot()).toBeUndefined();
  expect(connection.state.getSnapshot()).toBe("connecting");
  // An online event in the background must not start an attempt either.
  online = false;
  window.dispatchEvent(new Event("offline"));
  online = true;
  window.dispatchEvent(new Event("online"));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(attempts).toHaveLength(1);
  setVisibility("visible");
  await vi.advanceTimersByTimeAsync(0);
  expect(attempts).toHaveLength(2);
  expect(reconnect).toHaveBeenCalledOnce();
  attempts[1]!.ready();
  await vi.advanceTimersByTimeAsync(0);
  expect(connection.state.getSnapshot()).toBe("connected");
});

it("defers a hidden page's initial generation until it is visible", async () => {
  visibility = "hidden";
  const { attempts } = start();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(attempts).toHaveLength(0);
  setVisibility("visible");
  await vi.advanceTimersByTimeAsync(0);
  expect(attempts).toHaveLength(1);
});

it.each([4_000, 60_000])(
  "only replaces an expired handshake after a frozen %sms background interval",
  async (elapsed) => {
    const { connection, attempts } = start();
    await vi.advanceTimersByTimeAsync(0);
    setVisibility("hidden");
    // Move wall time without running timers, as on a suspended phone.
    vi.setSystemTime(Date.now() + elapsed);
    setVisibility("visible");
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    await vi.advanceTimersByTimeAsync(0);
    const expired = elapsed >= 15_000;
    expect(attempts).toHaveLength(expired ? 2 : 1);
    expect(attempts[0]!.signal.aborted).toBe(expired);
    const current = attempts.at(-1)!;
    current.ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.state.getSnapshot()).toBe("connected");
  },
);

it("does not retry a timed-out background handshake until the page returns", async () => {
  const { attempts } = start();
  await vi.advanceTimersByTimeAsync(0);
  setVisibility("hidden");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(attempts).toHaveLength(1);
  expect(attempts[0]!.signal.aborted).toBe(true);
  setVisibility("visible");
  await vi.advanceTimersByTimeAsync(0);
  expect(attempts).toHaveLength(2);
});

it("does not resume a parked connection after disposal", async () => {
  visibility = "hidden";
  const { attempts } = start();
  await vi.advanceTimersByTimeAsync(0);
  stop!();
  setVisibility("visible");
  window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(attempts).toHaveLength(0);
});
