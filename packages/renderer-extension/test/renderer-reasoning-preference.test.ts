import { describe, expect, it } from "vitest";

import {
  RENDERER_REASONING_DISPLAY_PREFERENCE_KEY,
  readRendererReasoningDisplayPreference,
  writeRendererReasoningDisplayPreference,
  type RendererReasoningPreferenceStorage,
} from "../src/renderer-reasoning-preference.js";

function memoryStorage(): RendererReasoningPreferenceStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

describe("Renderer reasoning display preference", () => {
  it("is disabled by default and fails closed for unknown persisted values", () => {
    const storage = memoryStorage();

    expect(readRendererReasoningDisplayPreference(storage)).toBe(false);
    storage.values.set(RENDERER_REASONING_DISPLAY_PREFERENCE_KEY, "enabled-ish");
    expect(readRendererReasoningDisplayPreference(storage)).toBe(false);
  });

  it("round-trips an explicit opt-in and opt-out", () => {
    const storage = memoryStorage();

    writeRendererReasoningDisplayPreference(true, storage);
    expect(readRendererReasoningDisplayPreference(storage)).toBe(true);
    expect(storage.values.get(RENDERER_REASONING_DISPLAY_PREFERENCE_KEY)).toBe("true");

    writeRendererReasoningDisplayPreference(false, storage);
    expect(readRendererReasoningDisplayPreference(storage)).toBe(false);
    expect(storage.values.get(RENDERER_REASONING_DISPLAY_PREFERENCE_KEY)).toBe("false");
  });
});
