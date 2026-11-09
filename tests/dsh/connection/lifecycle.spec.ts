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
  await vi.advanceTimersByTimeAsync(500);
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

it("keeps a live connection on tab return and replaces it for a cached page or failed probe", async () => {
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

  returnToTab();
  window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  await vi.advanceTimersByTimeAsync(0);
  expect(probe).toHaveBeenCalledOnce();
  expect(opened).toHaveBeenCalledTimes(2);

  probe.mockReturnValue(false);
  returnToTab();
  await vi.advanceTimersByTimeAsync(0);
  expect(probe).toHaveBeenCalledTimes(2);
  expect(opened).toHaveBeenCalledTimes(3);
  loop.stop();
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
});
