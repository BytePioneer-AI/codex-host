import { describe, expect, it, vi } from "vitest";

import {
  CODEX_USAGE_BANNER_CHANGE_EVENT,
  CODEX_USAGE_BANNER_STORAGE_KEY,
  readCodexUsageBannerPreference,
  writeCodexUsageBannerPreference,
} from "../src/renderer-codex-usage-banner-preference.js";

function fixture(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(CODEX_USAGE_BANNER_STORAGE_KEY, initial);
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
  const owner = Object.assign(new EventTarget(), { localStorage: storage }) as unknown as Window;
  return { owner, values };
}

describe("Codex usage banner Settings preference", () => {
  it("defaults on, persists off as 0, and stays on without a Window", () => {
    const unset = fixture();
    expect(readCodexUsageBannerPreference(unset.owner)).toBe(true);
    expect(readCodexUsageBannerPreference(null)).toBe(true);
    expect(readCodexUsageBannerPreference(undefined)).toBe(true);

    const events: string[] = [];
    unset.owner.addEventListener(CODEX_USAGE_BANNER_CHANGE_EVENT, () => events.push("changed"));
    expect(writeCodexUsageBannerPreference(unset.owner, false)).toBe(true);
    expect(unset.values.get(CODEX_USAGE_BANNER_STORAGE_KEY)).toBe("0");
    expect(readCodexUsageBannerPreference(unset.owner)).toBe(false);
    expect(events).toEqual(["changed"]);

    expect(writeCodexUsageBannerPreference(unset.owner, true)).toBe(true);
    expect(unset.values.get(CODEX_USAGE_BANNER_STORAGE_KEY)).toBe("1");
    expect(readCodexUsageBannerPreference(unset.owner)).toBe(true);
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
    expect(readCodexUsageBannerPreference(owner)).toBe(true);
    expect(writeCodexUsageBannerPreference(owner, false)).toBe(false);
  });
});
