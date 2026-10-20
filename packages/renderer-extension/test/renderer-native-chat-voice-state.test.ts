import { describe, expect, it, vi } from "vitest";
import { chatVoiceDebug } from "../src/renderer-chat-voice-debug.js";
import { observeNativeChatVoiceState } from "../src/renderer-native-chat-voice-state.js";
import type { ChatVoiceScope } from "../src/renderer-native-chat-voice.js";

vi.mock("../src/renderer-chat-voice-debug.js", () => ({ chatVoiceDebug: vi.fn() }));

describe("native Chat lifecycle diagnostics", () => {
  it("records connection transitions without native payloads and unsubscribes", () => {
    vi.mocked(chatVoiceDebug).mockClear();
    const state = {
      isVoiceModeActive: false,
      hasConnectedOnce: false,
      hasVoiceSessionStarted: false,
      earlyServerThreadId: null as unknown,
      server: { connectionState: "connecting", messages: ["private transcript"] },
      voiceSessionId: "private session ID",
      pendingDisconnect: { error: "private error" },
    };
    const microphone = {};
    const get = vi.fn(() => "pending");
    const scope = { get } as unknown as ChatVoiceScope;
    let listener: (() => void) | undefined;
    const unsubscribe = vi.fn(() => {
      listener = undefined;
    });
    const stop = observeNativeChatVoiceState(scope, {
      sUn: microphone,
      ejn: () => ({
        getState: () => state,
        subscribe: (next: () => void) => {
          listener = next;
          return unsubscribe;
        },
      }),
    });
    listener?.();
    expect(chatVoiceDebug).toHaveBeenCalledTimes(1);
    Object.assign(state, { isVoiceModeActive: true, hasConnectedOnce: true });
    state.server.connectionState = "connected";
    get.mockReturnValue("granted");
    listener?.();
    expect(chatVoiceDebug).toHaveBeenLastCalledWith("native-chat-state", {
      active: true,
      connectedOnce: true,
      sessionStarted: false,
      serverConversationReady: false,
      connection: "connected",
      microphone: "granted",
    });
    state.earlyServerThreadId = "a7e3282d-f457-4586-9b28-921411364f6b";
    listener?.();
    expect(chatVoiceDebug).toHaveBeenLastCalledWith(
      "native-chat-state",
      expect.objectContaining({ serverConversationReady: true }),
    );
    expect(JSON.stringify(vi.mocked(chatVoiceDebug).mock.calls)).not.toContain(
      state.earlyServerThreadId,
    );
    // Unexpected native strings must not enter the persisted diagnostic ring.
    state.server.connectionState = "private transport error";
    get.mockReturnValue("private permission error");
    listener?.();
    expect(chatVoiceDebug).toHaveBeenLastCalledWith(
      "native-chat-state",
      expect.objectContaining({
        connection: "unknown",
        microphone: "unknown",
      }),
    );
    expect(JSON.stringify(vi.mocked(chatVoiceDebug).mock.calls)).not.toContain("private");
    expect(get).toHaveBeenCalledWith(microphone);
    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(listener).toBeUndefined();
  });
});
