import { describe, expect, it } from "vitest";

import {
  installOverlayThreadIsolation,
  isAvatarOverlayHref,
  notificationThreadId,
  overlayBlocksHostNotification,
  type OverlayIsolationMessageEvent,
  type OverlayIsolationTarget,
} from "../src/renderer-overlay-thread-isolation.js";

class FakeOverlayWindow implements OverlayIsolationTarget {
  readonly listeners = new Map<boolean, Set<(event: OverlayIsolationMessageEvent) => void>>();
  constructor(readonly location: { href: string }) {}

  addEventListener(
    type: "message",
    listener: (event: OverlayIsolationMessageEvent) => void,
    options?: boolean | { capture?: boolean },
  ): void {
    if (type !== "message") return;
    const capture = options === true || (typeof options === "object" && options.capture === true);
    const set = this.listeners.get(capture) ?? new Set();
    set.add(listener);
    this.listeners.set(capture, set);
  }

  removeEventListener(
    type: "message",
    listener: (event: OverlayIsolationMessageEvent) => void,
    options?: boolean | { capture?: boolean },
  ): void {
    const capture = options === true || (typeof options === "object" && options.capture === true);
    this.listeners.get(capture)?.delete(listener);
  }

  dispatch(data: unknown): boolean {
    let stopped = false;
    const event: OverlayIsolationMessageEvent = {
      data,
      stopImmediatePropagation() {
        stopped = true;
      },
    };
    for (const listener of this.listeners.get(true) ?? []) {
      listener(event);
      if (stopped) return true;
    }
    for (const listener of this.listeners.get(false) ?? []) {
      listener(event);
      if (stopped) return true;
    }
    return false;
  }
}

const overlayHref = "app://-/index.html?initialRoute=%2Favatar-overlay";

describe("overlay thread isolation", () => {
  it("keeps delivering later text turns for a voice Thread after hangup", () => {
    const overlay = new FakeOverlayWindow({ href: overlayHref });
    const hook = installOverlayThreadIsolation(overlay);
    const dispatch = (method: string, params: Record<string, unknown>) =>
      overlay.dispatch({ type: "mcp-notification", method, params });
    dispatch("thread/realtime/started", { threadId: "known-thread" });
    dispatch("turn/started", { threadId: "known-thread", turn: { id: "voice-turn" } });
    dispatch("thread/realtime/closed", { threadId: "known-thread" });
    dispatch("turn/completed", { threadId: "known-thread", turn: { id: "voice-turn" } });
    dispatch("thread/realtime/started", { threadId: "another-voice-thread" });
    expect(
      dispatch("turn/started", { threadId: "known-thread", turn: { id: "later-text-turn" } }),
    ).toBe(false);
    expect(
      dispatch("item/completed", { threadId: "known-thread", turnId: "later-text-turn" }),
    ).toBe(false);
    expect(
      dispatch("turn/completed", { threadId: "known-thread", turn: { id: "later-text-turn" } }),
    ).toBe(false);
    expect(dispatch("turn/started", { threadId: "unknown-cli-thread" })).toBe(true);
    dispatch("thread/deleted", { threadId: "known-thread" });
    expect(dispatch("turn/started", { threadId: "known-thread" })).toBe(true);
    hook.dispose();
  });

  it("recognizes avatar overlay hrefs", () => {
    expect(isAvatarOverlayHref(overlayHref)).toBe(true);
    expect(isAvatarOverlayHref("app://-/avatar-overlay.html")).toBe(true);
    expect(isAvatarOverlayHref("app://-/index.html")).toBe(false);
  });

  it("blocks leftover overlay from ingesting another Thread's live work", () => {
    expect(overlayBlocksHostNotification("thread/started", "cli-thread", new Set())).toBe(true);
    expect(overlayBlocksHostNotification("turn/started", "cli-thread", new Set())).toBe(true);
    expect(overlayBlocksHostNotification("item/completed", "cli-thread", new Set())).toBe(true);
    expect(
      overlayBlocksHostNotification("thread/realtime/started", "voice-thread", new Set()),
    ).toBe(false);
    expect(
      overlayBlocksHostNotification("item/completed", "voice-thread", new Set(["voice-thread"])),
    ).toBe(false);
  });

  it("reads threadId from notification params", () => {
    expect(notificationThreadId({ threadId: "abc" })).toBe("abc");
    expect(notificationThreadId({ thread: { id: "def" } })).toBe("def");
    expect(notificationThreadId({})).toBeUndefined();
  });

  it("does not install on the primary window", () => {
    const primary = new FakeOverlayWindow({ href: "app://-/index.html" });
    const hook = installOverlayThreadIsolation(primary);
    expect(hook.status).toBe("disabled");
    expect(
      primary.dispatch({
        type: "mcp-notification",
        method: "thread/started",
        params: { thread: { id: "cli" } },
      }),
    ).toBe(false);
  });

  it("stops CLI thread/started on leftover overlay and allows the active realtime Thread", () => {
    const overlay = new FakeOverlayWindow({ href: overlayHref });
    const hook = installOverlayThreadIsolation(overlay);
    expect(hook.status).toBe("active");
    expect(
      overlay.dispatch({
        type: "mcp-notification",
        method: "thread/started",
        params: { thread: { id: "cli-thread" } },
      }),
    ).toBe(true);
    expect(
      overlay.dispatch({
        type: "mcp-notification",
        method: "thread/realtime/started",
        params: { threadId: "voice-thread" },
      }),
    ).toBe(false);
    expect(
      overlay.dispatch({
        type: "mcp-notification",
        method: "item/completed",
        params: { threadId: "voice-thread" },
      }),
    ).toBe(false);
    expect(
      overlay.dispatch({
        type: "mcp-notification",
        method: "item/completed",
        params: { threadId: "cli-thread" },
      }),
    ).toBe(true);
    overlay.dispatch({
      type: "mcp-notification",
      method: "thread/realtime/closed",
      params: { threadId: "voice-thread" },
    });
    expect(
      overlay.dispatch({
        type: "mcp-notification",
        method: "item/completed",
        params: { threadId: "voice-thread" },
      }),
    ).toBe(false);
    hook.dispose();
  });

  it("keeps the overlay open for an in-flight Turn after hangup until it completes", () => {
    const overlay = new FakeOverlayWindow({ href: overlayHref });
    const hook = installOverlayThreadIsolation(overlay);
    overlay.dispatch({
      type: "mcp-notification",
      method: "thread/realtime/started",
      params: { threadId: "voice-thread" },
    });
    overlay.dispatch({
      type: "mcp-notification",
      method: "turn/started",
      params: { threadId: "voice-thread", turn: { id: "turn-3" } },
    });
    overlay.dispatch({
      type: "mcp-notification",
      method: "item/started",
      params: { threadId: "voice-thread", turnId: "turn-3" },
    });
    overlay.dispatch({
      type: "mcp-notification",
      method: "thread/realtime/closed",
      params: { threadId: "voice-thread" },
    });
    expect(
      overlay.dispatch({
        type: "mcp-notification",
        method: "item/completed",
        params: { threadId: "voice-thread", turnId: "turn-3" },
      }),
    ).toBe(false);
    expect(
      overlay.dispatch({
        type: "mcp-notification",
        method: "turn/completed",
        params: { threadId: "voice-thread", turn: { id: "turn-3" } },
      }),
    ).toBe(false);
    expect(
      overlay.dispatch({
        type: "mcp-notification",
        method: "item/completed",
        params: { threadId: "voice-thread", turnId: "turn-3" },
      }),
    ).toBe(false);
    hook.dispose();
  });

  it("delivers final Turn and Item events when idle arrives before completion after hangup", () => {
    const overlay = new FakeOverlayWindow({ href: overlayHref });
    const hook = installOverlayThreadIsolation(overlay);
    const dispatch = (method: string, params: Record<string, unknown>) =>
      overlay.dispatch({ type: "mcp-notification", method, params });
    dispatch("thread/realtime/started", { threadId: "voice-thread" });
    dispatch("turn/started", { threadId: "voice-thread", turn: { id: "native-turn" } });
    dispatch("thread/realtime/closed", { threadId: "voice-thread" });
    dispatch("thread/status/changed", { threadId: "voice-thread", status: { type: "idle" } });

    expect(dispatch("item/completed", { threadId: "voice-thread", turnId: "native-turn" })).toBe(
      false,
    );
    expect(
      dispatch("turn/completed", { threadId: "voice-thread", turn: { id: "native-turn" } }),
    ).toBe(false);
    expect(
      dispatch("turn/started", { threadId: "unrelated-thread", turn: { id: "unrelated-turn" } }),
    ).toBe(true);
    hook.dispose();
  });
});
