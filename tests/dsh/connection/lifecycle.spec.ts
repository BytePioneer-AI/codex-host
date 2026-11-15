// @vitest-environment jsdom
import type { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import {
  installConnection,
  type ConnectionHandle,
} from "../../../apps/web-ui/packages/client/connection/src/client/index.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("coalesces foreground restoration into a fresh generation and suspends retries offline", async () => {
  vi.useFakeTimers();
  let visibility = "visible";
  let online = true;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility as DocumentVisibilityState,
  );
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
  let connection!: ConnectionHandle;
  const ctx = {
    provide: (_name: string, handle: ConnectionHandle) => {
      connection = handle;
    },
  } as unknown as Context;
  installConnection(ctx);
  const opened = vi.fn();
  const stopped = vi.fn();
  connection.registerGenerationSource(async (signal, ready) => {
    opened();
    ready({ home: "/home/test" });
    await new Promise<void>((resolve) =>
      signal.addEventListener(
        "abort",
        () => {
          stopped();
          resolve();
        },
        { once: true },
      ),
    );
  });
  const reconnect = vi.fn();
  const loop = connection.start({ onReconnectRequested: reconnect });
  await vi.advanceTimersByTimeAsync(0);
  expect(connection.state.getSnapshot()).toBe("connected");
  const firstGeneration = connection.generation.getSnapshot()!.id;
  visibility = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(opened).toHaveBeenCalledOnce();
  visibility = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  await vi.advanceTimersByTimeAsync(0);
  expect(connection.generation.getSnapshot()!.id).toBeGreaterThan(firstGeneration);
  expect(reconnect).toHaveBeenCalledOnce();
  expect(stopped).toHaveBeenCalledOnce();
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(reconnect).toHaveBeenCalledOnce();
  online = false;
  window.dispatchEvent(new Event("offline"));
  expect(connection.state.getSnapshot()).toBe("disconnected");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(opened).toHaveBeenCalledTimes(2);
  online = true;
  window.dispatchEvent(new Event("online"));
  await vi.advanceTimersByTimeAsync(0);
  expect(connection.state.getSnapshot()).toBe("connected");
  expect(opened).toHaveBeenCalledTimes(3);
  loop.stop();
  await vi.advanceTimersByTimeAsync(0);
  visibility = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  visibility = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  await vi.advanceTimersByTimeAsync(1000);
  expect(opened).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
});

it("coalesces tab and cached-page restoration, keeping a live generation unless it cannot probe", async () => {
  vi.useFakeTimers();
  let visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility as DocumentVisibilityState,
  );
  const returnToTab = () => {
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
  };
  let connection!: ConnectionHandle;
  installConnection({
    provide: (_name: string, handle: ConnectionHandle) => {
      connection = handle;
    },
  } as unknown as Context);
  const opened = vi.fn();
  connection.registerGenerationSource(async (signal, ready) => {
    opened();
    ready({ home: "/home/test" });
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  });
  const probe = vi.fn(() => true);
  const states: unknown[] = [];
  const loop = connection.start({
    onProbeRequested: probe,
    onStateChange: (state) => states.push(state),
  });
  await vi.advanceTimersByTimeAsync(0);
  const generation = connection.generation.getSnapshot();
  states.length = 0;

  returnToTab();
  returnToTab();
  await vi.advanceTimersByTimeAsync(0);
  expect(probe).toHaveBeenCalledOnce();
  expect(opened).toHaveBeenCalledOnce();
  expect(connection.generation.getSnapshot()).toBe(generation);
  expect(states).toEqual([]);

  // A queued restore must not probe if the page hides again before it runs.
  returnToTab();
  visibility = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  await vi.advanceTimersByTimeAsync(0);
  expect(probe).toHaveBeenCalledOnce();
  visibility = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  await vi.advanceTimersByTimeAsync(0);
  expect(probe).toHaveBeenCalledTimes(2);
  expect(opened).toHaveBeenCalledOnce();
  expect(connection.generation.getSnapshot()).toBe(generation);
  expect(states).toEqual([]);

  probe.mockReturnValue(false);
  returnToTab();
  await vi.advanceTimersByTimeAsync(0);
  expect(probe).toHaveBeenCalledTimes(3);
  expect(opened).toHaveBeenCalledTimes(2);
  // Stop must cancel a restoration already queued for the next task.
  returnToTab();
  loop.stop();
  await vi.advanceTimersByTimeAsync(0);
  expect(probe).toHaveBeenCalledTimes(3);
  expect(opened).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("skips background retry backoff once on foreground return without interrupting handshakes", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  let visibility: DocumentVisibilityState = "visible";
  let online = true;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
  const setVisibility = (next: DocumentVisibilityState) => {
    visibility = next;
    document.dispatchEvent(new Event("visibilitychange"));
  };
  let connection!: ConnectionHandle;
  installConnection({
    provide: (_name: string, handle: ConnectionHandle) => {
      connection = handle;
    },
  } as unknown as Context);
  const attempts: Array<{ signal: AbortSignal; fail: () => void; ready: () => void }> = [];
  connection.registerGenerationSource(async (signal, ready) => {
    const ended = Promise.withResolvers<void>();
    const attempt = {
      signal,
      fail: () => ended.reject(new Error("socket lost")),
      ready: () => ready({ home: "/home/test" }),
    };
    attempts.push(attempt);
    signal.addEventListener("abort", () => ended.resolve(), { once: true });
    if (attempts.length === 1) attempt.ready();
    await ended.promise;
  });
  const loop = connection.start({});
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.state.getSnapshot()).toBe("connected");
    attempts[0]!.fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toHaveLength(2); // First reconnect is already immediate.
    attempts[1]!.fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toHaveLength(2); // Now waiting for retry backoff.
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts).toHaveLength(2);

    // Cache restoration and visibility events may arrive in either order.
    visibility = "visible";
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toHaveLength(3);
    expect(attempts[2]!.signal.aborted).toBe(false);
    setVisibility("hidden");
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toHaveLength(3);
    expect(attempts[2]!.signal.aborted).toBe(false);

    attempts[2]!.fail();
    await vi.advanceTimersByTimeAsync(0);
    // Duplicate restore events cannot repeatedly bypass backoff after a failed retry.
    setVisibility("visible");
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    await vi.advanceTimersByTimeAsync(249);
    expect(attempts).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toHaveLength(4);
    attempts[3]!.fail();
    await vi.advanceTimersByTimeAsync(0);
    setVisibility("hidden");
    setVisibility("visible");
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toHaveLength(5);
    attempts[4]!.ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.state.getSnapshot()).toBe("connected");

    online = false;
    window.dispatchEvent(new Event("offline"));
    setVisibility("hidden");
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempts).toHaveLength(5);
    expect(connection.state.getSnapshot()).toBe("disconnected");
  } finally {
    loop.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  }
});

it("does not replace an initial handshake when a cached-page restore arrives", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  let connection!: ConnectionHandle;
  installConnection({
    provide: (_name: string, handle: ConnectionHandle) => {
      connection = handle;
    },
  } as unknown as Context);
  const opened = vi.fn();
  let reportReady!: () => void;
  connection.registerGenerationSource(async (signal, ready) => {
    opened();
    reportReady = () => ready({ home: "/home/test" });
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  });
  const reconnect = vi.fn();
  const loop = connection.start({ onReconnectRequested: reconnect });
  await vi.advanceTimersByTimeAsync(0);
  window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  await vi.advanceTimersByTimeAsync(0);
  expect(opened).toHaveBeenCalledOnce();
  expect(reconnect).not.toHaveBeenCalled();
  reportReady();
  await vi.advanceTimersByTimeAsync(0);
  expect(connection.state.getSnapshot()).toBe("connected");
  loop.stop();
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
});
