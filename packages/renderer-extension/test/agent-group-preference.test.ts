import { describe, expect, it } from "vitest";
import {
  AGENT_GROUP_PREFERENCE_STORAGE_KEY,
  createAgentGroupPreferenceStore,
} from "../src/agent-group-preference.js";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

describe("Agent grouping defaults", () => {
  it("folds only confirmed missing installations without persisting availability", () => {
    const store = createAgentGroupPreferenceStore(null);
    expect(store.list(new Set(["pi"])).find((entry) => entry.agent === "pi")?.section).toBe("more");
    expect(store.sectionOf("pi", true)).toBe("more");
    expect(store.sectionOf("pi", false)).toBe("main");
  });

  it("preserves explicit groups and automatic defaults across reloads and reset", () => {
    const storage = memoryStorage();
    const store = createAgentGroupPreferenceStore(storage);
    store.moveAgent("pi", "main");
    store.moveAgent("grok", "more");
    const restored = createAgentGroupPreferenceStore(storage);
    expect(restored.sectionOf("pi", true)).toBe("main");
    expect(restored.sectionOf("grok", false)).toBe("more");
    expect(restored.sectionOf("omp", true)).toBe("more");
    expect(restored.sectionOf("omp", false)).toBe("main");
    restored.resetToDefault();
    const reset = createAgentGroupPreferenceStore(storage);
    expect(reset.sectionOf("pi", true)).toBe("more");
    expect(reset.sectionOf("grok", false)).toBe("main");
  });

  it("retains previously saved user groups", () => {
    const storage = memoryStorage();
    storage.setItem(
      AGENT_GROUP_PREFERENCE_STORAGE_KEY,
      JSON.stringify([
        { agent: "pi", section: "main" },
        { agent: "grok", section: "more" },
      ]),
    );
    const store = createAgentGroupPreferenceStore(storage);
    expect(store.sectionOf("pi", true)).toBe("main");
    expect(store.sectionOf("grok")).toBe("more");
    expect(store.sectionOf("omp", true)).toBe("more");
  });
});
