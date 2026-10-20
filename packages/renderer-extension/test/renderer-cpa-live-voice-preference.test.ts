import { describe, expect, it, vi } from "vitest";

import {
  CHAT_LIVE_VOICE_STORAGE_KEY,
  CPA_LIVE_VOICE_STORAGE_KEY,
  chatLiveVoicePreferenceAllowsOverride,
  cpaLiveVoicePreferenceAllowsInstall,
  readChatLiveVoicePreference,
  readCpaLiveVoicePreference,
  applySharedVoiceRoutes,
  nativeChatVoicePreferenceAllowsStart,
  legacyVoiceRoutes,
} from "../src/renderer-cpa-live-voice-preference.js";

function fixture(initial?: string, key = CPA_LIVE_VOICE_STORAGE_KEY) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(key, initial);
  const storage = {
    getItem: vi.fn((entry: string) => values.get(entry) ?? null),
    setItem: vi.fn((entry: string, value: string) => {
      values.set(entry, value);
    }),
  };
  const owner = Object.assign(new EventTarget(), { localStorage: storage }) as unknown as Window;
  return { owner, values, storage };
}

function throwingOwner() {
  return Object.assign(new EventTarget(), {
    localStorage: {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    },
  }) as unknown as Window;
}

describe("CPA live-voice Settings preference", () => {
  it("reads the old Work preference for migration and defaults on", () => {
    expect(readCpaLiveVoicePreference(fixture().owner)).toBe(true);
    expect(readCpaLiveVoicePreference(fixture("0").owner)).toBe(false);
    expect(readCpaLiveVoicePreference(fixture("1").owner)).toBe(true);
    expect(cpaLiveVoicePreferenceAllowsInstall({})).toBe(true);
  });

  it("stays on when localStorage throws", () => {
    const owner = throwingOwner();
    expect(readCpaLiveVoicePreference(owner)).toBe(true);
    expect(cpaLiveVoicePreferenceAllowsInstall(owner)).toBe(true);
  });
});

describe("Chat live-voice Settings preference", () => {
  it("distinguishes native ChatGPT, Codex default and gateway without changing Work", () => {
    const { owner } = fixture("0");
    expect(legacyVoiceRoutes(owner).workConnection).toBe("desktop");
    for (const [chatExperience, chatConnection, native, gateway] of [
      ["chatgpt", "gateway", true, false],
      ["codex", "desktop", false, false],
      ["codex", "gateway", false, true],
    ] as const) {
      applySharedVoiceRoutes(owner, { chatExperience, chatConnection, workConnection: "desktop" });
      expect(nativeChatVoicePreferenceAllowsStart(owner)).toBe(native);
      expect(chatLiveVoicePreferenceAllowsOverride(owner)).toBe(gateway);
      expect(cpaLiveVoicePreferenceAllowsInstall(owner)).toBe(false);
    }
  });
  it("restores the last shared route on a fresh renderer document before polling", () => {
    const { owner, storage } = fixture();
    applySharedVoiceRoutes(owner, {
      chatExperience: "codex",
      chatConnection: "desktop",
      workConnection: "desktop",
    });
    const reloaded = { localStorage: storage } as unknown as Window;
    expect(nativeChatVoicePreferenceAllowsStart(reloaded)).toBe(false);
    expect(chatLiveVoicePreferenceAllowsOverride(reloaded)).toBe(false);
    expect(cpaLiveVoicePreferenceAllowsInstall(reloaded)).toBe(false);
  });
  it("defaults off and enables only on the exact 1 value", () => {
    const chat = (initial?: string) => fixture(initial, CHAT_LIVE_VOICE_STORAGE_KEY);
    expect(readChatLiveVoicePreference(chat().owner)).toBe(false);
    expect(readChatLiveVoicePreference(chat("0").owner)).toBe(false);
    expect(readChatLiveVoicePreference(chat("true").owner)).toBe(false);
    expect(readChatLiveVoicePreference(chat("1").owner)).toBe(true);
    expect(chatLiveVoicePreferenceAllowsOverride({})).toBe(false);
    expect(chatLiveVoicePreferenceAllowsOverride(chat("1").owner)).toBe(true);
  });

  it("keeps Chat and Work migration independent and handles unavailable browser storage", () => {
    const owner = fixture("0").owner;
    expect(legacyVoiceRoutes(owner)).toEqual({
      chatExperience: "chatgpt",
      chatConnection: "desktop",
      workConnection: "desktop",
    });
    expect(readChatLiveVoicePreference(throwingOwner())).toBe(false);
    expect(chatLiveVoicePreferenceAllowsOverride(throwingOwner())).toBe(false);
    const blocked = throwingOwner();
    applySharedVoiceRoutes(blocked, {
      chatExperience: "codex",
      chatConnection: "gateway",
      workConnection: "desktop",
    });
    expect(chatLiveVoicePreferenceAllowsOverride(blocked)).toBe(true);
    expect(cpaLiveVoicePreferenceAllowsInstall(blocked)).toBe(false);
  });
});
