import { afterEach, expect, it, vi } from "vitest";
import { startVoiceSettingsSync } from "../src/voice-settings-sync.js";
import { VOICE_GATEWAY_STATUS_METHOD } from "@codexhost/shared-contracts";
import {
  nativeChatVoicePreferenceAllowsStart,
  chatLiveVoicePreferenceAllowsOverride,
  voiceGatewayIsReady,
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
    gatewayReady: false as boolean | null,
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

it("qualifies gateway capability only from a successful live settings read", async () => {
  const { owner, state } = fixture();
  const request = vi.fn(async () => ({ ...state, gatewayReady: true }));
  const stop = startVoiceSettingsSync(owner, request, 100);
  expect(voiceGatewayIsReady(owner)).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(voiceGatewayIsReady(owner)).toBe(true);
  request.mockRejectedValueOnce(new Error("Host disconnected"));
  await vi.advanceTimersByTimeAsync(100);
  expect(voiceGatewayIsReady(owner)).toBe(true);
  await vi.advanceTimersByTimeAsync(100);
  expect(voiceGatewayIsReady(owner)).toBe(true);
  stop();
  expect(voiceGatewayIsReady(owner)).toBe(false);
});

it("reads readiness directly from Host when runtime settings omit the console callback", async () => {
  const { owner, state } = fixture();
  state.gatewayReady = null;
  let ready = true;
  const request = vi.fn(async (method: string) =>
    method === VOICE_GATEWAY_STATUS_METHOD ? ready : state,
  );
  const stop = startVoiceSettingsSync(owner, request, 100);
  await vi.advanceTimersByTimeAsync(1);
  expect(voiceGatewayIsReady(owner)).toBe(true);
  expect(request).toHaveBeenCalledWith(VOICE_GATEWAY_STATUS_METHOD, {});
  request.mockRejectedValueOnce(new Error("Host reconnecting"));
  await vi.advanceTimersByTimeAsync(100);
  expect(voiceGatewayIsReady(owner)).toBe(true);
  request.mockImplementationOnce(async () => state);
  request.mockRejectedValueOnce(new Error("Gateway status unavailable"));
  await vi.advanceTimersByTimeAsync(100);
  expect(voiceGatewayIsReady(owner)).toBe(true);
  ready = false;
  await vi.advanceTimersByTimeAsync(100);
  expect(voiceGatewayIsReady(owner)).toBe(false);
  stop();
});

it("does not apply a gateway status that arrives after disposal", async () => {
  const { owner, state } = fixture();
  state.gatewayReady = null;
  let resolveStatus!: (value: boolean) => void;
  const request = vi.fn(async (method: string) =>
    method === VOICE_GATEWAY_STATUS_METHOD
      ? new Promise<boolean>((resolve) => {
          resolveStatus = resolve;
        })
      : state,
  );
  const stop = startVoiceSettingsSync(owner, request, 100);
  await vi.advanceTimersByTimeAsync(1);
  stop();
  resolveStatus(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(voiceGatewayIsReady(owner)).toBe(false);
});
