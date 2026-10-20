import { describe, expect, it, vi } from "vitest";

import {
  CHAT_LIVE_VOICE_CHANGE_EVENT,
  CHAT_LIVE_VOICE_STORAGE_KEY,
  CPA_LIVE_VOICE_CHANGE_EVENT,
  CPA_LIVE_VOICE_STORAGE_KEY,
  chatLiveVoicePreferenceAllowsOverride,
  cpaLiveVoicePreferenceAllowsInstall,
  readChatLiveVoicePreference,
  readCpaLiveVoicePreference,
  writeChatLiveVoicePreference,
  writeCpaLiveVoicePreference,
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
  it("defaults on, persists off as 0, and allows install when storage is missing", () => {
    const unset = fixture();
    expect(readCpaLiveVoicePreference(unset.owner)).toBe(true);
    expect(cpaLiveVoicePreferenceAllowsInstall({})).toBe(true);
    expect(cpaLiveVoicePreferenceAllowsInstall(unset.owner)).toBe(true);

    const events: string[] = [];
    unset.owner.addEventListener(CPA_LIVE_VOICE_CHANGE_EVENT, () => events.push("changed"));
    expect(writeCpaLiveVoicePreference(unset.owner, false)).toBe(true);
    expect(unset.values.get(CPA_LIVE_VOICE_STORAGE_KEY)).toBe("0");
    expect(readCpaLiveVoicePreference(unset.owner)).toBe(false);
    expect(cpaLiveVoicePreferenceAllowsInstall(unset.owner)).toBe(false);
    expect(events).toEqual(["changed"]);

    expect(writeCpaLiveVoicePreference(unset.owner, true)).toBe(true);
    expect(unset.values.get(CPA_LIVE_VOICE_STORAGE_KEY)).toBe("1");
    expect(readCpaLiveVoicePreference(unset.owner)).toBe(true);
  });

  it("stays on when localStorage throws", () => {
    const owner = throwingOwner();
    expect(readCpaLiveVoicePreference(owner)).toBe(true);
    expect(writeCpaLiveVoicePreference(owner, false)).toBe(false);
    expect(cpaLiveVoicePreferenceAllowsInstall(owner)).toBe(true);
  });
});

describe("Chat live-voice Settings preference", () => {
  it("defaults off and enables only on the exact 1 value", () => {
    const chat = (initial?: string) => fixture(initial, CHAT_LIVE_VOICE_STORAGE_KEY);
    expect(readChatLiveVoicePreference(chat().owner)).toBe(false);
    expect(readChatLiveVoicePreference(chat("0").owner)).toBe(false);
    expect(readChatLiveVoicePreference(chat("true").owner)).toBe(false);
    expect(readChatLiveVoicePreference(chat("1").owner)).toBe(true);
    expect(chatLiveVoicePreferenceAllowsOverride({})).toBe(false);
    expect(chatLiveVoicePreferenceAllowsOverride(chat("1").owner)).toBe(true);
  });

  it("persists the choice under its own key and stays off when storage throws", () => {
    const unset = fixture();
    const events: string[] = [];
    unset.owner.addEventListener(CHAT_LIVE_VOICE_CHANGE_EVENT, () => events.push("changed"));
    expect(writeChatLiveVoicePreference(unset.owner, true)).toBe(true);
    expect(unset.values.get(CHAT_LIVE_VOICE_STORAGE_KEY)).toBe("1");
    expect(readChatLiveVoicePreference(unset.owner)).toBe(true);
    expect(unset.values.has(CPA_LIVE_VOICE_STORAGE_KEY)).toBe(false);
    expect(writeChatLiveVoicePreference(unset.owner, false)).toBe(true);
    expect(unset.values.get(CHAT_LIVE_VOICE_STORAGE_KEY)).toBe("0");
    expect(readChatLiveVoicePreference(unset.owner)).toBe(false);
    expect(events).toEqual(["changed", "changed"]);

    const owner = throwingOwner();
    expect(readChatLiveVoicePreference(owner)).toBe(false);
    expect(writeChatLiveVoicePreference(owner, true)).toBe(false);
    expect(chatLiveVoicePreferenceAllowsOverride(owner)).toBe(false);
  });
});
