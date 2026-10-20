import { afterEach, expect, it, vi } from "vitest";
import { startVoiceSettingsSync } from "../src/voice-settings-sync.js";
import {
  nativeChatVoicePreferenceAllowsStart,
  chatLiveVoicePreferenceAllowsOverride,
} from "../src/renderer-cpa-live-voice-preference.js";

afterEach(() => {
  vi.useRealTimers();
});
function fixture() {
  vi.useFakeTimers();
  const hook = { activeCall: false };
  const owner = {
    document: { querySelectorAll: () => [] },
    setInterval,
    clearInterval,
    localStorage: {
      getItem: (key: string) => (key === "codexhost.cpa-live-voice.v1" ? "0" : null),
    },
    __codexhostNativeChatVoiceV1: hook,
  } as unknown as Window;
  const state = {
    settings: {
      chatExperience: "codex",
      chatConnection: "desktop",
      workConnection: "desktop",
      inject: true,
    },
    initialized: true,
    revision: "shared",
    activeInject: true,
    envOverride: null,
    activeEnvOverride: null,
    routesActive: false,
    activeCall: false,
    gatewayReady: null,
    restartAvailable: true,
    restart: { phase: "idle", error: null },
  };
  return { owner, hook, state };
}

it("applies shared Codex default, acknowledges it on the next poll, and stops on dispose", async () => {
  const { owner, state } = fixture();
  const request = vi.fn(async () => state);
  const stop = startVoiceSettingsSync(owner, request, 100);
  await vi.advanceTimersByTimeAsync(1);
  expect(nativeChatVoicePreferenceAllowsStart(owner)).toBe(false);
  expect(chatLiveVoicePreferenceAllowsOverride(owner)).toBe(false);
  await vi.advanceTimersByTimeAsync(100);
  expect(request).toHaveBeenLastCalledWith(
    "codexhost/voice/settings",
    expect.objectContaining({
      runtime: expect.objectContaining({ revision: "shared", activeCall: false }),
    }),
  );
  stop();
  const count = request.mock.calls.length;
  await vi.advanceTimersByTimeAsync(1000);
  expect(request).toHaveBeenCalledTimes(count);
});

it("migrates existing Desktop choices only when the shared routes are absent", async () => {
  const { owner, state } = fixture();
  state.initialized = false;
  const request = vi.fn(async (_method: string, input: unknown) => {
    if ((input as { operation: string }).operation === "migrate") state.initialized = true;
    return state;
  });
  const stop = startVoiceSettingsSync(owner, request, 100);
  await vi.advanceTimersByTimeAsync(200);
  expect(
    request.mock.calls.filter(
      ([, input]) => (input as { operation: string }).operation === "migrate",
    ),
  ).toEqual([
    [
      "codexhost/voice/settings",
      {
        operation: "migrate",
        routes: { chatExperience: "chatgpt", chatConnection: "desktop", workConnection: "desktop" },
      },
    ],
  ]);
  stop();
});

it("defers route changes during a native voice call", async () => {
  const { owner, hook, state } = fixture();
  hook.activeCall = true;
  const request = vi.fn(async () => state);
  const stop = startVoiceSettingsSync(owner, request, 100);
  await vi.advanceTimersByTimeAsync(100);
  expect(nativeChatVoicePreferenceAllowsStart(owner)).toBe(true);
  expect(request).toHaveBeenLastCalledWith(
    "codexhost/voice/settings",
    expect.objectContaining({
      runtime: expect.objectContaining({ activeCall: true, revision: "" }),
    }),
  );
  hook.activeCall = false;
  await vi.advanceTimersByTimeAsync(100);
  expect(nativeChatVoicePreferenceAllowsStart(owner)).toBe(false);
  stop();
});
