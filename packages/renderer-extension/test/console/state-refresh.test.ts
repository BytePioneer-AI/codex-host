import { afterEach, describe, expect, it, vi } from "vitest";
import { consoleGet, consolePost } from "../../src/console/api.js";
import { ConsoleState, type ConsoleOverview } from "../../src/console/state.js";
import { hostPage } from "../../src/console/pages/host-required.js";
import { consoleMessages } from "../../src/console/messages.js";
import type { RendererSettingsPageMountContext } from "../../src/settings/core.js";

vi.mock("../../src/console/api.js", () => ({ consoleGet: vi.fn(), consolePost: vi.fn() }));
vi.mock("../../src/console/dom.js", () => ({ h: () => ({}), button: () => ({}) }));
vi.mock("../../src/settings/icons.js", () => ({ createRendererSettingsIcon: () => null }));

function overview(
  state: ConsoleOverview["summary"]["state"] = "running",
  hostAvailable = true,
): ConsoleOverview {
  return {
    console: { version: "test", distribution: null },
    inspect: null,
    startup: [],
    controller: null,
    launchAvailable: true,
    summary: { state, detail: null },
    issueUrl: "",
    hostAvailable,
  };
}
function setup(value = overview()) {
  vi.useFakeTimers();
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  vi.mocked(consoleGet).mockReset().mockResolvedValue(value);
  vi.mocked(consolePost).mockReset().mockResolvedValue(null);
  const state = new ConsoleState();
  return {
    state,
    document,
    visible(value: boolean) {
      document.visibilityState = value ? "visible" : "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
    },
  };
}
const settle = () => vi.advanceTimersByTimeAsync(0);
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Console availability refresh", () => {
  it("uses slow stable queries, pauses while hidden and refreshes immediately on return", async () => {
    const b = setup();
    b.state.start();
    await settle();
    expect(consoleGet).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(consoleGet).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(consoleGet).toHaveBeenCalledTimes(2);
    b.visible(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(consoleGet).toHaveBeenCalledTimes(2);
    b.visible(true);
    b.visible(true);
    await settle();
    expect(consoleGet).toHaveBeenCalledTimes(3);
    b.state.stop();
    b.visible(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(consoleGet).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps fast startup and failure recovery, and updates Host-dependent pages outside overview", async () => {
    const b = setup(overview("starting", false));
    b.state.start();
    await settle();
    const mount = vi.fn();
    const cleanup = hostPage(
      { id: "test", label: "Test", icon: "dashboard", mount },
      consoleMessages("zh-CN"),
      b.state,
    ).mount({
      content: { ownerDocument: {}, replaceChildren: vi.fn(), append: vi.fn() },
    } as unknown as RendererSettingsPageMountContext);
    expect(mount).not.toHaveBeenCalled();
    vi.mocked(consoleGet).mockResolvedValue(overview());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mount).toHaveBeenCalledOnce();
    expect(b.state.overview?.summary.state).toBe("running");
    vi.mocked(consoleGet).mockRejectedValueOnce(new Error("offline"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(b.state.offline).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(b.state.offline).toBe(false);
    expect(consoleGet).toHaveBeenCalledTimes(4);
    cleanup?.();
    b.state.stop();
  });

  it("coalesces manual and visibility refreshes with the pending read", async () => {
    const b = setup();
    let resolve: (value: ConsoleOverview) => void = () => {};
    vi.mocked(consoleGet).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    b.state.start();
    const first = b.state.refresh();
    expect(b.state.refresh()).toBe(first);
    b.visible(false);
    b.visible(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(consoleGet).toHaveBeenCalledOnce();
    resolve(overview());
    await settle();
    expect(vi.getTimerCount()).toBe(1);
    b.state.stop();
  });

  it("discards late results after stop and allows a fresh lifecycle to start", async () => {
    const b = setup();
    let resolve: (value: ConsoleOverview) => void = () => {};
    vi.mocked(consoleGet).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const listener = vi.fn();
    b.state.subscribe(listener);
    b.state.start();
    b.state.stop();
    b.state.start();
    await settle();
    const calls = listener.mock.calls.length;
    resolve(overview("startup-failed", false));
    await settle();
    expect(b.state.overview?.summary.state).toBe("running");
    expect(listener).toHaveBeenCalledTimes(calls);
    expect(consolePost).toHaveBeenCalledOnce();
    b.state.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a stalled availability read and keeps the fast recovery check", async () => {
    const b = setup();
    const request = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(request.signal);
    vi.mocked(consoleGet).mockImplementationOnce(
      (_path, signal) =>
        new Promise((_, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("deadline")), { once: true });
        }),
    );
    b.state.start();
    expect(timeout).toHaveBeenCalledWith(8_000);
    request.abort();
    await settle();
    expect(b.state.offline).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(b.state.offline).toBe(false);
    b.state.stop();
  });
});
