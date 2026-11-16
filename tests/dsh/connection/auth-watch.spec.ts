// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
import type { ConnectionState } from "@deepseek-ai/dsh-client-connection/client";
import {
  computerOffline,
  watchAuthentication,
} from "../../../apps/web-ui/packages/client/ui-codexhost/src/client/auth-watch.ts";

let visibility: DocumentVisibilityState;
let stop: (() => void) | undefined;
const fetcher = vi.fn<typeof fetch>();
const reload = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("window", {
    location: { reload },
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    dispatchEvent: window.dispatchEvent.bind(window),
  });
  fetcher.mockReset().mockResolvedValue(new Response(null, { status: 502 }));
  reload.mockClear();
});
afterEach(() => {
  stop?.();
  stop = undefined;
  expect(vi.getTimerCount()).toBe(0);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

it("does not probe or accumulate offline evidence while hidden, and starts fresh on return", async () => {
  visibility = "hidden";
  const state = createSnapshotStore<ConnectionState>("connecting");
  stop = watchAuthentication(state);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fetcher).not.toHaveBeenCalled();
  expect(computerOffline.getSnapshot()).toBe(false);

  setVisibility("visible");
  await vi.advanceTimersByTimeAsync(5_000);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(computerOffline.getSnapshot()).toBe(false);
  setVisibility("hidden");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fetcher).toHaveBeenCalledTimes(2);
  setVisibility("visible");
  await vi.advanceTimersByTimeAsync(9_999);
  expect(computerOffline.getSnapshot()).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(computerOffline.getSnapshot()).toBe(true);
  setVisibility("hidden");
  expect(computerOffline.getSnapshot()).toBe(false);
  fetcher.mockResolvedValue(new Response(null, { status: 200 }));
  setVisibility("visible");
  await vi.advanceTimersByTimeAsync(0);
  expect(computerOffline.getSnapshot()).toBe(false);
});

it.each([200, 401, 502])(
  "ignores a stale %s response after suspension and probes immediately on return",
  async (status) => {
    const old = Promise.withResolvers<Response>();
    fetcher.mockReturnValueOnce(old.promise);
    const state = createSnapshotStore<ConnectionState>("connecting");
    stop = watchAuthentication(state);
    const oldSignal = fetcher.mock.calls[0]![1]!.signal!;
    setVisibility("hidden");
    expect(oldSignal.aborted).toBe(true);
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(2);
    old.resolve(new Response(null, { status }));
    await vi.advanceTimersByTimeAsync(0);
    expect(reload).not.toHaveBeenCalled();
    // The old result cannot reset or add evidence to the fresh foreground probes.
    await vi.advanceTimersByTimeAsync(9_999);
    expect(computerOffline.getSnapshot()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(computerOffline.getSnapshot()).toBe(true);
  },
);

it("cancels an in-flight probe on reconnection and disposal", async () => {
  fetcher.mockImplementation(() => new Promise(() => {}));
  const state = createSnapshotStore<ConnectionState>("connecting");
  stop = watchAuthentication(state);
  const first = fetcher.mock.calls[0]![1]!.signal!;
  state.set("connected");
  expect(first.aborted).toBe(true);
  state.set("connecting");
  const second = fetcher.mock.calls[1]![1]!.signal!;
  stop();
  expect(second.aborted).toBe(true);
  setVisibility("hidden");
  setVisibility("visible");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("starts only one probe when foreground restoration changes the connection state first", async () => {
  visibility = "hidden";
  const state = createSnapshotStore<ConnectionState>("disconnected");
  const restoreConnection = () => {
    if (document.visibilityState === "visible") state.set("connecting");
  };
  document.addEventListener("visibilitychange", restoreConnection);
  try {
    stop = watchAuthentication(state);
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledOnce();
  } finally {
    document.removeEventListener("visibilitychange", restoreConnection);
  }
});

it("resumes probing on cached-page restoration even before visibilitychange arrives", async () => {
  visibility = "hidden";
  stop = watchAuthentication(createSnapshotStore<ConnectionState>("connecting"));
  visibility = "visible";
  window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  await vi.advanceTimersByTimeAsync(0);
  expect(fetcher).toHaveBeenCalledOnce();
  setVisibility("visible");
  window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  await vi.advanceTimersByTimeAsync(0);
  expect(fetcher).toHaveBeenCalledOnce();
});

it("still reloads for a current foreground 401", async () => {
  fetcher.mockResolvedValue(new Response(null, { status: 401 }));
  stop = watchAuthentication(createSnapshotStore<ConnectionState>("connecting"));
  await vi.advanceTimersByTimeAsync(0);
  expect(reload).toHaveBeenCalledOnce();
});

it("counts two timed-out foreground windows as offline without overlapping probes", async () => {
  fetcher.mockImplementation(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options!.signal!.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      }),
  );
  stop = watchAuthentication(createSnapshotStore<ConnectionState>("connecting"));
  await vi.advanceTimersByTimeAsync(9_999);
  expect(computerOffline.getSnapshot()).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(3);
  expect(computerOffline.getSnapshot()).toBe(true);
});
