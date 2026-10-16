import { describe, expect, it, vi } from "vitest";

import {
  CPA_LIVE_VOICE_CHANGE_EVENT,
  CPA_LIVE_VOICE_STORAGE_KEY,
  cpaLiveVoicePreferenceAllowsInstall,
  readCpaLiveVoicePreference,
  writeCpaLiveVoicePreference,
} from "../src/renderer-cpa-live-voice-preference.js";

function fixture(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(CPA_LIVE_VOICE_STORAGE_KEY, initial);
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
  const owner = Object.assign(new EventTarget(), { localStorage: storage }) as unknown as Window;
  return { owner, values, storage };
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
    const owner = Object.assign(new EventTarget(), {
      localStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
      },
    }) as unknown as Window;
    expect(readCpaLiveVoicePreference(owner)).toBe(true);
    expect(writeCpaLiveVoicePreference(owner, false)).toBe(false);
    expect(cpaLiveVoicePreferenceAllowsInstall(owner)).toBe(true);
  });
});
