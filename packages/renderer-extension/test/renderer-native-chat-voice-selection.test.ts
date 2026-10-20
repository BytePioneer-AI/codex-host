import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeChatVoiceDraftSelection } from "../src/renderer-native-chat-voice-selection.js";
import type { NativeChatVoiceBinding } from "../src/renderer-native-chat-voice.js";

function fixture() {
  const draft = "local-chatgpt:bf2d4b2f-43ee-49df-b802-b55c9fb345d7";
  const backend = "a7e3282d-f457-4586-9b28-921411364f6b";
  const origin = { pathname: "/", key: "home" };
  const state = {
    isVoiceModeActive: true,
    isWorkMode: false,
    conversationId: draft,
    voiceSessionId: "fixture-session",
    hasVoiceSessionStarted: true,
    earlyServerThreadId: backend,
    server: { connectionState: "connected" },
  };
  const initial = {
    FFr: {},
    pZn: {},
    kZn: {},
    SZn: {},
    ejn: () => ({ getState: () => state }),
    uIr: vi.fn(() => true),
  };
  const values = new Map<unknown, unknown>([[initial.FFr, origin]]);
  const binding = {
    props: { conversationId: draft },
    backendConversationId: undefined,
    scope: { get: vi.fn((selector) => values.get(selector)), set: vi.fn() },
  } as unknown as NativeChatVoiceBinding;
  const shared = { xat: vi.fn((id: string) => `/c/${encodeURIComponent(id)}`) };
  const controller = new AbortController();
  const check = () =>
    nativeChatVoiceDraftSelection(binding, initial, shared, origin, controller.signal);
  const adopt = () => {
    values.set(initial.pZn, backend);
    values.set(initial.SZn, "message");
    values.set(initial.kZn, { message: { message: { author: { role: "user" } } } });
  };
  return {
    draft,
    backend,
    origin,
    state,
    initial,
    values,
    binding,
    shared,
    controller,
    check,
    adopt,
  };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "__codexhostChatVoiceDebug");
  vi.restoreAllMocks();
});

describe("native voice-created Chat selection", () => {
  it("waits for native draft adoption and transcript, never an early server ID alone", async () => {
    const f = fixture();
    const select = f.check();
    select();
    expect(f.initial.uIr).not.toHaveBeenCalled();
    f.values.set(f.initial.pZn, f.backend);
    select();
    expect(f.initial.uIr).not.toHaveBeenCalled();
    f.adopt();
    // Native navigation recognizes the voice client draft and resolves its adopted
    // alias. The backend page is not opened before that mapping and transcript exist.
    f.initial.uIr.mockImplementation((_scope?: unknown, path?: unknown) => {
      expect(path).toBe(`/c/${encodeURIComponent(f.draft)}`);
      expect(f.values.get(f.initial.pZn)).toBe(f.backend);
      return true;
    });
    select();
    select();
    expect(f.shared.xat).toHaveBeenCalledExactlyOnceWith(f.draft);
    expect(f.initial.uIr).toHaveBeenCalledOnce();
    expect(f.state.isVoiceModeActive).toBe(true);
    expect(f.binding.scope.set).not.toHaveBeenCalled();
    await Promise.resolve();
    const log = Reflect.get(globalThis, "__codexhostChatVoiceDebug");
    expect(JSON.stringify(log)).not.toContain(f.draft);
    expect(JSON.stringify(log)).not.toContain(f.backend);
    expect(JSON.stringify(log)).not.toContain(f.state.voiceSessionId);
  });

  it("waits for native START initialization, then connection and session startup", () => {
    const f = fixture();
    f.state.isVoiceModeActive = false;
    f.adopt();
    const select = f.check();
    select();
    f.state.voiceSessionId = "new-fixture-session";
    f.state.isVoiceModeActive = true;
    f.state.hasVoiceSessionStarted = false;
    select();
    f.state.hasVoiceSessionStarted = true;
    f.state.server.connectionState = "connecting";
    select();
    expect(f.initial.uIr).not.toHaveBeenCalled();
    f.state.server.connectionState = "connected";
    select();
    expect(f.initial.uIr).toHaveBeenCalledOnce();
  });

  it.each(["navigation", "end", "replace", "work", "conversation", "abort"])(
    "cancels rather than selecting a stale Chat after %s",
    (change) => {
      const f = fixture();
      const select = f.check();
      select();
      if (change === "navigation") f.values.set(f.initial.FFr, { pathname: "/", key: "new-home" });
      if (change === "end") f.state.isVoiceModeActive = false;
      if (change === "replace") f.state.voiceSessionId = "replacement";
      if (change === "work") f.state.isWorkMode = true;
      if (change === "conversation") f.state.conversationId = "another-chat";
      if (change === "abort") f.controller.abort();
      select();
      f.adopt();
      f.values.set(f.initial.FFr, f.origin);
      f.state.isVoiceModeActive = true;
      f.state.isWorkMode = false;
      f.state.conversationId = f.draft;
      f.state.voiceSessionId = "fixture-session";
      select();
      expect(f.initial.uIr).not.toHaveBeenCalled();
    },
  );

  it.each([null, "local-chatgpt:invalid", "thread-id"])(
    "ignores invalid native mapping %s",
    (id) => {
      const f = fixture();
      f.adopt();
      f.values.set(f.initial.pZn, id);
      f.check()();
      expect(f.initial.uIr).not.toHaveBeenCalled();
    },
  );

  it("leaves a saved Chat selected", () => {
    const f = fixture();
    f.binding.backendConversationId = f.backend;
    f.adopt();
    f.check()();
    expect(f.initial.uIr).not.toHaveBeenCalled();
  });

  it("skips selection when optional private exports are unavailable", () => {
    const f = fixture();
    Reflect.deleteProperty(f.initial, "kZn");
    f.check()();
    expect(f.initial.uIr).not.toHaveBeenCalled();
  });

  it.each(["throw", "reject", "decline"])(
    "does not retry or throw into voice on navigation %s",
    async (failure) => {
      const f = fixture();
      vi.spyOn(console, "info").mockImplementation(() => {});
      f.adopt();
      f.initial.uIr.mockImplementation(() => {
        if (failure === "throw") throw new Error("fixture private error");
        if (failure === "reject")
          return Promise.reject(new Error("fixture private error")) as never;
        return false;
      });
      const select = f.check();
      expect(() => select()).not.toThrow();
      await Promise.resolve();
      select();
      expect(f.initial.uIr).toHaveBeenCalledOnce();
      expect(f.state.isVoiceModeActive).toBe(true);
      expect(JSON.stringify(Reflect.get(globalThis, "__codexhostChatVoiceDebug"))).not.toContain(
        "private error",
      );
    },
  );
});
